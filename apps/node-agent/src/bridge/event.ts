import type { BridgeEvent, BridgeProviderId } from "@noctis/contracts";
import { BridgeEventSchema } from "@noctis/contracts";
import { z } from "zod";

import { NOCTIS_SESSION_MARKER } from "../runtimes/env.js";

const KINDS: Readonly<Record<string, BridgeEvent["kind"]>> = {
  SessionStart: "start",
  UserPromptSubmit: "prompt",
  Stop: "reply",
  SessionEnd: "end",
};

/** Claude Code's and Codex's hook input share these names. Only what the bridge reads. */
const HookInputSchema = z
  .object({
    hook_event_name: z.string(),
    session_id: z.string(),
    cwd: z.string(),
    prompt: z.string().optional(),
    last_assistant_message: z.string().optional(),
  })
  .loose();

/**
 * What one hook firing means to Noctis, or undefined when it should say
 * nothing: a session Noctis itself runs, a hook the bridge does not listen to,
 * or input it cannot read.
 */
export function bridgeEvent(
  providerId: BridgeProviderId,
  payload: unknown,
  env: NodeJS.ProcessEnv,
): BridgeEvent | undefined {
  const input = HookInputSchema.safeParse(payload);

  if (env[NOCTIS_SESSION_MARKER] === "1" || !input.success) {
    return undefined;
  }

  const kind = KINDS[input.data.hook_event_name];
  const text =
    kind === "prompt"
      ? input.data.prompt
      : kind === "reply"
        ? input.data.last_assistant_message
        : undefined;
  const event = BridgeEventSchema.safeParse({
    providerId,
    kind,
    sessionRef: input.data.session_id,
    cwd: input.data.cwd,
    ...(text === undefined ? {} : { text: text.slice(0, 20_000) }),
  });

  return event.success ? event.data : undefined;
}
