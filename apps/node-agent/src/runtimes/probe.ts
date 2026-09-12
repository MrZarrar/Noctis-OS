import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeProbe } from "@noctis/contracts";
import { z } from "zod";

import { resolveCodexCommand } from "./codex-command.js";
import { childEnvironment } from "./env.js";

export interface ProbeDeps {
  exec(file: string, args: readonly string[]): Promise<{ stdout: string; code: number }>;
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
    login = (await deps.exec(exe, ["login", "status"])).stdout;
    version = (await deps.exec(exe, ["--version"])).stdout.trim().slice(0, 64) || undefined;
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
  let status: z.infer<typeof ClaudeAuthStatusSchema>;

  try {
    status = ClaudeAuthStatusSchema.parse(
      JSON.parse((await deps.exec("claude", ["auth", "status"])).stdout),
    );
  } catch {
    return unavailable("claude", "unknown", "claude_not_found");
  }

  if (status.loggedIn !== true || status.authMethod !== "claude.ai") {
    return unavailable("claude", "unknown", "claude_not_logged_in");
  }

  // Honest about both halves: the login is a subscription, and the adapter
  // that could use it is not built yet.
  return {
    providerId: "claude",
    available: false,
    authMode: "claude_ai",
    reason: "runtime_lands_in_task_1_10",
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
  const childEnv = childEnvironment(env);

  return probeProviders({
    env,
    home: homedir(),
    readFile: (path) => readFile(path, "utf8"),
    exec: (file, args) =>
      new Promise((resolve, reject) => {
        execFile(
          file,
          [...args],
          { env: childEnv, timeout: EXEC_TIMEOUT_MS, windowsHide: true },
          (error, stdout) => {
            // A non-zero exit still has stdout worth reading (`login status` when
            // logged out); only a spawn failure is an error here.
            if (error !== null && typeof error.code !== "number") {
              reject(error instanceof Error ? error : new Error("spawn failed"));
              return;
            }

            resolve({ stdout, code: typeof error?.code === "number" ? error.code : 0 });
          },
        );
      }),
  });
}
