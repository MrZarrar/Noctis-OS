import { z } from "zod";
import {
  CreateReminderCommandSchema,
  UpdateReminderCommandSchema,
  CompleteReminderCommandSchema,
  SnoozeReminderCommandSchema,
  DeleteReminderCommandSchema,
  CreateNoteCommandSchema,
  UpdateNoteCommandSchema,
  DeleteNoteCommandSchema,
  CreateTaskCommandSchema,
  UpdateTaskCommandSchema,
  PauseTaskCommandSchema,
  ResumeTaskCommandSchema,
  RunTaskNowCommandSchema,
  DeleteTaskCommandSchema,
  ReminderSchema,
  ReminderStatusSchema,
  NoteSchema,
  ScheduledTaskSchema,
  TaskRunSchema,
} from "@noctis/contracts";
import type { Trigger } from "@noctis/contracts";
import type { CoreResponse } from "../transport/CoreTransport.js";
import type { LarpArea } from "./area.js";
import { ok, parsePath, rebase } from "./area.js";
import { LARP_IDS } from "./ids.js";
import fixture from "./fixtures/productivity.json" with { type: "json" };

const data = rebase(fixture);
const reminders = z.array(ReminderSchema).parse(data.reminders);
const notes = z.array(NoteSchema).parse(data.notes);
const tasks = z.array(ScheduledTaskSchema).parse(data.tasks);
const runs = z.array(TaskRunSchema).parse(data.runs);
const replays = new Map<string, CoreResponse>();
let phoneLink = "larp-inert-phone-link";
const schemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  "reminder.create": CreateReminderCommandSchema,
  "reminder.update": UpdateReminderCommandSchema,
  "reminder.complete": CompleteReminderCommandSchema,
  "reminder.snooze": SnoozeReminderCommandSchema,
  "reminder.delete": DeleteReminderCommandSchema,
  "note.create": CreateNoteCommandSchema,
  "note.update": UpdateNoteCommandSchema,
  "note.delete": DeleteNoteCommandSchema,
  "task.create": CreateTaskCommandSchema,
  "task.update": UpdateTaskCommandSchema,
  "task.pause": PauseTaskCommandSchema,
  "task.resume": ResumeTaskCommandSchema,
  "task.run_now": RunTaskNowCommandSchema,
  "task.delete": DeleteTaskCommandSchema,
};
const refused = (status: number, message: string): CoreResponse => ({
  status,
  body: { error: { message }, message },
});
function newId(): string {
  const time = Date.now().toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-${crypto.randomUUID().replaceAll("-", "").slice(-12)}`;
}

/** Next occurrence in the rule's own zone, including skipped and repeated clock times. */
function nextDue(trigger: Trigger): string | undefined {
  if (trigger === null || trigger.kind === "at_pc") return undefined;
  if (trigger.kind === "at") return trigger.at;
  if (trigger.rule.kind === "interval")
    return new Date(Date.now() + trigger.rule.hours * 3600000).toISOString();
  const rule = trigger.rule;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: rule.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const wallTime = (instant: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((p) => [p.type, Number(p.value)]),
    );
    return Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
  };
  const local = new Date(wallTime(Date.now()));
  const [hour, minute] = rule.timeOfDay.split(":").map(Number);
  for (let day = 0; day <= 14; day++) {
    const date = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day),
    );
    if (!rule.daysOfWeek.includes(date.getUTCDay())) continue;
    const wall = date.getTime() + hour! * 3600000 + minute! * 60000;
    const offsets = [-36, 0, 36].map((hours) => {
      const at = wall + hours * 3600000;
      return wallTime(at) - at;
    });
    const candidates = offsets.map((offset) => wall - offset).filter((at) => wallTime(at) === wall);
    const first = Math.min(...candidates);
    if (first > Date.now() && Number.isFinite(first)) return new Date(first).toISOString();
  }
  return undefined;
}
function scheduled(trigger: Trigger) {
  const nextDueAt = nextDue(trigger);
  return nextDueAt === undefined ? {} : { nextDueAt };
}
function validTrigger(trigger: Trigger): boolean {
  if (trigger?.kind === "at") return Date.parse(trigger.at) > Date.now();
  return (
    trigger?.kind !== "at_pc" ||
    [LARP_IDS.homeNode, LARP_IDS.workNode, LARP_IDS.phoneNode].some((id) => id === trigger.nodeId)
  );
}

function command(name: string, body: unknown): CoreResponse | undefined {
  const schema = schemas[name];
  if (!schema) return undefined;
  const parsed = schema.safeParse(body);
  if (!parsed.success) return refused(400, "Check the fields and try again.");
  const {
    idempotencyKey,
    expectedRevision,
    reminderId,
    noteId,
    taskId,
    until,
    atPcNodeId,
    ...fields
  } = parsed.data;
  const replayKey = `${name}:${String(idempotencyKey)}`;
  const replay = replays.get(replayKey);
  if (replay) return structuredClone(replay);
  const [entity, action] = name.split(".");
  const records = entity === "reminder" ? reminders : entity === "note" ? notes : tasks;
  const id = reminderId ?? noteId ?? taskId;
  const current = records.find((record) => record.id === id);
  if (action !== "create") {
    if (!current) return refused(404, "This record no longer exists.");
    if (current.revision !== expectedRevision)
      return refused(409, "This record changed. Refresh and try again.");
  }
  const now = new Date().toISOString();
  const base = current
    ? { ...current, revision: current.revision + 1, updatedAt: now }
    : { id: newId(), revision: 0, createdAt: now, updatedAt: now };
  const save = (value: unknown): CoreResponse => {
    const response = ok(structuredClone(value));
    replays.set(replayKey, response);
    return structuredClone(response);
  };

  if (entity === "note") {
    const record = NoteSchema.parse({ ...base, ...fields });
    const index = notes.findIndex((note) => note.id === record.id);
    if (action === "delete") notes.splice(index, 1);
    else if (index === -1) notes.unshift(record);
    else notes[index] = record;
    return save(record);
  }
  if (entity === "reminder") {
    const record = ReminderSchema.parse({
      ...base,
      ...fields,
      status: current && "status" in current ? current.status : "pending",
    });
    if (action !== "delete") {
      delete record.nextDueAt;
      delete record.snoozedUntilPcId;
    }
    if (action === "create" || action === "update") {
      if (!validTrigger(record.trigger))
        return refused(409, "Choose a future time or an available PC.");
      record.status = "pending";
      if (fields.note === undefined) delete record.note;
      Object.assign(record, scheduled(record.trigger));
    } else if (action === "complete") {
      const repeat =
        record.trigger?.kind === "repeat" ||
        (record.trigger?.kind === "at_pc" && record.trigger.repeat);
      record.status = repeat ? "pending" : "done";
      if (repeat) Object.assign(record, scheduled(record.trigger));
    } else if (action === "snooze") {
      record.status = "snoozed";
      if (typeof atPcNodeId === "string") {
        if (!validTrigger({ kind: "at_pc", nodeId: atPcNodeId, repeat: false }))
          return refused(409, "Choose an available PC.");
        record.snoozedUntilPcId = atPcNodeId;
      } else if (typeof until === "string" && Date.parse(until) > Date.now()) {
        record.nextDueAt = until;
      } else return refused(409, "Choose a future snooze time.");
    }
    const index = reminders.findIndex((r) => r.id === record.id);
    if (action === "delete") reminders.splice(index, 1);
    else if (index === -1) reminders.unshift(record);
    else reminders[index] = record;
    return save(record);
  }

  const task = ScheduledTaskSchema.parse({
    ...base,
    ...fields,
    paused: current && "paused" in current ? current.paused : true,
  });
  if (action === "create" || action === "update" || action === "resume") {
    const shared =
      (task.nodeId === LARP_IDS.homeNode && task.rootGrantId === LARP_IDS.homeProjectsGrant) ||
      (task.nodeId === LARP_IDS.workNode && task.rootGrantId === LARP_IDS.workDocumentsGrant);
    if (!shared || (task.identityId === "jester" && task.model.providerId !== "hermes"))
      return refused(409, "Choose a shared folder and an available agent.");
    if (action !== "resume" && !validTrigger(task.trigger))
      return refused(409, "Choose a future time or an available PC.");
    delete task.nextDueAt;
    Object.assign(task, scheduled(task.trigger));
    task.consecutiveFailures = 0;
    if (action === "update") {
      delete task.proposedUpdate;
      delete task.threadId;
    }
  }
  const index = tasks.findIndex((t) => t.id === task.id);
  if (action === "run_now") {
    const run = TaskRunSchema.parse({
      id: newId(),
      taskId: task.id,
      startedAt: now,
      completedAt: now,
      status: task.paused ? "skipped" : "completed",
      ...(task.paused
        ? { reason: "paused" }
        : {
            result: `Reviewed ${task.name}. The checklist and next steps are ready to review.`,
            threadId: task.threadId ?? LARP_IDS.demoTaskThread,
          }),
    });
    runs.unshift(run);
    if (!task.paused) {
      if (run.threadId !== undefined) task.threadId = run.threadId;
      task.paused =
        task.trigger?.kind === "at" || (task.trigger?.kind === "at_pc" && !task.trigger.repeat);
      delete task.nextDueAt;
      if (task.trigger?.kind === "repeat") Object.assign(task, scheduled(task.trigger));
      tasks[index] = task;
    }
    return save(run);
  }
  if (action === "pause") task.paused = true;
  if (action === "resume") task.paused = false;
  if (action === "delete") tasks.splice(index, 1);
  else if (index === -1) tasks.unshift(task);
  else tasks[index] = task;
  return save(task);
}

export const productivity: LarpArea = {
  request(method, path, body) {
    const { segments, query } = parsePath(path);
    const [route, id, subroute] = segments;
    if (method === "POST" && route === "commands" && segments.length === 2)
      return command(id ?? "", body);
    if (
      route === "places" &&
      id === "link" &&
      segments.length === 2 &&
      (method === "GET" || method === "POST")
    ) {
      if (method === "POST") phoneLink = `larp-inert-${newId()}`;
      return ok({ token: phoneLink });
    }
    if (method !== "GET") return undefined;
    const count = Number(query.get("limit") ?? 200);
    const limit = Number.isInteger(count) && count > 0 ? Math.min(count, 2000) : 200;
    if (route === "tasks" && subroute === "runs" && segments.length === 3) {
      if (!tasks.some((task) => task.id === id)) return refused(404, "No such task.");
      return ok({
        runs: structuredClone(
          runs
            .filter((run) => run.taskId === id)
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
            .slice(0, limit),
        ),
      });
    }
    if (segments.length !== 1) return undefined;
    if (route === "reminders") {
      const status = query.get("status");
      if (status !== null && !ReminderStatusSchema.safeParse(status).success)
        return refused(400, "Unknown reminder status.");
      return ok({
        reminders: structuredClone(
          reminders.filter((r) => status === null || r.status === status).slice(0, limit),
        ),
      });
    }
    if (route === "notes") {
      const search = (query.get("query") ?? "").toLowerCase();
      return ok({
        notes: structuredClone(
          notes
            .filter((n) => `${n.title}\n${n.body}`.toLowerCase().includes(search))
            .slice(0, limit),
        ),
      });
    }
    if (route === "tasks") return ok({ tasks: structuredClone(tasks.slice(0, limit)) });
    if (route === "places") return ok(structuredClone(data.places));
    if (route === "digest") return ok(structuredClone(data.digest));
    return undefined;
  },
};
