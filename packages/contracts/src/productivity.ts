import { z } from "zod";
import { ConversationalIdentityIdSchema } from "./enums.js";
import {
  IdempotencyKeySchema,
  RevisionSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./primitives.js";
import { ModelRefSchema } from "./runtime.js";
import { TriggerSchema } from "./trigger.js";
export { TriggerSchema } from "./trigger.js";
export type { Trigger } from "./trigger.js";

const Provenance = { identityId: ConversationalIdentityIdSchema, threadId: UuidSchema.optional() };
const RecordBase = {
  id: UuidSchema,
  ...Provenance,
  revision: RevisionSchema,
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
};
const ReminderFields = {
  text: z.string().trim().min(1).max(2000),
  note: z.string().max(20_000).optional(),
  trigger: TriggerSchema,
};
const NoteFields = { title: z.string().trim().min(1).max(200), body: z.string().max(100_000) };
const TaskFields = {
  name: z.string().trim().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  model: ModelRefSchema,
  nodeId: UuidSchema,
  rootGrantId: z.string().trim().min(1).max(128),
  trigger: TriggerSchema.refine((trigger) => trigger !== null, "tasks need a trigger"),
  threadMode: z.enum(["new", "continue"]).default("new"),
  maxRunMinutes: z.int().min(1).max(1440).default(30),
};
export const TaskProposedUpdateSchema = z.object(TaskFields).strict();
export type TaskProposedUpdate = z.infer<typeof TaskProposedUpdateSchema>;
export const ReminderStatusSchema = z.enum(["pending", "due", "done", "snoozed"]);
export const ReminderSchema = z
  .object({
    ...RecordBase,
    ...ReminderFields,
    status: ReminderStatusSchema,
    nextDueAt: UtcTimestampSchema.optional(),
    snoozedUntilPcId: UuidSchema.optional(),
  })
  .strict();
export const NoteSchema = z.object({ ...RecordBase, ...NoteFields }).strict();
export const ScheduledTaskSchema = z
  .object({
    ...RecordBase,
    ...TaskFields,
    paused: z.boolean(),
    nextDueAt: UtcTimestampSchema.optional(),
    consecutiveFailures: z.int().nonnegative().default(0),
    proposedUpdate: TaskProposedUpdateSchema.optional(),
  })
  .strict();
export const TaskRunSchema = z
  .object({
    id: UuidSchema,
    taskId: UuidSchema,
    status: z.enum(["running", "completed", "failed", "needs_you", "skipped"]),
    reason: z.string().max(2000).optional(),
    threadId: UuidSchema.optional(),
    turnId: UuidSchema.optional(),
    startedAt: UtcTimestampSchema,
    completedAt: UtcTimestampSchema.optional(),
    result: z.string().max(20_000).optional(),
  })
  .strict();
const CommandBase = { idempotencyKey: IdempotencyKeySchema };
const ReminderMutation = {
  ...CommandBase,
  reminderId: UuidSchema,
  expectedRevision: RevisionSchema,
};
const NoteMutation = { ...CommandBase, noteId: UuidSchema, expectedRevision: RevisionSchema };
const TaskMutation = { ...CommandBase, taskId: UuidSchema, expectedRevision: RevisionSchema };
export const CreateReminderCommandSchema = z
  .object({ ...CommandBase, ...Provenance, ...ReminderFields })
  .strict();
export const UpdateReminderCommandSchema = z
  .object({ ...ReminderMutation, ...ReminderFields })
  .strict();
export const CompleteReminderCommandSchema = z.object(ReminderMutation).strict();
export const SnoozeReminderCommandSchema = z
  .object({
    ...ReminderMutation,
    until: UtcTimestampSchema.optional(),
    atPcNodeId: UuidSchema.optional(),
  })
  .strict()
  .refine(
    (command) => (command.until === undefined) !== (command.atPcNodeId === undefined),
    "Exactly one snooze target",
  );
export const DeleteReminderCommandSchema = z.object(ReminderMutation).strict();
export const CreateNoteCommandSchema = z
  .object({ ...CommandBase, ...Provenance, ...NoteFields })
  .strict();
export const UpdateNoteCommandSchema = z.object({ ...NoteMutation, ...NoteFields }).strict();
export const DeleteNoteCommandSchema = z.object(NoteMutation).strict();
export const CreateTaskCommandSchema = z
  .object({ ...CommandBase, ...Provenance, ...TaskFields })
  .strict();
export const UpdateTaskCommandSchema = z.object({ ...TaskMutation, ...TaskFields }).strict();
export const PauseTaskCommandSchema = z.object(TaskMutation).strict();
export const ResumeTaskCommandSchema = z.object(TaskMutation).strict();
export const RunTaskNowCommandSchema = z.object(TaskMutation).strict();
export const DeleteTaskCommandSchema = z.object(TaskMutation).strict();
export type Reminder = z.infer<typeof ReminderSchema>;
export type ReminderStatus = z.infer<typeof ReminderStatusSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;
export type TaskRun = z.infer<typeof TaskRunSchema>;
export type CreateReminderCommand = z.infer<typeof CreateReminderCommandSchema>;
export type UpdateReminderCommand = z.infer<typeof UpdateReminderCommandSchema>;
export type CompleteReminderCommand = z.infer<typeof CompleteReminderCommandSchema>;
export type SnoozeReminderCommand = z.infer<typeof SnoozeReminderCommandSchema>;
export type DeleteReminderCommand = z.infer<typeof DeleteReminderCommandSchema>;
export type CreateNoteCommand = z.infer<typeof CreateNoteCommandSchema>;
export type UpdateNoteCommand = z.infer<typeof UpdateNoteCommandSchema>;
export type DeleteNoteCommand = z.infer<typeof DeleteNoteCommandSchema>;
export type CreateTaskCommand = z.infer<typeof CreateTaskCommandSchema>;
export type UpdateTaskCommand = z.infer<typeof UpdateTaskCommandSchema>;
export type PauseTaskCommand = z.infer<typeof PauseTaskCommandSchema>;
export type ResumeTaskCommand = z.infer<typeof ResumeTaskCommandSchema>;
export type RunTaskNowCommand = z.infer<typeof RunTaskNowCommandSchema>;
export type DeleteTaskCommand = z.infer<typeof DeleteTaskCommandSchema>;
