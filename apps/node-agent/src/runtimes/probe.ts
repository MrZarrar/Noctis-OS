import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeProbe } from "@noctis/contracts";
import { z } from "zod";
import { EffortLevelSchema } from "@noctis/contracts";

import { resolveCodexCommand } from "./codex-command.js";
import { childEnvironment } from "./env.js";

export interface ProbeDeps {
  /**
   * `stderr` is carried, not discarded: `codex login status` prints "Logged in
   * using ChatGPT" there and exits 0, so a probe reading stdout alone concludes
   * the owner is logged out and refuses a perfectly good subscription.
   */
  exec(
    file: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string; code: number }>;
  readFile(path: string): Promise<string>;
  readDirectory(path: string): Promise<string[]>;
  env: NodeJS.ProcessEnv;
  home: string;
}

/**
 * OpenAI's cache, not ours, so extra fields are expected rather than refused.
 * Deliberately not `.strict()`: the file gains keys with every CLI release.
 */
const ModelsCacheSchema = z
  .object({
    models: z.array(
      z
        .object({
          slug: z.string().trim().min(1).max(128),
          display_name: z.string().trim().min(1).max(128).optional(),
          visibility: z.string().optional(),
          supported_reasoning_levels: z
            .array(z.object({ effort: EffortLevelSchema }).loose())
            .optional(),
        })
        .loose(),
    ),
  })
  .loose();

/**
 * What the Claude CLI caches in `~/.claude/cache/model-catalog`: the model list
 * it draws its own picker from, refreshed against the server. Theirs, so loose.
 */
const ModelCatalogSchema = z
  .object({
    fetchedAt: z.number().optional(),
    catalog: z
      .object({
        surface: z.string().optional(),
        config: z
          .object({
            models: z.array(
              z
                .object({
                  id: z.string().trim().min(1).max(128),
                  name: z.string().trim().min(1).max(100).optional(),
                  runtime: z
                    .object({ effort_levels: z.array(EffortLevelSchema).optional() })
                    .loose()
                    .optional(),
                })
                .loose(),
            ),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();

/** `claude auth status` prints JSON. Same reasoning: their shape, not ours. */
const ClaudeAuthStatusSchema = z
  .object({ loggedIn: z.boolean().optional(), authMethod: z.string().optional() })
  .loose();

const EXEC_TIMEOUT_MS = 15_000;

function unavailable(
  providerId: RuntimeProbe["providerId"],
  authMode: RuntimeProbe["authMode"],
  reason: string,
): RuntimeProbe {
  return { providerId, available: false, authMode, reason: reason.slice(0, 500), models: [] };
}

async function codexModels(deps: ProbeDeps): Promise<RuntimeProbe["models"]> {
  try {
    const cache = ModelsCacheSchema.parse(
      JSON.parse(await deps.readFile(join(deps.home, ".codex", "models_cache.json"))),
    );

    return cache.models
      .filter((model) => model.visibility !== "hide")
      .slice(0, 64)
      .map((model) => ({
        providerId: "codex" as const,
        model: model.slug,
        ...(model.display_name === undefined ? {} : { label: model.display_name }),
        ...(model.supported_reasoning_levels === undefined
          ? {}
          : { supportedEfforts: model.supported_reasoning_levels.map((level) => level.effort) }),
      }));
  } catch {
    // No cache until the CLI has been run once. An empty list routes nothing
    // here, which is the truth.
    return [];
  }
}

async function probeCodex(deps: ProbeDeps): Promise<RuntimeProbe> {
  const exe = resolveCodexCommand({ env: deps.env, home: deps.home });

  if (exe === undefined) {
    return unavailable("codex", "unknown", "codex_not_found");
  }

  let login: string;
  let version: string | undefined;

  try {
    const status = await deps.exec(exe, ["login", "status"]);
    // Both streams: which one carries the answer is the CLI's business and has
    // already changed once.
    login = `${status.stdout}\n${status.stderr}`;

    const reported = await deps.exec(exe, ["--version"]);
    version = `${reported.stdout}\n${reported.stderr}`.trim().slice(0, 64) || undefined;
  } catch (error) {
    return unavailable(
      "codex",
      "unknown",
      `codex_probe_failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  const models = await codexModels(deps);
  const base = {
    providerId: "codex" as const,
    models,
    ...(version === undefined ? {} : { version }),
  };

  if (/logged in using chatgpt/i.test(login)) {
    return { ...base, available: true, authMode: "chatgpt" };
  }

  if (/api key/i.test(login)) {
    // Found and logged in, and still refused: an API-key login is metered.
    return { ...base, available: false, authMode: "api_key", reason: "api_key_login_is_metered" };
  }

  return { ...base, available: false, authMode: "unknown", reason: "codex_not_logged_in" };
}

/**
 * Until the CLI has written its catalog there is still a subscription to use,
 * and an empty list routes nothing. These are the models of the day; the
 * catalog replaces them the moment it exists.
 */
const CLAUDE_FALLBACK_MODELS: RuntimeProbe["models"] = [
  { providerId: "claude", model: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { providerId: "claude", model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { providerId: "claude", model: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];

/**
 * The models this machine's Claude can actually run, read from the CLI's own
 * catalog rather than a list in here: a new model arrives in Noctis the same
 * day it arrives in the CLI, and a retired one stops being offered. Each entry
 * carries its full id and version ("Claude Opus 5.5"), so a turn's record says
 * which model ran rather than which alias was asked for.
 *
 * Every model the catalog lists is offered. `min_claude_code_version` is there
 * too and is deliberately ignored: this machine's 2.1.223 runs Opus 5.5, whose
 * floor reads 2.1.280, so filtering on it hides models that work.
 */
async function claudeModels(deps: ProbeDeps): Promise<RuntimeProbe["models"]> {
  const directory = join(deps.home, ".claude", "cache", "model-catalog");
  let newest: z.infer<typeof ModelCatalogSchema> | undefined;

  try {
    for (const entry of await deps.readDirectory(directory)) {
      if (!entry.endsWith(".json")) {
        continue;
      }

      try {
        const held = ModelCatalogSchema.parse(
          JSON.parse(await deps.readFile(join(directory, entry))),
        );

        // One file per account and surface; `cc` is the one the Agent SDK drives.
        if (held.catalog.surface === "cc" && (held.fetchedAt ?? 0) > (newest?.fetchedAt ?? -1)) {
          newest = held;
        }
      } catch {
        // A half-written file is not the answer for the ones beside it.
      }
    }
  } catch {
    // No cache directory until the CLI has run once here.
  }

  const models = (newest?.catalog.config.models ?? []).slice(0, 64).map((model) => ({
    providerId: "claude" as const,
    model: model.id,
    ...(model.name === undefined ? {} : { label: `Claude ${model.name}` }),
    ...(model.runtime?.effort_levels === undefined
      ? {}
      : { supportedEfforts: model.runtime.effort_levels }),
  }));

  return models.length === 0 ? CLAUDE_FALLBACK_MODELS : models;
}

async function probeClaude(deps: ProbeDeps): Promise<RuntimeProbe> {
  let printed: string;

  try {
    const result = await deps.exec("claude", ["auth", "status"]);

    printed = result.stdout;
  } catch {
    return unavailable("claude", "unknown", "claude_not_found");
  }

  let status: z.infer<typeof ClaudeAuthStatusSchema>;

  try {
    status = ClaudeAuthStatusSchema.parse(JSON.parse(printed));
  } catch {
    // It ran and said something this does not understand. Not the same fact as
    // "not installed", and reporting it as such sent the last diagnosis astray.
    return unavailable("claude", "unknown", "claude_auth_status_unreadable");
  }

  if (status.loggedIn !== true || status.authMethod !== "claude.ai") {
    return unavailable("claude", "unknown", "claude_not_logged_in");
  }

  // Carried for the same reason as Codex's: which build answered, on the record.
  let version: string | undefined;

  try {
    const reported = await deps.exec("claude", ["--version"]);

    version =
      `${reported.stdout}
${reported.stderr}`
        .trim()
        .slice(0, 64) || undefined;
  } catch {
    // It answered `auth status` a moment ago, so this is a detail, not a verdict.
  }

  // A claude.ai login is a subscription; claude.ts drives it through the Agent SDK.
  return {
    providerId: "claude",
    available: true,
    authMode: "claude_ai",
    models: await claudeModels(deps),
    ...(version === undefined ? {} : { version }),
  };
}

/**
 * The two CLIs, probed here, never a token. Hermes and the local model server
 * answer for themselves (`runtimes/index.ts`): what they offer is theirs to say.
 */
export async function probeProviders(deps: ProbeDeps): Promise<RuntimeProbe[]> {
  return [await probeCodex(deps), await probeClaude(deps)];
}

/** The real thing, for `main.ts`: spawned children see the stripped environment only. */
export function probeInstalledProviders(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeProbe[]> {
  return probeProviders(installedDeps(env));
}

/** The codex runtime's own probe: this machine, one provider. */
export function probeCodexInstalled(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeProbe> {
  return probeCodex(installedDeps(env));
}

/** The claude runtime's own probe: `claude auth status` on PATH, never a token. */
export function probeClaudeInstalled(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeProbe> {
  return probeClaude(installedDeps(env));
}

/**
 * How to spawn a command named on PATH rather than by full path.
 *
 * On Windows an npm-installed CLI is an extensionless shell script plus a
 * `.cmd` wrapper. Node can spawn neither: the first is not a PE image, and
 * `.cmd` is refused without `shell: true` (CVE-2024-27980). So a bare name goes
 * through `cmd.exe /c`, which does the PATHEXT resolution Windows itself would.
 * Arguments stay a real argv array and every caller here passes literals, so
 * there is no string a command line could be smuggled into.
 *
 * A file with a separator in it is already a path and is spawned as given.
 */
function spawnable(file: string, args: readonly string[]): { file: string; args: string[] } {
  const isBareName = !file.includes("\\") && !file.includes("/");

  return process.platform === "win32" && isBareName
    ? { file: "cmd.exe", args: ["/c", file, ...args] }
    : { file, args: [...args] };
}

function installedDeps(env: NodeJS.ProcessEnv): ProbeDeps {
  const childEnv = childEnvironment(env);

  return {
    env,
    home: homedir(),
    readFile: (path) => readFile(path, "utf8"),
    readDirectory: (path) => readdir(path),
    exec: (file, args) =>
      new Promise((resolve, reject) => {
        const spawn = spawnable(file, args);

        execFile(
          spawn.file,
          spawn.args,
          { env: childEnv, timeout: EXEC_TIMEOUT_MS, windowsHide: true },
          (error, stdout, stderr) => {
            // A non-zero exit still has stdout worth reading (`login status` when
            // logged out); only a spawn failure is an error here.
            if (error !== null && typeof error.code !== "number") {
              reject(error instanceof Error ? error : new Error("spawn failed"));
              return;
            }

            resolve({ stdout, stderr, code: typeof error?.code === "number" ? error.code : 0 });
          },
        );
      }),
  };
}
