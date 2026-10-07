import { describe, expect, it } from "vitest";

import { intelligenceState } from "./intelligence-state.js";

describe("the core follows the conversation", () => {
  it("gives approval precedence and stops after completed or failed turns", () => {
    const quiet = { turns: [], streaming: new Map<string, string>(), pendingApprovals: [] };
    const running = { ...quiet, turns: [{ status: "running" as const, items: [] }] };
    const speaking = { ...running, streaming: new Map([["message-1", "Hello"]]) };

    expect(intelligenceState(quiet, false)).toBe("idle");
    expect(intelligenceState(quiet, true)).toBe("listening");
    expect(intelligenceState(running, true)).toBe("thinking");
    expect(intelligenceState(speaking, true)).toBe("speaking");
    expect(intelligenceState({ ...speaking, pendingApprovals: [{}] }, true)).toBe(
      "waiting_for_approval",
    );
    expect(
      intelligenceState({ ...speaking, turns: [{ status: "completed", items: [] }] }, false),
    ).toBe("idle");
    expect(
      intelligenceState({ ...speaking, turns: [{ status: "failed", items: [] }] }, false),
    ).toBe("idle");
    expect(intelligenceState({ ...quiet, turns: [{ status: "queued", items: [] }] }, false)).toBe(
      "thinking",
    );
    expect(intelligenceState({ ...running, streaming: new Map([["message-1", ""]]) }, false)).toBe(
      "thinking",
    );
    expect(
      intelligenceState(
        {
          ...running,
          turns: [
            {
              status: "running",
              items: [
                { itemId: "m1", kind: "agent_message", status: "in_progress", text: "Hello" },
              ],
            },
          ],
        },
        false,
      ),
    ).toBe("speaking");
  });
});
