import type {
  CreateTaskCommand,
  DeleteTaskCommand,
  EventName,
  PauseTaskCommand,
  ResumeTaskCommand,
  RunTaskNowCommand,
  ScheduledTask,
  TaskRun,
  UpdateTaskCommand,
  TaskProposedUpdate,
} from "@noctis/contracts";
import { ScheduledTaskSchema, TaskRunSchema, TaskProposedUpdateSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";
import type { ConversationService } from "../conversation/service.js";
import { getTurn, listMessages } from "../conversation/service.js";
import { createNamedThread } from "../conversation/threads.js";
import type { NoctisDatabase } from "../db/connection.js";
import type { EventDraft } from "../db/events.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import type { Dispatcher } from "../nodes/dispatch.js";
import { sharedFolder } from "../nodes/registry.js";
import { listReminders, markReminderDue, validateTrigger } from "./service.js";
import { latestTriggerAt, nextTriggerAt } from "./triggers.js";

export interface TaskExecutionDeps {
  conversation: Pick<ConversationService, "sendMessage" | "cancelTurn">;
  dispatcher: Dispatcher;
  enabled: boolean;
}

const iso = (kernel: Kernel): string => new Date(kernel.clock.now()).toISOString();
const system = (kernel: Kernel): CommandContext => ({
  correlationId: kernel.ids.nextId(),
  actorType: "system",
  actorId: "scheduler",
});
function event(
  kernel: Kernel,
  context: CommandContext,
  id: string,
  type: EventName,
  payload: unknown,
): EventDraft {
  return {
    id: kernel.ids.nextId(),
    streamType: "task",
    streamId: id,
    type,
    payloadVersion: 1,
    payload,
    actorType: context.actorType,
    actorId: context.actorId,
    correlationId: context.correlationId,
    occurredAt: iso(kernel),
  };
}
export function getTask(db: NoctisDatabase, id: string): ScheduledTask | undefined {
  const row = db.prepare("SELECT data_json FROM scheduled_tasks WHERE id=?").get(id) as
    { data_json: string } | undefined;
  return row === undefined ? undefined : ScheduledTaskSchema.parse(JSON.parse(row.data_json));
}
export function listTasks(db: NoctisDatabase, limit = 200): ScheduledTask[] {
  return (
    db.prepare("SELECT data_json FROM scheduled_tasks ORDER BY id DESC LIMIT ?").all(limit) as {
      data_json: string;
    }[]
  ).map((row) => ScheduledTaskSchema.parse(JSON.parse(row.data_json)));
}
export function getTaskRun(db: NoctisDatabase, id: string): TaskRun | undefined {
  const row = db.prepare("SELECT data_json FROM task_runs WHERE id=?").get(id) as
    { data_json: string } | undefined;
  return row === undefined ? undefined : TaskRunSchema.parse(JSON.parse(row.data_json));
}
export function listTaskRuns(db: NoctisDatabase, taskId: string, limit = 50): TaskRun[] {
  return (
    db
      .prepare(
        "SELECT data_json FROM task_runs WHERE task_id=? ORDER BY started_at DESC,id DESC LIMIT ?",
      )
      .all(taskId, limit) as { data_json: string }[]
  ).map((row) => TaskRunSchema.parse(JSON.parse(row.data_json)));
}
function saveTask(db: NoctisDatabase, task: ScheduledTask): void {
  db.prepare("UPDATE scheduled_tasks SET data_json=? WHERE id=?").run(
    JSON.stringify(ScheduledTaskSchema.parse(task)),
    task.id,
  );
}
function saveRun(db: NoctisDatabase, run: TaskRun): void {
  db.prepare("UPDATE task_runs SET data_json=?,status=? WHERE id=?").run(
    JSON.stringify(TaskRunSchema.parse(run)),
    run.status,
    run.id,
  );
}
function ownerOnly(context: CommandContext): Result<void> {
  return context.actorType === "user"
    ? ok(undefined)
    : conflict({
        kind: "authority_refused",
        requestId: context.correlationId,
        outcome: "deny",
        reasonCodes: ["task_owner_action_required"],
      });
}
function validateTask(
  kernel: Kernel,
  command: CreateTaskCommand | UpdateTaskCommand,
): Result<void> {
  const valid = validateTrigger(kernel, command.trigger);
  if (!valid.ok) return valid;
  const folder = sharedFolder(kernel.db, command.nodeId, command.rootGrantId, kernel.clock.now());
  if (folder === undefined || !folder.providers.includes(command.model.providerId))
    return conflict({
      kind: "unavailable",
      entity: "task",
      reason: "task_folder_or_provider_not_shared",
    });
  if (
    "identityId" in command &&
    command.identityId === "jester" &&
    command.model.providerId !== "hermes"
  )
    return conflict({ kind: "unavailable", entity: "task", reason: "jester_runs_on_hermes" });
  return ok(undefined);
}
export function createTask(
  kernel: Kernel,
  context: CommandContext,
  command: CreateTaskCommand,
): Result<ScheduledTask> {
  const id = kernel.ids.nextId();
  return runCommand(
    kernel,
    { scope: "task.create", key: command.idempotencyKey, resultId: id },
    (tx) => {
      const valid = validateTask(kernel, command);
      if (!valid.ok) return valid;
      const { idempotencyKey: _key, threadId: _source, ...fields } = command;
      void _key; void _source;
      const nextDueAt = nextTriggerAt(command.trigger, kernel.clock.now());
      const task = ScheduledTaskSchema.parse({
        ...fields,
        id,
        paused: true,
        consecutiveFailures: 0,
        revision: 0,
        createdAt: iso(kernel),
        updatedAt: iso(kernel),
        ...(nextDueAt === undefined ? {} : { nextDueAt }),
      });
      tx.prepare("INSERT INTO scheduled_tasks(id,data_json) VALUES (?,?)").run(
        id,
        JSON.stringify(task),
      );
      return ok({ value: task, events: [event(kernel, context, id, "task.created.v1", task)] });
    },
  );
}
function mutateTask(
  kernel: Kernel,
  context: CommandContext,
  command: { idempotencyKey: string; taskId: string; expectedRevision: number },
  scope: string,
  type: EventName,
  change: (task: ScheduledTask) => Result<ScheduledTask>,
  remove = false,
): Result<ScheduledTask> {
  return runCommand(
    kernel,
    { scope, key: command.idempotencyKey, resultId: command.taskId },
    (tx) => {
      const current = getTask(tx, command.taskId);
      if (current === undefined)
        return conflict({ kind: "not_found", entity: "task", id: command.taskId });
      if (current.revision !== command.expectedRevision)
        return conflict({
          kind: "revision_conflict",
          expected: command.expectedRevision,
          actual: current.revision,
        });
      const changed = change(current);
      if (!changed.ok) return changed;
      const task = ScheduledTaskSchema.parse({
        ...changed.value,
        revision: current.revision + 1,
        updatedAt: iso(kernel),
      });
      if (remove) {
        if (
          tx
            .prepare("SELECT id FROM task_runs WHERE task_id=? AND status='running'")
            .get(task.id) !== undefined
        )
          return conflict({
            kind: "unavailable",
            entity: "task",
            reason: "stop_the_running_task_before_deleting",
          });
        tx.prepare("DELETE FROM scheduled_tasks WHERE id=?").run(task.id);
        tx.prepare(
          "UPDATE standing_permissions SET revoked_at=?,revoked_reason='task deleted' WHERE task_id=? AND revoked_at IS NULL",
        ).run(iso(kernel), task.id);
      } else saveTask(tx, task);
      return ok({ value: task, events: [event(kernel, context, task.id, type, task)] });
    },
  );
}
export function updateTask(
  kernel: Kernel,
  context: CommandContext,
  command: UpdateTaskCommand,
): Result<ScheduledTask> {
  const owner = ownerOnly(context);
  if (!owner.ok) return owner;
  return mutateTask(kernel, context, command, "task.update", "task.updated.v1", (current) => {
    const valid = validateTask(kernel, command);
    if (!valid.ok) return valid;
    if (
      kernel.db
        .prepare("SELECT id FROM task_runs WHERE task_id=? AND status='running'")
        .get(current.id) !== undefined
    )
      return conflict({
        kind: "unavailable",
        entity: "task",
        reason: "pause_and_finish_the_current_run_before_editing",
      });
    if (current.identityId === "jester" && command.model.providerId !== "hermes")
      return conflict({ kind: "unavailable", entity: "task", reason: "jester_runs_on_hermes" });
    const { idempotencyKey: _key, taskId: _id, expectedRevision: _revision, ...fields } = command;
    const { nextDueAt: _due, threadId: _thread, proposedUpdate: _proposal, ...base } = current;
    void _key; void _id; void _revision; void _due; void _thread; void _proposal;
    const nextDueAt = nextTriggerAt(command.trigger, kernel.clock.now());
    // An edited instruction cannot inherit unattended permissions for its old meaning.
    kernel.db
      .prepare(
        "UPDATE standing_permissions SET revoked_at=?,revoked_reason='task edited' WHERE task_id=? AND revoked_at IS NULL",
      )
      .run(iso(kernel), current.id);
    return ok({
      ...base,
      ...fields,
      consecutiveFailures: 0,
      ...(nextDueAt === undefined ? {} : { nextDueAt }),
    });
  });
}
export function proposeTaskUpdate(
  kernel: Kernel,
  context: CommandContext,
  command: TaskProposedUpdate & { taskId: string; idempotencyKey: string },
): Result<ScheduledTask> {
  return runCommand<ScheduledTask>(
    kernel,
    { scope: "task.propose_update", key: command.idempotencyKey, resultId: command.taskId },
    (tx) => {
      const task = getTask(tx, command.taskId);
      if (task === undefined)
        return conflict({ kind: "not_found", entity: "task", id: command.taskId });
      if (context.actorType !== "identity" || context.actorId !== task.identityId)
        return conflict({
          kind: "authority_refused",
          requestId: context.correlationId,
          outcome: "deny",
          reasonCodes: ["task_identity_mismatch"],
        });
      const { taskId: _id, idempotencyKey: _key, ...fields } = command;
      void _id; void _key;
      const proposedUpdate = TaskProposedUpdateSchema.parse(fields);
      const valid = validateTask(kernel, {
        ...proposedUpdate,
        identityId: task.identityId,
        idempotencyKey: command.idempotencyKey,
      });
      if (!valid.ok) return valid;
      const updated = {
        ...task,
        proposedUpdate,
        revision: task.revision + 1,
        updatedAt: iso(kernel),
      };
      saveTask(tx, updated);
      return ok({
        value: updated,
        events: [event(kernel, context, task.id, "task.change_proposed.v1", updated)],
      });
    },
  );
}
export function pauseTask(
  kernel: Kernel,
  context: CommandContext,
  command: PauseTaskCommand,
): Result<ScheduledTask> {
  return mutateTask(kernel, context, command, "task.pause", "task.paused.v1", (task) =>
    ok({ ...task, paused: true }),
  );
}
export function resumeTask(
  kernel: Kernel,
  context: CommandContext,
  command: ResumeTaskCommand,
): Result<ScheduledTask> {
  const owner = ownerOnly(context);
  if (!owner.ok) return owner;
  return mutateTask(kernel, context, command, "task.resume", "task.resumed.v1", (task) => {
    const folder = sharedFolder(kernel.db, task.nodeId, task.rootGrantId, kernel.clock.now());
    if (folder === undefined || !folder.providers.includes(task.model.providerId))
      return conflict({
        kind: "unavailable",
        entity: "task",
        reason: "task_folder_or_provider_not_shared",
      });
    const nextDueAt = task.nextDueAt ?? nextTriggerAt(task.trigger, kernel.clock.now());
    return ok({
      ...task,
      paused: false,
      consecutiveFailures: 0,
      ...(nextDueAt === undefined ? {} : { nextDueAt }),
    });
  });
}
export function deleteTask(
  kernel: Kernel,
  context: CommandContext,
  command: DeleteTaskCommand,
): Result<ScheduledTask> {
  const owner = ownerOnly(context);
  if (!owner.ok) return owner;
  return mutateTask(
    kernel,
    context,
    command,
    "task.delete",
    "task.deleted.v1",
    (task) => ok(task),
    true,
  );
}

export function runTaskNow(
  kernel: Kernel,
  context: CommandContext,
  command: RunTaskNowCommand,
  deps: TaskExecutionDeps,
): Result<TaskRun> {
  if (!deps.enabled)
    return conflict({ kind: "unavailable", entity: "task", reason: "scheduled_tasks_disabled" });
  const id = kernel.ids.nextId();
  const reserved = runCommand<TaskRun>(
    kernel,
    { scope: "task.run_now", key: command.idempotencyKey, resultId: id },
    (tx) => {
      const task = getTask(tx, command.taskId);
      if (task === undefined)
        return conflict({ kind: "not_found", entity: "task", id: command.taskId });
      if (task.revision !== command.expectedRevision)
        return conflict({
          kind: "revision_conflict",
          expected: command.expectedRevision,
          actual: task.revision,
        });
      let reason: string | undefined;
      if (task.paused) reason = "paused";
      else if (
        tx.prepare("SELECT id FROM task_runs WHERE task_id=? AND status='running'").get(task.id) !==
        undefined
      )
        reason = "previous_run_still_going";
      else if (
        tx
          .prepare("SELECT id FROM task_runs WHERE node_id=? AND status='running'")
          .get(task.nodeId) !== undefined
      )
        reason = "pc_busy";
      else if (!deps.dispatcher.isConnected(task.nodeId)) reason = "pc_offline";
      else if (
        task.trigger?.kind === "at_pc" &&
        tx
          .prepare("SELECT node_id FROM node_owner_presence WHERE node_id=? AND present=1")
          .get(task.trigger.nodeId) === undefined
      )
        reason = "owner_not_present";
      const run: TaskRun = {
        id,
        taskId: task.id,
        startedAt: iso(kernel),
        status: reason === undefined ? "running" : "skipped",
        ...(reason === undefined ? {} : { reason, completedAt: iso(kernel) }),
      };
      if (reason === undefined) {
        const thread =
          task.threadMode === "continue" && task.threadId !== undefined
            ? task.threadId
            : createNamedThread(
                tx,
                kernel,
                {
                  identityId: task.identityId,
                  title: task.name,
                  nodeId: task.nodeId,
                  rootGrantId: task.rootGrantId,
                  providerId: task.model.providerId,
                },
                iso(kernel),
              ).id;
        run.threadId = thread;
        const nextDueAt =
          task.trigger?.kind === "repeat"
            ? task.nextDueAt !== undefined && Date.parse(task.nextDueAt) > kernel.clock.now()
              ? task.nextDueAt
              : nextTriggerAt(
                  task.trigger,
                  Date.parse(
                    latestTriggerAt(
                      task.trigger,
                      task.nextDueAt ?? iso(kernel),
                      kernel.clock.now(),
                    ),
                  ),
                )
            : undefined;
        const { nextDueAt: _due, ...base } = task;
      void _due;
        saveTask(tx, {
          ...base,
          threadId: thread,
          paused:
            task.trigger?.kind === "at" || (task.trigger?.kind === "at_pc" && !task.trigger.repeat),
          revision: task.revision + 1,
          updatedAt: iso(kernel),
          ...(nextDueAt === undefined ? {} : { nextDueAt }),
        });
      }
      tx.prepare(
        "INSERT INTO task_runs(id,task_id,node_id,status,started_at,data_json) VALUES (?,?,?,?,?,?)",
      ).run(id, task.id, task.nodeId, run.status, run.startedAt, JSON.stringify(run));
      return ok({
        value: run,
        events: [
          event(
            kernel,
            context,
            task.id,
            reason === undefined ? "task.run_started.v1" : "task.run_skipped.v1",
            run,
          ),
        ],
      });
    },
  );
  if (!reserved.ok || reserved.value.status !== "running") return reserved;
  const task = getTask(kernel.db, command.taskId)!;
  const sent = deps.conversation.sendMessage(
    { correlationId: context.correlationId, actorType: "identity", actorId: task.identityId },
    {
      idempotencyKey: `task-run:${id}`,
      identityId: task.identityId,
      text: task.prompt,
      threadId: reserved.value.threadId!,
      model: task.model,
      rootGrantId: task.rootGrantId,
    },
  );
  if (!sent.ok) {
    finishRun(
      kernel,
      reserved.value,
      "failed",
      sent.conflict.kind === "unavailable" ? sent.conflict.reason : sent.conflict.kind,
    );
    return ok(getTaskRun(kernel.db, id)!);
  }
  const attached = runCommand(
    kernel,
    { scope: "task.attach_turn", key: id, resultId: id },
    (tx) => {
      const run = { ...reserved.value, turnId: sent.value.id };
      saveRun(tx, run);
      return ok({ value: run, events: [] });
    },
  );
  if (sent.value.status === "failed")
    finishRun(
      kernel,
      { ...reserved.value, turnId: sent.value.id },
      "failed",
      sent.value.failureReason,
    );
  return attached.ok ? ok(getTaskRun(kernel.db, id)!) : attached;
}
function finishRun(kernel: Kernel, run: TaskRun, status: TaskRun["status"], reason?: string): void {
  runCommand<TaskRun>(kernel, { scope: "task.finish", key: run.id, resultId: run.id }, (tx) => {
    const current = getTaskRun(tx, run.id);
    const task = getTask(tx, run.taskId);
    if (current === undefined || task === undefined)
      return conflict({ kind: "not_found", entity: "task_run", id: run.id });
    if (current.status !== "running") return ok({ value: current, events: [] });
    const turn = run.turnId === undefined ? undefined : getTurn(tx, run.turnId);
    const reply =
      turn?.replyMessageId === undefined
        ? undefined
        : listMessages(tx, turn.threadId, 200).find((message) => message.id === turn.replyMessageId)
            ?.body;
    const finished: TaskRun = {
      ...current,
      status,
      completedAt: iso(kernel),
      ...(reason === undefined ? {} : { reason }),
      ...(reply === undefined ? {} : { result: reply.slice(0, 20_000) }),
    };
    saveRun(tx, finished);
    const failures =
      status === "failed"
        ? task.consecutiveFailures + 1
        : status === "completed"
          ? 0
          : task.consecutiveFailures;
    const updated = {
      ...task,
      consecutiveFailures: failures,
      paused: task.paused || failures >= 3,
      revision: task.revision + 1,
      updatedAt: iso(kernel),
    };
    saveTask(tx, updated);
    return ok({
      value: finished,
      events: [
        event(kernel, system(kernel), task.id, "task.run_completed.v1", {
          ...finished,
          name: task.name,
          identityId: task.identityId,
        }),
        ...(failures >= 3 && !task.paused
          ? [event(kernel, system(kernel), task.id, "task.paused.v1", updated)]
          : []),
      ],
    });
  });
}

export interface ProductivityScheduler {
  pass(): void;
  close(): void;
}
export function createProductivityScheduler(
  kernel: Kernel,
  deps: TaskExecutionDeps,
  options: { recover?: boolean } = {},
): ProductivityScheduler {
  if (options.recover === true) {
    for (const row of kernel.db
      .prepare("SELECT data_json FROM task_runs WHERE status='running'")
      .all() as { data_json: string }[]) {
      const run = TaskRunSchema.parse(JSON.parse(row.data_json));
      const turn = run.turnId === undefined ? undefined : getTurn(kernel.db, run.turnId);
      finishRun(kernel, run, "failed", "core_restarted");
      if (turn?.jobId !== undefined)
        deps.conversation.cancelTurn(system(kernel), {
          idempotencyKey: `task-restart:${run.id}`,
          jobId: turn.jobId,
        });
    }
  }
  let passing = false;
  function pass(): void {
    if (passing) return;
    passing = true;
    try {
      for (const reminder of listReminders(kernel.db, -1)) {
        if (
          reminder.status === "done" ||
          reminder.nextDueAt === undefined ||
          Date.parse(reminder.nextDueAt) > kernel.clock.now()
        )
          continue;
        const latest = latestTriggerAt(reminder.trigger, reminder.nextDueAt, kernel.clock.now());
        const nextDueAt =
          reminder.trigger?.kind === "repeat"
            ? nextTriggerAt(reminder.trigger, Date.parse(latest))
            : undefined;
        markReminderDue(kernel, system(kernel), {
          idempotencyKey: `timer:${reminder.id}:${reminder.nextDueAt}`,
          reminderId: reminder.id,
          expectedRevision: reminder.revision,
          ...(nextDueAt === undefined ? {} : { nextDueAt }),
        });
      }
      for (const row of kernel.db
        .prepare("SELECT data_json FROM task_runs WHERE status='running'")
        .all() as { data_json: string }[]) {
        const run = TaskRunSchema.parse(JSON.parse(row.data_json));
        const task = getTask(kernel.db, run.taskId)!;
        const turn = run.turnId === undefined ? undefined : getTurn(kernel.db, run.turnId);
        const waiting =
          turn?.jobId === undefined
            ? undefined
            : kernel.db
                .prepare(
                  `SELECT id FROM approvals WHERE task_id=? AND node_job_id=? AND confirmed_at IS NULL
           AND outcome IN ('require_confirmation','require_typed_confirmation')
           AND (declined_at IS NULL OR declined_by='system') LIMIT 1`,
                )
                .get(task.id, turn.jobId);
        if (
          turn?.status === "completed" ||
          turn?.status === "failed" ||
          turn?.status === "cancelled"
        )
          finishRun(
            kernel,
            run,
            waiting !== undefined
              ? "needs_you"
              : turn.status === "completed"
                ? "completed"
                : "failed",
            turn.failureReason,
          );
        else if (kernel.clock.now() - Date.parse(run.startedAt) >= task.maxRunMinutes * 60_000) {
          // Mark first: cancellation also publishes a terminal turn event.
          finishRun(
            kernel,
            run,
            waiting === undefined ? "failed" : "needs_you",
            waiting === undefined ? "maximum_run_time" : "approval_timeout",
          );
          if (turn?.jobId !== undefined)
            deps.conversation.cancelTurn(system(kernel), {
              idempotencyKey: `task-timeout:${run.id}`,
              jobId: turn.jobId,
            });
        }
      }
      if (!deps.enabled) return;
      for (const task of listTasks(kernel.db, -1)) {
        if (
          task.paused ||
          task.nextDueAt === undefined ||
          Date.parse(task.nextDueAt) > kernel.clock.now()
        )
          continue;
        const due = latestTriggerAt(task.trigger, task.nextDueAt, kernel.clock.now());
        if (kernel.clock.now() - Date.parse(due) > 24 * 3_600_000) {
          skipExpired(task, due);
          continue;
        }
        const busy = kernel.db
          .prepare("SELECT id FROM task_runs WHERE node_id=? AND status='running'")
          .get(task.nodeId) as { id: string } | undefined;
        const readiness = `${deps.dispatcher.isConnected(task.nodeId) ? "online" : "offline"}:${busy?.id ?? "idle"}`;
        runTaskNow(
          kernel,
          system(kernel),
          {
            idempotencyKey: `timer:${task.id}:${due}:${readiness}`,
            taskId: task.id,
            expectedRevision: task.revision,
          },
          deps,
        );
      }
    } finally {
      passing = false;
    }
  }
  function advanceSkipped(task: ScheduledTask, due: string): void {
    runCommand(
      kernel,
      { scope: "task.advance", key: `${task.id}:${task.nextDueAt ?? due}`, resultId: task.id },
      (tx) => {
        const current = getTask(tx, task.id)!;
        const { nextDueAt: _due, ...base } = current;
        void _due;
        const nextDueAt =
          current.trigger?.kind === "repeat"
            ? nextTriggerAt(current.trigger, Date.parse(due))
            : undefined;
        saveTask(tx, {
          ...base,
          paused: current.trigger?.kind !== "repeat",
          revision: current.revision + 1,
          updatedAt: iso(kernel),
          ...(nextDueAt === undefined ? {} : { nextDueAt }),
        });
        return ok({ value: current, events: [] });
      },
    );
  }
  function skipExpired(task: ScheduledTask, due: string): void {
    const id = kernel.ids.nextId();
    runCommand(kernel, { scope: "task.expired", key: `${task.id}:${due}`, resultId: id }, (tx) => {
      const run: TaskRun = {
        id,
        taskId: task.id,
        status: "skipped",
        reason: "missed_more_than_a_day",
        startedAt: iso(kernel),
        completedAt: iso(kernel),
      };
      tx.prepare(
        "INSERT INTO task_runs(id,task_id,node_id,status,started_at,data_json) VALUES (?,?,?,?,?,?)",
      ).run(id, task.id, task.nodeId, run.status, run.startedAt, JSON.stringify(run));
      return ok({
        value: run,
        events: [event(kernel, system(kernel), task.id, "task.run_skipped.v1", run)],
      });
    });
    advanceSkipped(task, due);
  }
  const unsubscribe = kernel.broker.subscribe((events) => {
    for (const e of events) {
      if (e.type !== "node.owner_present.v1") continue;
      const payload = e.payload as { nodeId: string; present: boolean };
      if (!payload.present) continue;
      for (const reminder of listReminders(kernel.db, -1)) {
        if (reminder.status === "snoozed" && reminder.snoozedUntilPcId === payload.nodeId) {
          const nextDueAt =
            reminder.trigger?.kind === "repeat"
              ? nextTriggerAt(reminder.trigger, kernel.clock.now())
              : undefined;
          markReminderDue(kernel, system(kernel), {
            idempotencyKey: `presence-snooze:${reminder.id}:${e.id}`,
            reminderId: reminder.id,
            expectedRevision: reminder.revision,
            ...(nextDueAt === undefined ? {} : { nextDueAt }),
          });
          continue;
        }
        if (
          reminder.trigger?.kind !== "at_pc" ||
          reminder.trigger.nodeId !== payload.nodeId ||
          reminder.status === "done" ||
          reminder.status === "snoozed" ||
          (reminder.status === "due" && !reminder.trigger.repeat)
        )
          continue;
        markReminderDue(kernel, system(kernel), {
          idempotencyKey: `presence:${reminder.id}:${e.id}`,
          reminderId: reminder.id,
          expectedRevision: reminder.revision,
        });
      }
      if (!deps.enabled) continue;
      for (const task of listTasks(kernel.db, -1)) {
        if (task.paused || task.trigger?.kind !== "at_pc" || task.trigger.nodeId !== payload.nodeId)
          continue;
        runTaskNow(
          kernel,
          system(kernel),
          {
            idempotencyKey: `presence:${task.id}:${e.id}`,
            taskId: task.id,
            expectedRevision: task.revision,
          },
          deps,
        );
      }
    }
  });
  return { pass, close: unsubscribe };
}
