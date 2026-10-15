import type {
  CreateReminderCommand,
  UpdateReminderCommand,
  CompleteReminderCommand,
  SnoozeReminderCommand,
  DeleteReminderCommand,
  CreateNoteCommand,
  UpdateNoteCommand,
  DeleteNoteCommand,
  Reminder,
  ReminderStatus,
  Note,
  Trigger,
  EventName,
} from "@noctis/contracts";
import { ReminderSchema, NoteSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { checkRevision, conflict, ok } from "@noctis/domain";
import type { NoctisDatabase } from "../db/connection.js";
import type { EventDraft } from "../db/events.js";
import type { Kernel, CommandContext } from "../kernel.js";
import { runCommand } from "../kernel.js";
import { getNode } from "../nodes/registry.js";
import { nextTriggerAt } from "./triggers.js";

type JsonRow = { data_json: string };
export function getReminder(db: NoctisDatabase, id: string): Reminder | undefined {
  const row = db.prepare("SELECT data_json FROM reminders WHERE id=?").get(id) as
    JsonRow | undefined;
  return row === undefined ? undefined : ReminderSchema.parse(JSON.parse(row.data_json));
}
export function listReminders(
  db: NoctisDatabase,
  limit = 200,
  status?: ReminderStatus,
): Reminder[] {
  const rows = db
    .prepare(
      "SELECT data_json FROM reminders WHERE (? IS NULL OR json_extract(data_json,'$.status')=?) ORDER BY id DESC LIMIT ?",
    )
    .all(status ?? null, status ?? null, limit) as JsonRow[];
  return rows.map((row) => ReminderSchema.parse(JSON.parse(row.data_json)));
}
export function getNote(db: NoctisDatabase, id: string): Note | undefined {
  const row = db.prepare("SELECT data_json FROM notes WHERE id=?").get(id) as JsonRow | undefined;
  return row === undefined ? undefined : NoteSchema.parse(JSON.parse(row.data_json));
}
export function listNotes(db: NoctisDatabase, limit = 200, query = ""): Note[] {
  const rows = db
    .prepare(
      "SELECT data_json FROM notes WHERE instr(lower(json_extract(data_json,'$.title') || char(10) || json_extract(data_json,'$.body')),lower(?))>0 ORDER BY id DESC LIMIT ?",
    )
    .all(query, limit) as JsonRow[];
  return rows.map((row) => NoteSchema.parse(JSON.parse(row.data_json)));
}

export function validateTrigger(kernel: Kernel, trigger: Trigger): Result<void> {
  if (trigger?.kind === "at" && Date.parse(trigger.at) <= kernel.clock.now())
    return conflict({
      kind: "unavailable",
      entity: "trigger",
      reason: "The reminder time must be in the future",
    });
  if (trigger?.kind === "at_pc") {
    const node = getNode(kernel.db, trigger.nodeId);
    if (node === undefined || node.revokedAt !== undefined)
      return conflict({ kind: "not_found", entity: "node", id: trigger.nodeId });
  }
  return ok(undefined);
}
function event(
  kernel: Kernel,
  context: CommandContext,
  record: Reminder | Note,
  type: EventName,
): EventDraft {
  return {
    id: kernel.ids.nextId(),
    streamType: type.startsWith("reminder.") ? "reminder" : "note",
    streamId: record.id,
    type,
    actorType: context.actorType,
    actorId: context.actorId,
    payloadVersion: 1,
    payload: record,
    correlationId: context.correlationId,
    occurredAt: new Date(kernel.clock.now()).toISOString(),
  };
}
export function createReminder(
  kernel: Kernel,
  context: CommandContext,
  command: CreateReminderCommand,
): Result<Reminder> {
  const id = kernel.ids.nextId();
  const now = new Date(kernel.clock.now()).toISOString();
  return runCommand(
    kernel,
    { scope: "reminder.create", key: command.idempotencyKey, resultId: id },
    (tx) => {
      const valid = validateTrigger(kernel, command.trigger);
      if (!valid.ok) return valid;
      const nextDueAt = nextTriggerAt(command.trigger, kernel.clock.now());
      const record = ReminderSchema.parse({
        id,
        text: command.text,
        ...(command.note === undefined ? {} : { note: command.note }),
        trigger: command.trigger,
        status: "pending",
        identityId: command.identityId,
        ...(command.threadId === undefined ? {} : { threadId: command.threadId }),
        revision: 0,
        createdAt: now,
        updatedAt: now,
        ...(nextDueAt === undefined ? {} : { nextDueAt }),
      });
      tx.prepare("INSERT INTO reminders(id,data_json) VALUES (?,?)").run(
        id,
        JSON.stringify(record),
      );
      return ok({ value: record, events: [event(kernel, context, record, "reminder.created.v1")] });
    },
  );
}
function mutateReminder(
  kernel: Kernel,
  context: CommandContext,
  command: { idempotencyKey: string; reminderId: string; expectedRevision: number },
  scope: string,
  type: EventName,
  change: (current: Reminder) => Result<Reminder>,
  remove = false,
): Result<Reminder> {
  return runCommand(
    kernel,
    { scope, key: command.idempotencyKey, resultId: command.reminderId },
    (tx) => {
      const current = getReminder(tx, command.reminderId);
      if (current === undefined)
        return conflict({ kind: "not_found", entity: "reminder", id: command.reminderId });
      const revision = checkRevision(command.expectedRevision, current.revision);
      if (!revision.ok) return revision;
      const changed = change(current);
      if (!changed.ok) return changed;
      const record = ReminderSchema.parse({
        ...changed.value,
        revision: revision.value,
        updatedAt: new Date(kernel.clock.now()).toISOString(),
      });
      if (remove) tx.prepare("DELETE FROM reminders WHERE id=?").run(record.id);
      else
        tx.prepare("UPDATE reminders SET data_json=? WHERE id=?").run(
          JSON.stringify(record),
          record.id,
        );
      return ok({ value: record, events: [event(kernel, context, record, type)] });
    },
  );
}
export function updateReminder(
  kernel: Kernel,
  context: CommandContext,
  command: UpdateReminderCommand,
): Result<Reminder> {
  return mutateReminder(
    kernel,
    context,
    command,
    "reminder.update",
    "reminder.updated.v1",
    (current) => {
      const valid = validateTrigger(kernel, command.trigger);
      if (!valid.ok) return valid;
      const base = { ...current };
      delete base.nextDueAt;
      delete base.note;
      delete base.snoozedUntilPcId;
      const nextDueAt = nextTriggerAt(command.trigger, kernel.clock.now());
      return ok({
        ...base,
        text: command.text,
        ...(command.note === undefined ? {} : { note: command.note }),
        trigger: command.trigger,
        status: "pending",
        ...(nextDueAt === undefined ? {} : { nextDueAt }),
      });
    },
  );
}
export function completeReminder(
  kernel: Kernel,
  context: CommandContext,
  command: CompleteReminderCommand,
): Result<Reminder> {
  return mutateReminder(
    kernel,
    context,
    command,
    "reminder.complete",
    "reminder.done.v1",
    (current) => {
      const base = { ...current };
      delete base.nextDueAt;
      delete base.snoozedUntilPcId;
      const repeating =
        current.trigger?.kind === "repeat" ||
        (current.trigger?.kind === "at_pc" && current.trigger.repeat);
      const nextDueAt = repeating ? nextTriggerAt(current.trigger, kernel.clock.now()) : undefined;
      return ok({
        ...base,
        status: repeating ? "pending" : "done",
        ...(nextDueAt === undefined ? {} : { nextDueAt }),
      });
    },
  );
}
export function snoozeReminder(
  kernel: Kernel,
  context: CommandContext,
  command: SnoozeReminderCommand,
): Result<Reminder> {
  return mutateReminder(
    kernel,
    context,
    command,
    "reminder.snooze",
    "reminder.snoozed.v1",
    (current) => {
      const base = { ...current };
      delete base.nextDueAt;
      delete base.snoozedUntilPcId;
      if (command.atPcNodeId !== undefined) {
        const valid = validateTrigger(kernel, {
          kind: "at_pc",
          nodeId: command.atPcNodeId,
          repeat: false,
        });
        if (!valid.ok) return valid;
        return ok({ ...base, status: "snoozed", snoozedUntilPcId: command.atPcNodeId });
      }
      if (command.until === undefined || Date.parse(command.until) <= kernel.clock.now())
        return conflict({
          kind: "unavailable",
          entity: "trigger",
          reason: "Snooze time must be in the future",
        });
      return ok({ ...base, status: "snoozed", nextDueAt: command.until });
    },
  );
}
export function deleteReminder(
  kernel: Kernel,
  context: CommandContext,
  command: DeleteReminderCommand,
): Result<Reminder> {
  return mutateReminder(
    kernel,
    context,
    command,
    "reminder.delete",
    "reminder.deleted.v1",
    (current) => ok(current),
    true,
  );
}
export function markReminderDue(
  kernel: Kernel,
  context: CommandContext,
  command: {
    idempotencyKey: string;
    reminderId: string;
    expectedRevision: number;
    nextDueAt?: string;
  },
): Result<Reminder> {
  return mutateReminder(kernel, context, command, "reminder.fire", "reminder.due.v1", (current) => {
    const base = { ...current };
    delete base.nextDueAt;
    delete base.snoozedUntilPcId;
    return ok({
      ...base,
      status: "due",
      ...(command.nextDueAt === undefined ? {} : { nextDueAt: command.nextDueAt }),
    });
  });
}
export function createNote(
  kernel: Kernel,
  context: CommandContext,
  command: CreateNoteCommand,
): Result<Note> {
  const id = kernel.ids.nextId();
  const now = new Date(kernel.clock.now()).toISOString();
  return runCommand(
    kernel,
    { scope: "note.create", key: command.idempotencyKey, resultId: id },
    (tx) => {
      const record = NoteSchema.parse({
        id,
        title: command.title,
        body: command.body,
        identityId: command.identityId,
        ...(command.threadId === undefined ? {} : { threadId: command.threadId }),
        revision: 0,
        createdAt: now,
        updatedAt: now,
      });
      tx.prepare("INSERT INTO notes(id,data_json) VALUES (?,?)").run(id, JSON.stringify(record));
      return ok({ value: record, events: [event(kernel, context, record, "note.created.v1")] });
    },
  );
}
function mutateNote(
  kernel: Kernel,
  context: CommandContext,
  command: DeleteNoteCommand,
  update?: UpdateNoteCommand,
): Result<Note> {
  const scope = update === undefined ? "note.delete" : "note.update";
  return runCommand(
    kernel,
    { scope, key: command.idempotencyKey, resultId: command.noteId },
    (tx) => {
      const current = getNote(tx, command.noteId);
      if (current === undefined)
        return conflict({ kind: "not_found", entity: "note", id: command.noteId });
      const revision = checkRevision(command.expectedRevision, current.revision);
      if (!revision.ok) return revision;
      const record = NoteSchema.parse({
        ...current,
        ...(update === undefined ? {} : { title: update.title, body: update.body }),
        revision: revision.value,
        updatedAt: new Date(kernel.clock.now()).toISOString(),
      });
      if (update === undefined) tx.prepare("DELETE FROM notes WHERE id=?").run(record.id);
      else
        tx.prepare("UPDATE notes SET data_json=? WHERE id=?").run(
          JSON.stringify(record),
          record.id,
        );
      return ok({
        value: record,
        events: [
          event(
            kernel,
            context,
            record,
            update === undefined ? "note.deleted.v1" : "note.updated.v1",
          ),
        ],
      });
    },
  );
}
export function updateNote(
  kernel: Kernel,
  context: CommandContext,
  command: UpdateNoteCommand,
): Result<Note> {
  return mutateNote(kernel, context, command, command);
}
export function deleteNote(
  kernel: Kernel,
  context: CommandContext,
  command: DeleteNoteCommand,
): Result<Note> {
  return mutateNote(kernel, context, command);
}
