import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NoteSchema, ReminderSchema, ScheduledTaskSchema, TaskRunSchema } from "@noctis/contracts";
import { DigestSchema } from "../pages/digest-view.js";
import { PlacesViewSchema } from "../pages/AutomationSettings.js";
import type { CoreResponse } from "../transport/CoreTransport.js";
import { LARP_IDS } from "./ids.js";
import type { LarpArea } from "./area.js";

let area: LarpArea;
function read(path: string): CoreResponse {
  const response = area.request?.("GET", path, undefined);
  expect(response).toBeDefined();
  return response!;
}
function command(name: string, body: object): CoreResponse {
  const response = area.request?.("POST", `/commands/${name}`, {
    idempotencyKey: `test-${crypto.randomUUID()}`,
    ...body,
  });
  expect(response).toBeDefined();
  return response!;
}
const reminders = () =>
  z.object({ reminders: z.array(ReminderSchema) }).parse(read("/reminders").body).reminders;
const notes = () => z.object({ notes: z.array(NoteSchema) }).parse(read("/notes").body).notes;
const tasks = () =>
  z.object({ tasks: z.array(ScheduledTaskSchema) }).parse(read("/tasks").body).tasks;
const mutation = (record: { id: string; revision: number }, kind: string) => ({
  [`${kind}Id`]: record.id,
  expectedRevision: record.revision,
});
const taskFields = () => {
  const task = tasks()[0]!;
  return {
    name: "Review release",
    prompt: task.prompt,
    model: task.model,
    nodeId: task.nodeId,
    rootGrantId: task.rootGrantId,
    trigger: task.trigger,
    threadMode: task.threadMode,
    maxRunMinutes: task.maxRunMinutes,
  };
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T13:00:00Z"));
  vi.resetModules();
  ({ productivity: area } = await import("./productivity.js"));
});
afterEach(() => vi.useRealTimers());

describe("productivity fixtures", () => {
  it("populates the week, parses every read and yields unrelated routes", () => {
    expect(reminders().length).toBeGreaterThanOrEqual(14);
    expect(reminders().filter((r) => r.trigger === null).length).toBeGreaterThanOrEqual(7);
    expect(notes().length).toBeGreaterThanOrEqual(7);
    expect(tasks().length).toBeGreaterThanOrEqual(3);
    for (const task of tasks()) {
      const runs = z
        .object({ runs: z.array(TaskRunSchema) })
        .parse(read(`/tasks/${task.id}/runs?limit=5`).body).runs;
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((run) => run.taskId === task.id)).toBe(true);
    }
    expect(
      DigestSchema.parse(
        read("/digest?from=2026-10-22T00%3A00%3A00Z&to=2026-10-22T13%3A00%3A00Z").body,
      ).turns.total,
    ).toBeGreaterThan(0);
    const places = PlacesViewSchema.parse(read("/places").body);
    expect(new Set(places.visits.map((visit) => visit.place))).toEqual(
      new Set(["Home", "Work", "Gym"]),
    );
    const token = z.object({ token: z.string() });
    const first = token.parse(read("/places/link").body).token;
    expect(first).toContain("larp");
    const rotated = token.parse(area.request?.("POST", "/places/link", undefined)?.body).token;
    expect(rotated).not.toBe(first);
    expect(token.parse(read("/places/link").body).token).toBe(rotated);
    expect(area.request?.("GET", "/nodes", undefined)).toBeUndefined();
    expect(area.request?.("POST", "/commands/conversation.send_message", {})).toBeUndefined();
    expect(area.request?.("GET", "/tasks/other/extra", undefined)).toBeUndefined();
    expect(read(`/tasks/${LARP_IDS.homeNode}/runs`).status).toBe(404);
  });

  it("filters reads and rebases the fixture once when loaded", async () => {
    expect(
      z
        .object({ reminders: z.array(ReminderSchema) })
        .parse(read("/reminders?status=due&limit=1").body).reminders,
    ).toHaveLength(1);
    expect(
      z.object({ notes: z.array(NoteSchema) }).parse(read("/notes?query=hardware").body).notes
        .length,
    ).toBeGreaterThan(0);
    expect(
      z.object({ notes: z.array(NoteSchema) }).parse(read("/notes?query=zzzzzzz").body).notes,
    ).toEqual([]);
    const original = reminders()[0]!.createdAt;
    vi.setSystemTime(new Date("2026-11-05T13:00:00Z"));
    vi.resetModules();
    ({ productivity: area } = await import("./productivity.js"));
    expect(Date.parse(reminders()[0]!.createdAt) - Date.parse(original)).toBe(14 * 86400000);
  });

  it("creates, updates, completes and deletes a to-do with revision checks and replay", () => {
    const payload = { text: "Compare paper samples", trigger: null, idempotencyKey: "same-create" };
    const created = command("reminder.create", payload);
    expect(created.status).toBe(200);
    const todo = ReminderSchema.parse(created.body);
    expect(todo.revision).toBe(0);
    expect(command("reminder.create", payload).body).toEqual(todo);
    expect(reminders().filter((r) => r.id === todo.id)).toHaveLength(1);
    const updated = ReminderSchema.parse(
      command("reminder.update", {
        ...mutation(todo, "reminder"),
        text: "Order paper samples",
        note: "Soft white",
        trigger: null,
      }).body,
    );
    expect(updated.text).toBe("Order paper samples");
    expect(command("reminder.delete", mutation(todo, "reminder")).status).toBe(409);
    const done = ReminderSchema.parse(
      command("reminder.complete", mutation(updated, "reminder")).body,
    );
    expect(done.status).toBe("done");
    expect(
      ReminderSchema.parse(command("reminder.delete", mutation(done, "reminder")).body).id,
    ).toBe(todo.id);
    expect(reminders().some((r) => r.id === todo.id)).toBe(false);
  });

  it("snoozes by time or PC and advances a repeating reminder", () => {
    const due = reminders().find((r) => r.status === "due")!;
    const until = "2026-10-22T16:00:00Z";
    const snoozed = ReminderSchema.parse(
      command("reminder.snooze", { ...mutation(due, "reminder"), until }).body,
    );
    expect(snoozed).toMatchObject({ status: "snoozed", nextDueAt: until });
    const pc = ReminderSchema.parse(
      command("reminder.snooze", {
        ...mutation(snoozed, "reminder"),
        atPcNodeId: LARP_IDS.homeNode,
      }).body,
    );
    expect(pc.snoozedUntilPcId).toBe(LARP_IDS.homeNode);
    expect(pc.nextDueAt).toBeUndefined();
    const repeat = ReminderSchema.parse(
      command("reminder.create", {
        text: "Stretch",
        trigger: { kind: "repeat", rule: { kind: "interval", hours: 2 } },
      }).body,
    );
    const completed = ReminderSchema.parse(
      command("reminder.complete", mutation(repeat, "reminder")).body,
    );
    expect(completed).toMatchObject({ status: "pending", nextDueAt: "2026-10-22T15:00:00.000Z" });
  });

  it("creates, updates and deletes notes without changing the imported fixture", () => {
    const note = NoteSchema.parse(
      command("note.create", { title: "Packaging", body: "Try recycled card." }).body,
    );
    const updated = NoteSchema.parse(
      command("note.update", {
        ...mutation(note, "note"),
        title: "Paperbird packaging",
        body: "Use the cream sample.",
      }).body,
    );
    expect(notes().find((n) => n.id === note.id)).toEqual(updated);
    expect(NoteSchema.parse(command("note.delete", mutation(updated, "note")).body).revision).toBe(
      2,
    );
    expect(notes().some((n) => n.id === note.id)).toBe(false);
  });

  it("creates, edits, resumes, runs, pauses and deletes a scheduled task in memory", () => {
    const task = ScheduledTaskSchema.parse(
      command("task.create", { ...taskFields(), identityId: "vesper" }).body,
    );
    expect(task.paused).toBe(true);
    const edited = ScheduledTaskSchema.parse(
      command("task.update", {
        ...taskFields(),
        ...mutation(task, "task"),
        name: "Review Paperbird",
      }).body,
    );
    const resumed = ScheduledTaskSchema.parse(
      command("task.resume", mutation(edited, "task")).body,
    );
    expect(resumed.paused).toBe(false);
    const run = TaskRunSchema.parse(command("task.run_now", mutation(resumed, "task")).body);
    expect(run.status).toBe("completed");
    expect(run.result).toBeTruthy();
    expect(
      z.object({ runs: z.array(TaskRunSchema) }).parse(read(`/tasks/${task.id}/runs`).body).runs[0],
    ).toEqual(run);
    const latest = tasks().find((t) => t.id === task.id)!;
    const paused = ScheduledTaskSchema.parse(command("task.pause", mutation(latest, "task")).body);
    expect(paused.paused).toBe(true);
    const skipped = TaskRunSchema.parse(command("task.run_now", mutation(paused, "task")).body);
    expect(skipped).toMatchObject({ status: "skipped", reason: "paused" });
    expect(
      ScheduledTaskSchema.parse(command("task.delete", mutation(paused, "task")).body).id,
    ).toBe(task.id);
    expect(tasks().some((t) => t.id === task.id)).toBe(false);
  });

  it("keeps weekly reminders in owner time across the autumn clock change", () => {
    const reminder = ReminderSchema.parse(
      command("reminder.create", {
        text: "Weekly review",
        trigger: {
          kind: "repeat",
          rule: { kind: "weekly", daysOfWeek: [1], timeOfDay: "09:00", timeZone: "Europe/London" },
        },
      }).body,
    );
    expect(reminder.nextDueAt).toBe("2026-10-26T09:00:00.000Z");
  });

  it("uses one weekly occurrence when a local hour repeats", () => {
    vi.setSystemTime(new Date("2026-10-25T01:00:00Z"));
    const reminder = ReminderSchema.parse(
      command("reminder.create", {
        text: "Weekly review",
        trigger: {
          kind: "repeat",
          rule: { kind: "weekly", daysOfWeek: [0], timeOfDay: "01:30", timeZone: "Europe/London" },
        },
      }).body,
    );
    expect(reminder.nextDueAt).toBe("2026-11-01T01:30:00.000Z");
  });

  it("skips a weekly time missing during the spring clock change", () => {
    vi.setSystemTime(new Date("2026-03-29T00:00:00Z"));
    const reminder = ReminderSchema.parse(
      command("reminder.create", {
        text: "Weekly review",
        trigger: {
          kind: "repeat",
          rule: { kind: "weekly", daysOfWeek: [0], timeOfDay: "01:30", timeZone: "Europe/London" },
        },
      }).body,
    );
    expect(reminder.nextDueAt).toBe("2026-04-05T00:30:00.000Z");
  });

  it("refuses malformed commands, past times and unknown folders without mutating state", () => {
    const before = reminders();
    expect(command("reminder.create", { text: "" }).status).toBe(400);
    expect(
      command("reminder.create", {
        text: "Past",
        trigger: { kind: "at", at: "2026-10-21T09:00:00Z" },
      }).status,
    ).toBe(409);
    expect(
      command("reminder.snooze", {
        ...mutation(before[0]!, "reminder"),
        until: "2026-10-22T12:00:00Z",
      }).status,
    ).toBe(409);
    expect(
      command("task.create", { ...taskFields(), identityId: "vesper", rootGrantId: "unknown" })
        .status,
    ).toBe(409);
    expect(command("task.create", { ...taskFields(), identityId: "jester" }).status).toBe(409);
    expect(reminders()).toEqual(before);
  });
});
