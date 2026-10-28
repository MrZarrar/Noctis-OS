import type { RuntimeItem } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import type { Turn } from "../conversation/useConversation.js";
import {
  agentsOf,
  agentStepsOf,
  formatDuration,
  messageTime,
  newestTurn,
  turnActivity,
  turnDuration,
} from "./turn-activity.js";

const now = Date.parse("2026-10-16T13:35:00Z");
const turn: Turn = {
  id: "turn-1",
  threadId: "thread-1",
  identityId: "vesper",
  userMessageId: "message-1",
  model: { providerId: "codex", model: "test" },
  status: "running",
  startedAt: "2026-10-16T13:32:50Z",
  items: [],
};

describe("message times", () => {
  it("uses local clock time today and a full date on hover", () => {
    const time = messageTime("2026-10-16T13:32:00Z", now, "Europe/London");
    expect(time.label).toBe("14:32");
    expect(time.title).toContain("16 October 2026");
    expect(time.title).toContain("14:32:00");
  });

  it("uses calendar yesterday, including a daylight-saving day", () => {
    expect(messageTime("2026-10-15T13:32:00Z", now, "Europe/London").label).toBe("Yesterday 14:32");
    expect(
      messageTime("2026-10-25T00:30:00Z", Date.parse("2026-10-26T00:15:00Z"), "Europe/London")
        .label,
    ).toBe("Yesterday 01:30");
  });

  it("shows day and month for older dates and respects another zone across midnight", () => {
    expect(messageTime("2026-10-14T13:32:00Z", now, "Europe/London").label).toBe("14 Oct 14:32");
    expect(
      messageTime("2026-10-16T03:32:00Z", Date.parse("2026-10-16T07:00:00Z"), "America/Los_Angeles")
        .label,
    ).toBe("Yesterday 20:32");
  });
});

describe("turn duration", () => {
  it("formats seconds, minutes and hours without dropping seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(450_000)).toBe("7m 30s");
    expect(formatDuration(3_662_000)).toBe("1h 1m 2s");
    expect(formatDuration(-1000)).toBe("0s");
  });

  it("counts a live turn and freezes a finished, failed or cancelled turn at completion", () => {
    expect(turnDuration(turn, now)).toBe("2m 10s");
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(
        turnDuration({ ...turn, status, completedAt: "2026-10-16T13:40:20Z" }, now + 86_400_000),
      ).toBe("7m 30s");
    }
    expect(turnDuration({ ...turn, status: "completed" }, now)).toBeUndefined();
  });
});

describe("turn activity", () => {
  it("uses the newest active main-agent step and ignores messages and child steps", () => {
    const items: RuntimeItem[] = [
      { itemId: "old", kind: "command", status: "in_progress", command: "old" },
      {
        itemId: "edit",
        kind: "file_change",
        status: "in_progress",
        paths: ["C:\\repo\\Threads.tsx"],
      },
      {
        itemId: "child",
        parentItemId: "a",
        kind: "command",
        status: "in_progress",
        command: "child",
      },
      { itemId: "message", kind: "agent_message", status: "in_progress", text: "hello" },
    ];
    expect(turnActivity(items)).toBe("editing Threads.tsx");
  });

  it("keeps a main-agent step ahead of sub-agents and truncates commands to one short line", () => {
    const command = "x".repeat(120);
    const activity = turnActivity([
      {
        itemId: "cmd",
        kind: "command",
        status: "in_progress",
        command: `${command}\nsecret second line`,
      },
      {
        itemId: "a",
        kind: "sub_agent",
        status: "in_progress",
        label: "Review",
        activity: "Reading",
      },
    ]);
    expect(activity).toBe(`running ${"x".repeat(79)}…`);
  });

  it("counts sub-agents when only they are busy, including child steps without a summary", () => {
    expect(
      turnActivity([
        { itemId: "old", kind: "command", status: "completed", command: "old" },
        { itemId: "a", kind: "sub_agent", status: "in_progress", label: "Review" },
        {
          itemId: "child",
          parentItemId: "a",
          kind: "command",
          status: "in_progress",
          command: "read",
        },
        {
          itemId: "child2",
          parentItemId: "b",
          kind: "tool_call",
          status: "in_progress",
          tool: "search",
        },
      ]),
    ).toBe("2 sub-agents working");
  });

  it("uses completed steps only when nothing is active and ignores superseded item versions", () => {
    expect(
      turnActivity([
        { itemId: "cmd", kind: "command", status: "in_progress", command: "npm test" },
        { itemId: "cmd", kind: "command", status: "completed", command: "npm test" },
        { itemId: "msg", kind: "agent_message", status: "completed", text: "done" },
      ]),
    ).toBe("ran npm test");
    expect(
      turnActivity([
        { itemId: "edit", kind: "file_change", status: "completed", paths: ["src/a.ts"] },
      ]),
    ).toBe("edited a.ts");
    expect(
      turnActivity([{ itemId: "tool", kind: "tool_call", status: "in_progress", tool: "Read" }]),
    ).toBe("using Read");
    expect(
      turnActivity([{ itemId: "tool", kind: "tool_call", status: "completed", tool: "Read" }]),
    ).toBe("used Read");
    expect(
      turnActivity([{ itemId: "failed", kind: "command", status: "failed", command: "bad" }]),
    ).toBeUndefined();
    expect(turnActivity([])).toBeUndefined();
  });
});

describe("agent map data", () => {
  it("excludes saved Codex collaboration calls while preserving other providers' agent names", () => {
    const items: RuntimeItem[] = [
      { itemId: "spawn", kind: "sub_agent", label: "spawnAgent", status: "in_progress" },
      { itemId: "wait", kind: "sub_agent", label: "wait", status: "completed" },
    ];
    expect(agentsOf([{ ...turn, items }])).toEqual([]);
    expect(turnActivity(items, "codex")).toBeUndefined();
    expect(
      agentsOf([{ ...turn, model: { providerId: "claude", model: "test" }, items }]),
    ).toHaveLength(2);
  });
  it("repairs saved Codex activity labels without changing stored rows", () => {
    const items: RuntimeItem[] = [
      { itemId: "start", kind: "sub_agent", label: "started /root/review", status: "completed" },
      { itemId: "done", kind: "sub_agent", label: "completed /root/review", status: "in_progress" },
      { itemId: "interaction", kind: "sub_agent", label: "interacted /root", status: "completed" },
      {
        itemId: "interrupted",
        kind: "sub_agent",
        label: "interrupted /root/build",
        status: "in_progress",
      },
    ];
    expect(agentsOf([{ ...turn, items }]).map((agent) => [agent.label, agent.status])).toEqual([
      ["/root/build", "failed"],
      ["/root/review", "completed"],
    ]);
    expect(turnActivity(items)).toBeUndefined();
    expect(items[1]?.status).toBe("in_progress");
  });
  const older: Turn = {
    ...turn,
    items: [
      { itemId: "a", kind: "sub_agent", status: "in_progress", label: "Old label" },
      {
        itemId: "step",
        parentItemId: "a",
        kind: "command",
        status: "in_progress",
        command: "check",
      },
    ],
  };
  const newer: Turn = {
    ...turn,
    id: "turn-2",
    startedAt: "2026-10-16T13:34:00Z",
    items: [
      { itemId: "a", kind: "sub_agent", status: "completed", label: "Review", report: "Done" },
      { itemId: "b", kind: "sub_agent", status: "failed", label: "Build" },
      { itemId: "step", parentItemId: "a", kind: "command", status: "completed", command: "check" },
    ],
  };

  it("selects the newest turn and each agent's newest item even with unsorted turns", () => {
    expect(newestTurn([newer, older])).toBe(newer);
    expect(newestTurn([])).toBeUndefined();
    expect(agentsOf([newer, older]).map((agent) => [agent.label, agent.status])).toEqual([
      ["Build", "failed"],
      ["Review", "completed"],
    ]);
  });

  it("puts working agents first and newer agents first within each group", () => {
    const items: Turn["items"] = [
      { itemId: "old-done", kind: "sub_agent", status: "completed", label: "Old done" },
      { itemId: "old-working", kind: "sub_agent", status: "in_progress", label: "Old working" },
      { itemId: "new-done", kind: "sub_agent", status: "completed", label: "New done" },
      { itemId: "new-working", kind: "sub_agent", status: "in_progress", label: "New working" },
    ];
    expect(agentsOf([{ ...turn, items }]).map((agent) => agent.itemId)).toEqual([
      "new-working",
      "old-working",
      "new-done",
      "old-done",
    ]);
    expect(items[0]?.itemId).toBe("old-done");
  });

  it("collects only the selected agent's steps with the latest status", () => {
    expect(agentStepsOf([newer, older], "a")).toEqual([newer.items[2]]);
  });
});
