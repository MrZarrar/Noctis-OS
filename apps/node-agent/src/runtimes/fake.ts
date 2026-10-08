import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/**
 * The command the `ASK:` branch asks about.
 *
 * Deliberately one the classifier calls `external_write`, so the turn actually
 * parks on a human. `echo hi` was the obvious choice and the wrong one: `echo`
 * is a read-only head, so the evaluator allowed it outright and the branch
 * proved nothing — which is precisely what the E2E caught. `.invalid` is
 * reserved by IANA and can never resolve, so the fixture cannot reach anything
 * even if something one day really ran it.
 */
export const FAKE_ASK_COMMAND = "curl -X POST https://example.invalid/hook";

/** The PNG signature and nothing else: enough for anything that sniffs the type. */
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class Cancelled extends Error {}

/**
 * A runtime scripted from its prompt, for CI and E2E.
 *
 *   - always: two deltas, then a completed `agent_message` echoing the prompt
 *   - `ASK:`      a command that asks; allow → completed, deny → declined
 *   - `PROPOSE:`  a completed proposal item
 *   - `SLOW:`     200 ms between steps, honouring cancellation
 *   - `IMAGE:`    hands a tiny PNG to the core and records it as an output
 *   - `WRITE:`    writes `notes/written.md` in its folder and reports the change
 *   - `DELEGATE:` asks codex for an `IMAGE:`, then asks again on the same
 *                 child thread, and reports both results as `delegated:<json>`
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
          const command = FAKE_ASK_COMMAND;

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

        if (payload.prompt.includes("IMAGE:")) {
          await step();

          const attachmentId = await sink.upload({
            filename: "frame.png",
            mediaType: "image/png",
            bytes: FAKE_PNG,
          });

          item({
            itemId: "ig1",
            kind: "output",
            status: "completed",
            mediaType: "image/png",
            attachmentId,
          });
        }

        if (payload.prompt.includes("WRITE:")) {
          await step();

          const written = join(roots.cwd, "notes", "written.md");

          await mkdir(dirname(written), { recursive: true });
          await writeFile(written, `# Written by the fake\n\n${payload.prompt}\n`);
          item({ itemId: "f1", kind: "file_change", status: "completed", paths: [written] });
        }

        if (payload.prompt.includes("DELEGATE:")) {
          const brief = payload.prompt.slice(payload.prompt.indexOf("DELEGATE:") + 9).trim();
          const first = await sink.delegate({ runtime: "codex", prompt: `IMAGE: ${brief}` });
          const second = await sink.delegate({
            runtime: "codex",
            prompt: "IMAGE: again, darker",
            ...(first.threadId === undefined ? {} : { threadId: first.threadId }),
          });

          item({
            itemId: "m2",
            kind: "agent_message",
            status: "completed",
            text: `delegated:${JSON.stringify([first, second])}`,
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
