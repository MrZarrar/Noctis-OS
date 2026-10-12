import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ConversationState, Turn } from "../conversation/useConversation.js";
import { Threads } from "./Threads.js";

const turn: Turn = {
  id: "turn-1",
  threadId: "thread-1",
  identityId: "vesper",
  userMessageId: "message-1",
  jobId: "job-1",
  model: { providerId: "codex", model: "test" },
  status: "running",
  startedAt: "2026-10-07T10:00:01Z",
  items: [
    { itemId: "event-1", kind: "agent_message", status: "completed", text: "raw event" },
    { itemId: "command-1", kind: "command", status: "completed", command: "private raw command" },
    {
      itemId: "image-1",
      kind: "output",
      status: "completed",
      mediaType: "image/png",
      attachmentId: "image-attachment",
      path: "preview.png",
    },
    {
      itemId: "file-1",
      kind: "output",
      status: "completed",
      mediaType: "application/pdf",
      attachmentId: "file-attachment",
      path: "report.pdf",
    },
  ],
};

describe("Threads timeline", () => {
  it("keeps replies, outputs and cancel visible while raw turn events start collapsed", () => {
    const conversation = {
      thread: undefined,
      panelsRevision: 0,
      presencePanelsRevision: 0,
      messages: [
        {
          id: "message-2",
          threadId: "thread-1",
          role: "identity",
          body: "Here is your result",
          createdAt: "2026-10-07T10:00:00Z",
        },
      ],
      turns: [turn],
      streaming: new Map([["stream-1", "Still working"]]),
      pendingApprovals: [],
      models: [],
      defaultModel: undefined,
      roots: [],
      offlineRetry: undefined,
      canAttach: false,
      children: [],
      outputUrl: (id: string) => `/outputs/${id}`,
      error: undefined,
      send: () => Promise.resolve(),
      cancel: () => Promise.resolve(),
      startFresh: () => Promise.resolve(),
      confirm: () => Promise.resolve(),
      decline: () => Promise.resolve(),
      retryElsewhere: () => Promise.resolve(),
    } satisfies ConversationState;

    const markup = renderToStaticMarkup(
      createElement(Threads, { identityId: "vesper", conversation, connected: true }),
    );
    const details = markup.match(/<details[^>]*>[\s\S]*?<\/details>/)?.[0];

    expect(details).toBeDefined();
    expect(details).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(details).toContain("message · completed");
    expect(details).toContain("private raw command");
    expect(details).not.toContain("preview.png");
    expect(details).not.toContain("report.pdf");
    expect(markup).toContain("Here is your result");
    expect(markup).toContain("Still working");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("/outputs/image-attachment");
    expect(markup).toContain("/outputs/file-attachment");
  });
});
