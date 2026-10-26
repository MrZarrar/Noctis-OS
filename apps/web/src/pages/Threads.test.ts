import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ConversationState, Turn } from "../conversation/useConversation.js";
import { ItemRow, Threads } from "./Threads.js";
import { Presence } from "./Presence.js";

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

function conversationWith(turns: Turn[]): ConversationState {
  return {
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
    turns,
    streaming: new Map([["stream-1", "Still working"]]),
    partialReplies: new Map(),
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
    startFreshIfIdle: () => Promise.resolve(),
    confirm: () => Promise.resolve(),
    decline: () => Promise.resolve(),
    retryElsewhere: () => Promise.resolve(),
  };
}

describe("Threads timeline", () => {
  it("also offers Stop in Presence while a turn is active", () => {
    const markup = renderToStaticMarkup(
      createElement(Presence, {
        identity: {
          activeIdentityId: "vesper",
          activeObjectiveId: undefined,
          protocolIds: [],
          activate: () => Promise.resolve(),
          setActiveObjectiveId: () => undefined,
          toggleNoir: () => undefined,
          error: undefined,
          awakeUntil: {},
          wake: () => Promise.resolve(),
        },
        transport: undefined,
        conversation: conversationWith([turn]),
        listening: false,
        onSend: () => undefined,
      }),
    );
    expect(markup).toContain(">Stop<");
  });

  it("keeps a stopped partial reply without announcing that the agent is typing", () => {
    const conversation = conversationWith([{ ...turn, status: "cancelled" }]);
    conversation.streaming = new Map();
    conversation.partialReplies = new Map([["job-1:stream-1", "Still working"]]);
    const markup = renderToStaticMarkup(
      createElement(Threads, {
        identityId: "vesper",
        conversation,
        connected: true,
      }),
    );
    expect(markup).toContain("Still working");
    expect(markup).not.toContain("(typing)");
    expect(markup).toContain("(partial reply)");
  });

  it("keeps an interrupted reply before a later exchange", () => {
    const conversation = conversationWith([
      { ...turn, status: "cancelled", completedAt: "2026-10-07T10:01:00Z" },
    ]);
    conversation.streaming = new Map();
    conversation.partialReplies = new Map([["job-1:stream-1", "Interrupted reply"]]);
    conversation.messages = [
      ...conversation.messages,
      {
        id: "later",
        threadId: "thread-1",
        role: "user",
        body: "After stop",
        createdAt: "2026-10-07T10:02:00Z",
      },
    ];
    const markup = renderToStaticMarkup(
      createElement(Threads, { identityId: "vesper", conversation, connected: true }),
    );
    expect(markup.indexOf("Interrupted reply")).toBeLessThan(markup.indexOf("After stop"));
  });

  it("offers Stop in the composer for a running or queued job, and removes it when settled", () => {
    for (const status of ["running", "queued", "completed", "failed", "cancelled"] as const) {
      const markup = renderToStaticMarkup(
        createElement(Threads, {
          identityId: "vesper",
          conversation: conversationWith([{ ...turn, status }]),
          connected: true,
        }),
      );
      const composer = markup.slice(markup.indexOf("data-panel-composer"));

      expect(composer.includes(">Stop<")).toBe(status === "running" || status === "queued");
    }
  });

  it("shows semantic message times, live activity and an agent map action", () => {
    const markup = renderToStaticMarkup(
      createElement(Threads, {
        identityId: "vesper",
        conversation: conversationWith([turn]),
        connected: true,
      }),
    );
    expect(markup).toContain('<time dateTime="2026-10-07T10:00:00Z"');
    expect(markup).toMatch(/<time[^>]*title="[^"]+"/);
    expect(markup).toContain("Working · ");
    expect(markup).toContain("ran private raw command");
    expect(markup).toContain("Agents · 1");
  });

  it("shows completed turn duration outside Details", () => {
    const done: Turn = { ...turn, status: "completed", completedAt: "2026-10-07T10:07:31Z" };
    const markup = renderToStaticMarkup(
      createElement(Threads, {
        identityId: "vesper",
        conversation: conversationWith([done]),
        connected: true,
      }),
    );
    expect(markup.replace(/<details[^>]*>[\s\S]*?<\/details>/g, "")).toContain("Worked 7m 30s");
  });

  it("places a local timestamp beside each message role with a full hover date", () => {
    const markup = renderToStaticMarkup(
      createElement(Threads, {
        identityId: "vesper",
        conversation: conversationWith([]),
        connected: true,
      }),
    );
    expect(markup).toMatch(
      /Vesper[\s\S]*?<time dateTime="2026-10-07T10:00:00Z" title="[^"]+2026[^"]*"/,
    );
    expect(markup).toContain("Agents · 1");
  });

  it("shows current activity outside Details and the finished turn's fixed duration", () => {
    const running: Turn = {
      ...turn,
      items: [{ itemId: "cmd", kind: "command", status: "in_progress", command: "npm test" }],
    };
    const completed: Turn = {
      ...turn,
      id: "turn-2",
      status: "completed",
      completedAt: "2026-10-07T10:07:31Z",
    };
    const markup = renderToStaticMarkup(
      createElement(Threads, {
        identityId: "vesper",
        conversation: conversationWith([running, completed]),
        connected: true,
      }),
    );
    const outside = markup.replace(/<details[^>]*>[\s\S]*?<\/details>/g, "");
    expect(outside).toContain("Working · ");
    expect(outside).toContain("running npm test");
    expect(outside).toContain("Worked 7m 30s");
  });

  it("keeps replies, outputs and cancel visible while raw turn events start collapsed", () => {
    const conversation = conversationWith([turn]);

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
    expect(markup).toContain("Stop");
    expect(markup).toContain("/outputs/image-attachment");
    expect(markup).toContain("/outputs/file-attachment");
  });

  it("asks the agent's questions in the thread, outside the collapsed details", () => {
    const asking: Turn = {
      ...turn,
      status: "completed",
      items: [
        {
          itemId: "tu-1",
          kind: "tool_call",
          status: "declined",
          tool: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Which repos should I cover?",
                options: [{ label: "Public portfolio" }, { label: "Everything" }],
              },
            ],
          },
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(Threads, {
        identityId: "vesper",
        conversation: conversationWith([asking]),
        connected: true,
      }),
    );
    const outside = markup.replace(/<details[^>]*>[\s\S]*?<\/details>/g, "");

    expect(outside).toContain("Which repos should I cover?");
    expect(outside).toContain("Public portfolio");
  });

  it("shows each sub-agent and what it is doing without opening the details", () => {
    const delegating: Turn = {
      ...turn,
      items: [
        {
          itemId: "a1",
          kind: "sub_agent",
          status: "in_progress",
          label: "explore LVL Unbound",
          activity: "Reading the diary",
        },
        { itemId: "a2", kind: "sub_agent", status: "completed", label: "explore glycolens" },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(Threads, {
        identityId: "vesper",
        conversation: conversationWith([delegating]),
        connected: true,
      }),
    );
    const outside = markup.replace(/<details[^>]*>[\s\S]*?<\/details>/g, "");

    expect(outside).toContain("explore LVL Unbound");
    expect(outside).toContain("Reading the diary");
    expect(outside).toContain("explore glycolens");
  });

  it("opens on the conversation list when the Threads tab asks for it", () => {
    const transport = {
      request: () => new Promise<never>(() => undefined),
      subscribe: () => new Promise<never>(() => undefined),
    };
    const render = (openList: boolean): string =>
      renderToStaticMarkup(
        createElement(Threads, {
          identityId: "vesper",
          conversation: conversationWith([]),
          connected: true,
          transport,
          onOpenThread: () => undefined,
          openList,
        }),
      );

    expect(render(true)).toContain("Continue a session");
    expect(render(true)).not.toContain("Here is your result");
    expect(render(false)).not.toContain("Continue a session");
  });
});

describe("a message sent with files", () => {
  it("shows a sent screenshot under the owner's message", () => {
    const conversation = conversationWith([
      {
        ...turn,
        userMessageId: "message-you",
        attachments: [
          { attachmentId: "shot-1", filename: "screenshot.png", mediaType: "image/png" },
        ],
      },
    ]);
    conversation.messages = [
      {
        id: "message-you",
        threadId: "thread-1",
        role: "user",
        body: "What is wrong here?",
        createdAt: "2026-10-07T10:00:00Z",
      },
    ];
    const markup = renderToStaticMarkup(
      createElement(Threads, { identityId: "vesper", conversation, connected: true }),
    );
    const mine = markup.match(/<li[^>]*data-role="user"[\s\S]*?<\/li>/)?.[0];

    expect(mine).toContain("What is wrong here?");
    expect(mine).toContain('src="/outputs/shot-1"');
    expect(mine).toContain('alt="screenshot.png"');
  });
});

describe("a command row", () => {
  it("reads as what the agent said it does, with the command and its output folded away", () => {
    const markup = renderToStaticMarkup(
      createElement(ItemRow, {
        item: {
          itemId: "c1",
          kind: "command",
          status: "completed",
          command: `python -c "print('x')"`,
          description: "Print the fixture keys",
          output: "vesper keys: options",
          exitCode: 0,
        },
      }),
    );
    const visible = markup.split("<details")[0];
    const folded = markup.match(/<details[^>]*>[\s\S]*<\/details>/)?.[0];

    expect(visible).toContain("Print the fixture keys");
    expect(visible).not.toContain("python");
    expect(folded).toContain("python -c");
    expect(folded).toContain("vesper keys: options");
  });

  it("says it ran a command when the agent gave no words for it", () => {
    const markup = renderToStaticMarkup(
      createElement(ItemRow, {
        item: { itemId: "c2", kind: "command", status: "completed", command: "git status" },
      }),
    );

    expect(markup.split("<details")[0]).not.toContain("git status");
    expect(markup).toContain("git status");
  });
});
