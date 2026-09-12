import { setTimeout as sleep } from "node:timers/promises";

import type { RuntimeProbe, RuntimeTurnEvidence } from "@noctis/contracts";
import { classifyAsk } from "@noctis/domain";

import type { Runtime, RuntimeSink, RuntimeTurnInput } from "./Runtime.js";

export const FAKE_PROBE: RuntimeProbe = {
  providerId: "codex",
  available: true,
  authMode: "chatgpt",
  version: "fake",
  models: [{ providerId: "codex", model: "fake-model", label: "Fake" }],
};

const SLOW_STEP_MS = 200;

class Cancelled extends Error {}

/**
 * A runtime scripted from its prompt, for CI and E2E.
 *
 *   - always: two deltas, then a completed `agent_message` echoing the prompt
 *   - `ASK:`      a command that asks; allow → completed, deny → declined
 *   - `PROPOSE:`  a completed proposal item
 *   - `SLOW:`     200 ms between steps, honouring cancellation
 */
export function createFakeRuntime(): Runtime {
  return {
    providerId: "codex",
    probe: () => Promise.resolve(FAKE_PROBE),
    async turn(input: RuntimeTurnInput, sink: RuntimeSink): Promise<RuntimeTurnEvidence> {
      const { payload, roots, signal } = input;
      const slow = payload.prompt.includes("SLOW:");
      let itemCount = 0;

      const step = async (): Promise<void> => {
        if (slow) {
          await sleep(SLOW_STEP_MS, undefined, { signal }).catch(() => undefined);
        }

        if (signal.aborted) {
          throw new Cancelled();
        }
      };

      const item = (value: Parameters<RuntimeSink["item"]>[0]): void => {
        itemCount += 1;
        sink.item(value);
      };

      const finalText = `Hello ${payload.prompt}`;

      const evidence = (
        stoppedReason: RuntimeTurnEvidence["stoppedReason"],
      ): RuntimeTurnEvidence => ({
        model: payload.model,
        sessionRef: payload.sessionRef ?? "fake-session-1",
        itemCount,
        finalText,
        stoppedReason,
      });

      try {
        await step();
        sink.delta("m1", "Hel");
        await step();
        sink.delta("m1", "lo");
        await step();
        item({ itemId: "m1", kind: "agent_message", status: "completed", text: finalText });

        if (payload.prompt.includes("ASK:")) {
          const command = "echo hi";

          item({ itemId: "c1", kind: "command", status: "in_progress", command, cwd: roots.cwd });

          const cls = classifyAsk({
            kind: "command",
            command,
            cwd: roots.cwd,
            writableRoots: roots.writable,
            readableRoots: roots.readable,
          });
          const answer = await sink.ask({
            itemId: "c1",
            kind: "command",
            summary: `run ${command}`,
            operationClass: cls.operationClass,
            reversibility: cls.reversibility,
            capability: cls.capability,
            target: { type: "command", id: command },
            detail: { command, cwd: roots.cwd },
          });

          await step();

          if (answer.decision === "deny") {
            item({ itemId: "c1", kind: "command", status: "declined", command, cwd: roots.cwd });
            return evidence("declined");
          }

          item({
            itemId: "c1",
            kind: "command",
            status: "completed",
            command,
            cwd: roots.cwd,
            output: "hi",
            exitCode: 0,
          });
        }

        if (payload.prompt.includes("PROPOSE:")) {
          await step();
          item({
            itemId: "p1",
            kind: "proposal",
            status: "completed",
            proposal: { kind: "objective", title: "Suggested", intent: payload.prompt },
          });
        }

        return evidence("completed");
      } catch (error) {
        if (error instanceof Cancelled) {
          return evidence("cancelled");
        }

        throw error;
      }
    },
  };
}
