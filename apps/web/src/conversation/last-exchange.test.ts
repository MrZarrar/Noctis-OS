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
  it("keeps the cancelled turn's partial reply in Presence and leaves earlier turns out", () => {
    expect(
      lastExchange({
        messages: [message("m-you", "user", "Continue")],
        turns: [
          turn({
            status: "cancelled",
            jobId: "job",
            items: [
              { itemId: "partial", kind: "agent_message", status: "in_progress", text: "Short" },
            ],
          }),
        ],
        streaming: new Map(),
        partialReplies: new Map([
          ["old-job:partial", "Earlier"],
          ["job:partial", "Short, with the rest kept"],
        ]),
      })?.reply,
    ).toBe("Short, with the rest kept");
  });

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

    expect(exchange).toEqual({
      you: "Give me one reason it fails.",
      sent: [],
      reply: "Because panic",
      outputs: [],
    });
  });

  it("uses the stored reply once the turn has one, and says why a turn failed", () => {
    expect(
      lastExchange({
        messages: [message("m-you", "user", "Hi"), message("m-reply", "identity", "Fine.")],
        turns: [turn({ status: "completed", replyMessageId: "m-reply" })],
        streaming: new Map(),
      }),
    ).toEqual({ you: "Hi", sent: [], reply: "Fine.", outputs: [] });
    expect(
      lastExchange({
        messages: [message("m-you", "user", "Hi")],
        turns: [turn({ status: "failed", failureReason: "LM Studio is not running" })],
        streaming: new Map(),
      }),
    ).toEqual({ you: "Hi", sent: [], reply: "Failed: LM Studio is not running", outputs: [] });
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

    expect(exchange).toEqual({ you: "New", sent: [], reply: "", outputs: [] });
  });

  it("carries the files the newest turn made, in order, and skips any it cannot fetch", () => {
    const outputId = "0199a000-0000-7000-8000-000000000001";
    const exchange = lastExchange({
      messages: [message("m-you", "user", "Make me a logo")],
      turns: [
        turn({
          status: "completed",
          items: [
            { itemId: "a1", kind: "agent_message", status: "completed", text: "Done." },
            {
              itemId: "o1",
              kind: "output",
              status: "completed",
              mediaType: "image/png",
              attachmentId: outputId,
              path: "jester.png",
            },
            { itemId: "o2", kind: "output", status: "completed", mediaType: "text/plain" },
          ],
        }),
      ],
      streaming: new Map(),
    });

    expect(exchange?.outputs).toEqual([
      { attachmentId: outputId, mediaType: "image/png", path: "jester.png" },
    ]);
  });

  it("carries the files the owner sent with the newest message", () => {
    const exchange = lastExchange({
      messages: [message("m-you", "user", "What is wrong here?")],
      turns: [
        turn({
          attachments: [
            { attachmentId: "a-1", filename: "screenshot.png", mediaType: "image/png" },
          ],
        }),
      ],
      streaming: new Map(),
    });

    expect(exchange?.sent).toEqual([
      { attachmentId: "a-1", mediaType: "image/png", path: "screenshot.png" },
    ]);
  });
});
