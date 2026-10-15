import { describe, expect, it } from "vitest";
import {
  TriggerSchema,
  CreateTaskCommandSchema,
  RuntimeProposalSchema,
  PagePanelPayloadSchema,
  NodeFrameSchema,
  SnoozeReminderCommandSchema,
  CORE_PATH_PATTERN,
  TaskProposedUpdateSchema,
} from "./index.js";

describe("productivity contracts", () => {
  it("limits model task actions to running or pausing an existing task", () => {
    const taskId = "0199a000-0000-7000-8000-000000000001";
    for (const action of ["run_now", "pause"])
      expect(RuntimeProposalSchema.safeParse({ kind: "task_action", taskId, action }).success).toBe(
        true,
      );
    expect(
      RuntimeProposalSchema.safeParse({ kind: "task_action", taskId, action: "resume" }).success,
    ).toBe(false);
  });
  it("accepts targeted task change suggestions without granting activation or identity scope", () => {
    const fields = {
      name: "Check repo",
      prompt: "List changes",
      model: { providerId: "codex", model: "fake" },
      nodeId: "0199a000-0000-7000-8000-000000000001",
      rootGrantId: "repo",
      trigger: { kind: "repeat", rule: { kind: "interval", hours: 1 } },
      threadMode: "new",
      maxRunMinutes: 30,
    };
    expect(
      RuntimeProposalSchema.safeParse({ kind: "task", taskId: fields.nodeId, ...fields }).success,
    ).toBe(true);
    expect(TaskProposedUpdateSchema.safeParse(fields).success).toBe(true);
    expect(TaskProposedUpdateSchema.safeParse({ ...fields, paused: false }).success).toBe(false);
    expect(TaskProposedUpdateSchema.safeParse({ ...fields, identityId: "jester" }).success).toBe(
      false,
    );
  });
  it("requires exactly one snooze target", () => {
    const base = {
      idempotencyKey: "s",
      reminderId: "0199a000-0000-7000-8000-000000000001",
      expectedRevision: 0,
    };
    expect(
      SnoozeReminderCommandSchema.safeParse({ ...base, atPcNodeId: base.reminderId }).success,
    ).toBe(true);
    expect(SnoozeReminderCommandSchema.safeParse(base).success).toBe(false);
    expect(
      SnoozeReminderCommandSchema.safeParse({
        ...base,
        atPcNodeId: base.reminderId,
        until: "2026-10-15T12:00:00Z",
      }).success,
    ).toBe(false);
  });
  it("validates bounded deterministic triggers", () => {
    expect(TriggerSchema.safeParse(null).success).toBe(true);
    expect(
      TriggerSchema.safeParse({
        kind: "repeat",
        rule: { kind: "weekly", daysOfWeek: [1], timeOfDay: "09:00", timeZone: "Europe/London" },
      }).success,
    ).toBe(true);
    for (const trigger of [
      { kind: "at", at: "tomorrow" },
      { kind: "repeat", rule: { kind: "interval", hours: 0 } },
      {
        kind: "repeat",
        rule: { kind: "weekly", daysOfWeek: [8], timeOfDay: "25:00", timeZone: "made/up" },
      },
    ])
      expect(TriggerSchema.safeParse(trigger).success).toBe(false);
  });
  it("does not let a model enable a task or spoof capture provenance", () => {
    expect(
      RuntimeProposalSchema.safeParse({
        kind: "note",
        title: "Idea",
        body: "Keep this",
        identityId: "jester",
      }).success,
    ).toBe(false);
    expect(CreateTaskCommandSchema.safeParse({ paused: false }).success).toBe(false);
  });
  it("recognises authenticated API collections, panels, and owner presence", () => {
    for (const page of ["Reminders", "To-dos", "Notes"])
      expect(PagePanelPayloadSchema.safeParse({ page }).success).toBe(true);
    for (const segment of ["reminders", "notes", "tasks"])
      expect(CORE_PATH_PATTERN.test(`/${segment}`)).toBe(true);
    expect(
      NodeFrameSchema.safeParse({ kind: "owner_presence", envelopeVersion: 1, present: true })
        .success,
    ).toBe(true);
    expect(
      NodeFrameSchema.safeParse({
        kind: "owner_presence",
        envelopeVersion: 1,
        present: true,
        nodeId: "foreign",
      }).success,
    ).toBe(false);
  });
});
