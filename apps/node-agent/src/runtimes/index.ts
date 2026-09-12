import type { RuntimeProviderId } from "@noctis/contracts";

import type { Runtime } from "./Runtime.js";
import { createFakeRuntime } from "./fake.js";

/**
 * Which runtime answers for each provider on this node.
 *
 * `NOCTIS_RUNTIME=fake` puts the scripted runtime behind the `codex` slot for
 * E2E. Otherwise every slot is absent until its adapter lands: codex in Task
 * 1.7b, claude in Task 1.10, hermes in Slice 4. An absent slot refuses the
 * turn; nothing here ever guesses.
 */
export function selectRuntimes(
  env: NodeJS.ProcessEnv,
): Partial<Record<RuntimeProviderId, Runtime>> {
  return env.NOCTIS_RUNTIME === "fake" ? { codex: createFakeRuntime() } : {};
}
