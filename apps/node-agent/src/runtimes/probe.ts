import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeProbe } from "@noctis/contracts";
import { z } from "zod";

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
        })
        .loose(),
    ),
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

  // A claude.ai login is a subscription; claude.ts drives it through the Agent SDK.
  // ponytail: the two aliases the SDK accepts; exact ids come from Settings later.
  return {
    providerId: "claude",
    available: true,
    authMode: "claude_ai",
    models: [
      { providerId: "claude", model: "sonnet", label: "Claude Sonnet" },
      { providerId: "claude", model: "opus", label: "Claude Opus" },
    ],
  };
}

/** One probe per provider, always all three, never a token. */
export async function probeProviders(deps: ProbeDeps): Promise<RuntimeProbe[]> {
  return [
    await probeCodex(deps),
    await probeClaude(deps),
    unavailable("hermes", "local", "slice_4"),
  ];
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
