/**
 * The live bridge's hook, run by Claude Code or Codex on this PC at the start
 * and end of a session and around each prompt. It tells the core what it saw
 * and nothing else: it prints nothing (a hook's output can reach the model)
 * and always exits 0, so a core that is down never changes what the agent does.
 */
import { readFileSync } from "node:fs";

import { BridgeProviderSchema } from "@noctis/contracts";

import { bridgeEvent } from "./bridge/event.js";
import { readCredential } from "./credential.js";

async function report(): Promise<void> {
  const provider = BridgeProviderSchema.safeParse(process.argv[2]);
  const event = provider.success
    ? bridgeEvent(provider.data, JSON.parse(readFileSync(0, "utf8")), process.env)
    : undefined;

  if (event === undefined) {
    return;
  }

  const credential = readCredential();

  await fetch(new URL("/node/bridge", credential.coreUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential.nodeId}.${credential.credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(3000),
  });
}

await report().catch(() => undefined);
process.exit(0);
