import type { ConversationThread } from "@noctis/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Turn } from "../conversation/useConversation.js";
import { AgentMap } from "./AgentMap.js";

const turn: Turn = {
  id: "turn",
  threadId: "thread",
  identityId: "vesper",
  userMessageId: "message",
  model: { providerId: "codex", model: "newest-model" },
  status: "running",
  startedAt: "2026-10-16T14:00:00Z",
  items: [
    {
      itemId: "agent",
      kind: "sub_agent",
      status: "completed",
      label: "Explorer",
      task: "Find the cause",
      report: "**Found** the cause",
      durationMs: 150_000,
      tokens: 82_300,
      toolUses: 12,
    },
    {
      itemId: "step",
      kind: "command",
      status: "completed",
      parentItemId: "agent",
      command: "npm test",
      output: "Step output",
    },
    { itemId: "other", kind: "command", status: "completed", command: "unrelated main step" },
    {
      itemId: "live",
      kind: "sub_agent",
      status: "in_progress",
      label: "Reviewer",
      activity: "Reading changes",
    },
    { itemId: "failed", kind: "sub_agent", status: "failed", label: "Failed worker" },
  ],
};

describe("agent map", () => {
  it("keeps the main agent available even before any turns exist", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentMap, { identityId: "vesper", turns: [], children: [], now: 0 }),
    );
    expect(markup).toContain("Agents · 1");
    expect(markup).toContain("Vesper");
    expect(markup).toContain("Idle");
    expect(markup).toContain('aria-label="Agent map"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain("Close agent map");
  });

  it("shows main work, unique sub-agents, metrics, task, steps and Markdown reports", () => {
    const old: Turn = {
      ...turn,
      id: "old",
      startedAt: "2026-10-15T14:00:00Z",
      model: { providerId: "codex", model: "old-model" },
      items: [{ itemId: "agent", kind: "sub_agent", status: "in_progress", label: "Old label" }],
    };
    const markup = renderToStaticMarkup(
      createElement(AgentMap, {
        identityId: "vesper",
        turns: [turn, old],
        children: [],
        now: Date.parse("2026-10-16T14:02:10Z"),
      }),
    );
    expect(markup).toContain("Agents · 4");
    expect(markup).toContain("newest-model");
    expect(markup).not.toContain("old-model");
    expect(markup).not.toContain("Old label");
    expect(markup).toContain("Working · 2m 10s");
    expect(markup).toContain("Reading changes");
    expect(markup).toContain("2m 30s · 82.3k tokens · 12 tool uses");
    const agentDetails =
      markup.match(/<details[^>]*data-agent="agent"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(agentDetails).toContain("Find the cause");
    expect(agentDetails).toContain("npm test");
    expect(agentDetails).toContain("Step output");
    expect(markup).toContain("<strong>Found</strong>");
    expect(agentDetails).not.toContain("unrelated main step");
    expect(markup).toContain('data-agent-status="failed"');
    expect(markup.indexOf('data-agent="live"')).toBeLessThan(markup.indexOf('data-agent="failed"'));
    expect(markup.indexOf('data-agent="failed"')).toBeLessThan(
      markup.indexOf('data-agent="agent"'),
    );
  });

  it("includes delegated threads as keyboard reachable open buttons", () => {
    const child: ConversationThread = {
      id: "child",
      identityId: "jester",
      kind: "free",
      parentThreadId: "thread",
      title: "Investigate logs",
      revision: 1,
      createdAt: turn.startedAt,
      updatedAt: turn.startedAt,
    };
    const markup = renderToStaticMarkup(
      createElement(AgentMap, {
        identityId: "vesper",
        turns: [],
        children: [
          child,
          {
            ...child,
            id: "new-child",
            title: "Newest delegation",
            createdAt: "2026-10-17T14:00:00Z",
          },
        ],
        now: 0,
        onOpenThread: () => undefined,
      }),
    );
    expect(markup).toContain("Agents · 3");
    expect(markup).toContain("Investigate logs");
    expect(markup).toContain('data-thread="child"');
    expect(markup).toContain("Open thread");
    expect(markup.indexOf('data-thread="new-child"')).toBeLessThan(
      markup.indexOf('data-thread="child"'),
    );
  });
});
