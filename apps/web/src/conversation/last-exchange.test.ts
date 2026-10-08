import { describe, expect, it } from "vitest";

import { lastExchange } from "./last-exchange.js";
import type { Message, Turn } from "./useConversation.js";

const at = "2026-10-09T00:00:00.000Z";
const message = (id: string, role: Message["role"], body: string): Message => ({
  id,
  threadId: "t1",
  role,
  body,
  createdAt: at,
});
const turn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "turn-1",
  threadId: "t1",
  identityId: "jester",
  userMessageId: "m-you",
  model: { providerId: "hermes", model: "qwen/qwen3.5-9b" },
  status: "running",
  items: [],
  startedAt: at,
  ...overrides,
});

describe("lastExchange", () => {
  it("is nothing before anything was said", () => {
    expect(lastExchange({ messages: [], turns: [], streaming: new Map() })).toBeUndefined();
  });

  it("pairs the latest prompt with the reply as it streams in", () => {
    const exchange = lastExchange({
      messages: [message("m-you", "user", "Give me one reason it fails.")],
      turns: [
        turn({
          items: [{ itemId: "a1", kind: "agent_message", status: "in_progress", text: "" }],
        }),
      ],
      streaming: new Map([["a1", "Because panic"]]),
    });

    expect(exchange).toEqual({ you: "Give me one reason it fails.", reply: "Because panic" });
  });

  it("uses the stored reply once the turn has one, and says why a turn failed", () => {
    expect(
      lastExchange({
        messages: [message("m-you", "user", "Hi"), message("m-reply", "identity", "Fine.")],
        turns: [turn({ status: "completed", replyMessageId: "m-reply" })],
        streaming: new Map(),
      }),
    ).toEqual({ you: "Hi", reply: "Fine." });
    expect(
      lastExchange({
        messages: [message("m-you", "user", "Hi")],
        turns: [turn({ status: "failed", failureReason: "LM Studio is not running" })],
        streaming: new Map(),
      }),
    ).toEqual({ you: "Hi", reply: "Failed: LM Studio is not running" });
  });

  it("follows the newest turn, not the first", () => {
    const exchange = lastExchange({
      messages: [message("m-old", "user", "Old"), message("m-you", "user", "New")],
      turns: [
        turn({ id: "old", userMessageId: "m-old", status: "completed" }),
        turn({ id: "new" }),
      ],
      streaming: new Map(),
    });

    expect(exchange).toEqual({ you: "New", reply: "" });
  });
});
