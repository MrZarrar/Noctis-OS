import { expect, it } from "vitest";
import type { ConversationState } from "../conversation/useConversation.js";
import { companionReply } from "./CompanionColumn.js";

it("announces committed reply lines and a stable thinking status, never deltas", () => {
  const conversation = {
    messages: [{ role: "identity", body: "one\ntwo\nthree\nfour" }],
    turns: [],
  } as unknown as ConversationState;
  expect(companionReply(conversation)).toBe("one\ntwo\nthree");
  const running = {
    ...conversation,
    turns: [{ status: "running", items: [{ kind: "agent_message", text: "partial" }] }],
    streaming: new Map([["partial", "delta"]]),
  } as unknown as ConversationState;
  expect(companionReply(running)).toBe("thinking…");
  expect(companionReply({ messages: [], turns: [] })).toBe("");
});

it("summarizes the current completed or failed turn rather than an older reply", () => {
  const messages = [{ id: "old", role: "identity", body: "An old reply" }];
  expect(
    companionReply({
      messages,
      turns: [
        {
          status: "completed",
          items: [{ kind: "agent_message", text: "New reply\nline two\nline three\nline four" }],
        },
      ],
    } as unknown as ConversationState),
  ).toBe("New reply\nline two\nline three");
  expect(
    companionReply({
      messages,
      turns: [{ status: "failed", failureReason: "Node offline", items: [] }],
    } as unknown as ConversationState),
  ).toBe("Failed: Node offline");
});
