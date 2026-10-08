import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeProbe, RuntimeProviderId } from "@noctis/contracts";

import type { Runtime } from "./Runtime.js";
import { resolveCodexCommand } from "./codex-command.js";
import { createClaudeRuntime } from "./claude.js";
import { createCodexRuntime } from "./codex.js";
import { createFakeRuntime } from "./fake.js";
import { createLocalRuntime } from "./local.js";
import { probeInstalledProviders } from "./probe.js";

/**
 * What `hello` reports. The fake runtime is not installed anywhere, so under
 * `NOCTIS_RUNTIME=fake` the selected runtimes probe themselves; otherwise the
 * machine is probed as it is.
 */
export function selectProbes(
  env: NodeJS.ProcessEnv,
  runtimes: Partial<Record<RuntimeProviderId, Runtime>>,
): () => Promise<RuntimeProbe[]> {
  return env.NOCTIS_RUNTIME === "fake"
    ? () => Promise.all(Object.values(runtimes).map((runtime) => runtime.probe()))
    : async () => [
        ...(await probeInstalledProviders(env)),
        // The model server answers for itself: which models it has is its to say.
        ...(runtimes.local === undefined ? [] : [await runtimes.local.probe()]),
      ];
}

/**
 * Which runtime answers for each provider on this node.
 *
 * `NOCTIS_RUNTIME=fake` puts the scripted runtime behind the `codex` slot for
 * E2E. Otherwise codex is wired only when a `codex.exe` is actually on this
 * machine; claude is always wired, because the Agent SDK ships its own CLI and
 * its probe says whether the login is usable; local is always wired too, and
 * its probe says whether a model server is running (`NOCTIS_LOCAL_MODEL_URL`,
 * else LM Studio's). An absent slot refuses the turn; nothing here ever guesses.
 */
export function selectRuntimes(
  env: NodeJS.ProcessEnv,
): Partial<Record<RuntimeProviderId, Runtime>> {
  if (env.NOCTIS_RUNTIME === "fake") {
    return { codex: createFakeRuntime() };
  }

  const command = resolveCodexCommand({ env });
  const home = env.NOCTIS_NODE_HOME?.trim();
  const nodeHome = home === undefined || home === "" ? join(tmpdir(), "noctis") : home;

  return {
    claude: createClaudeRuntime({ env }),
    local: createLocalRuntime({
      baseUrl: env.NOCTIS_LOCAL_MODEL_URL,
      sessionsDir: join(nodeHome, "local-sessions"),
    }),
    ...(command === undefined
      ? {}
      : {
          codex: createCodexRuntime({
            command,
            env,
            proposalsDir: join(nodeHome, "proposals"),
          }),
        }),
  };
}
