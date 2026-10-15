import { fileURLToPath } from "node:url";
import { CreateTaskCommandSchema } from "@noctis/contracts";
import { createIdFactory } from "@noctis/domain";
import { afterEach, describe, expect, it } from "vitest";
import { createConversationService, getTurn } from "../conversation/service.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import { createLiveBroker } from "../events/live.js";
import type { Kernel } from "../kernel.js";
import { createLogger } from "../logging.js";
import { createDispatcher } from "../nodes/dispatch.js";
import { connectNode, grantCapability, issuePairingCode, pairNode } from "../nodes/registry.js";
import { createRuntimeFrameHub } from "../nodes/runtime-frames.js";
import { completeJob, getJob } from "../nodes/jobs.js";
import { listConversations } from "../conversation/threads.js";
import {
  createTask,
  getTask,
  listTaskRuns,
  pauseTask,
  resumeTask,
  runTaskNow,
  updateTask,
  createProductivityScheduler,
  proposeTaskUpdate,
} from "./tasks.js";
import { createReminder, getReminder, completeReminder, snoozeReminder } from "./service.js";
import { grantStandingPermission, requestAuthority, getApproval } from "../authority/service.js";

const START = Date.parse("2026-10-14T10:00:00Z");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function fixture() {
  let now = START;
  const clock = { now: () => now };
  const db = openDatabase(":memory:");
  migrate(db, { clock, directory: fileURLToPath(new URL("../../migrations/", import.meta.url)) });
  const kernel: Kernel = {
    db,
    clock,
    ids: createIdFactory(clock),
    broker: createEventBroker(),
    logger: createLogger({ level: "error", sink: () => undefined }),
  };
  const context = {
    correlationId: kernel.ids.nextId(),
    actorType: "user" as const,
    actorId: "owner",
  };
  const dispatcher = createDispatcher({ kernel });
  const conversation = createConversationService({
    kernel,
    dispatcher,
    live: createLiveBroker(),
    runtimeFrames: createRuntimeFrameHub(),
  });
  const code = issuePairingCode(kernel, context, { idempotencyKey: "pair-code", hostId: "home" });
  if (!code.ok) throw new Error("pairing fixture");
  const paired = pairNode(
    kernel,
    context,
    { code: code.value.code, hostId: "home", fingerprint: "fake", agentVersion: "test" },
    "0".repeat(32),
  );
  if (!paired.ok) throw new Error("pairing fixture");
  const nodeId = paired.value.nodeId;
  grantCapability(kernel, context, {
    idempotencyKey: "runtime-grant",
    nodeId,
    capability: "runtime.turn",
    constraints: {
      providers: ["codex"],
      roots: [{ grantId: "repo", path: "C:/fixture", mode: "write", localOnly: false }],
    },
  });
  connectNode(
    kernel,
    context,
    {
      nodeId,
      connectionId: "fixture",
      agentVersion: "test",
      providers: [
        {
          providerId: "codex",
          available: true,
          authMode: "chatgpt",
          models: [{ providerId: "codex", model: "fake" }],
        },
      ],
    },
    "0".repeat(32),
  );
  dispatcher.register({
    nodeId,
    connectionId: "fixture",
    credential: paired.value.credential,
    send: () => undefined,
    close: () => undefined,
    sendGrants: () => undefined,
  });
  const deps = { conversation, dispatcher, enabled: true };
  cleanups.push(() => {
    conversation.close();
    dispatcher.stop();
    db.close();
  });
  const command = CreateTaskCommandSchema.parse({
    idempotencyKey: "task",
    name: "Check repo",
    prompt: "List the files",
    identityId: "vesper",
    model: { providerId: "codex", model: "fake" },
    nodeId,
    rootGrantId: "repo",
    trigger: { kind: "repeat", rule: { kind: "interval", hours: 1 } },
  });
  const created = createTask(kernel, context, command);
  if (!created.ok) throw new Error("task fixture creation failed");
  return {
    kernel,
    context,
    nodeId,
    deps,
    command,
    task: created.value,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("scheduled tasks and shared reminder firing", () => {
  it("creates paused and refuses model activation or editing; permits safe model pause", () => {
    const f = fixture();
    expect(f.task.paused).toBe(true);
    const model = { ...f.context, actorType: "identity" as const, actorId: "vesper" };
    expect(
      resumeTask(f.kernel, model, {
        idempotencyKey: "agent-on",
        taskId: f.task.id,
        expectedRevision: 0,
      }).ok,
    ).toBe(false);
    const active = resumeTask(f.kernel, f.context, {
      idempotencyKey: "on",
      taskId: f.task.id,
      expectedRevision: 0,
    });
    expect(active.ok).toBe(true);
    expect(
      updateTask(f.kernel, model, {
        ...f.command,
        idempotencyKey: "agent-edit",
        taskId: f.task.id,
        expectedRevision: 1,
      }).ok,
    ).toBe(false);
    expect(
      pauseTask(f.kernel, model, {
        idempotencyKey: "agent-stop",
        taskId: f.task.id,
        expectedRevision: 1,
      }).ok,
    ).toBe(true);
  });
  it("dispatches a pinned thread once, prevents overlap per task and PC, and replays safely", () => {
    const f = fixture();
    resumeTask(f.kernel, f.context, {
      idempotencyKey: "on",
      taskId: f.task.id,
      expectedRevision: 0,
    });
    const first = runTaskNow(
      f.kernel,
      f.context,
      { idempotencyKey: "run", taskId: f.task.id, expectedRevision: 1 },
      f.deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const turn = getTurn(f.kernel.db, first.value.turnId!);
    expect(turn?.nodeId).toBe(f.nodeId);
    expect(getJob(f.kernel.db,turn!.jobId!)?.job.payload).toMatchObject({scheduledTaskId:f.task.id});
    expect(
      runTaskNow(
        f.kernel,
        f.context,
        { idempotencyKey: "run", taskId: f.task.id, expectedRevision: 1 },
        f.deps,
      ),
    ).toMatchObject({ ok: false, conflict: { kind: "idempotent_replay" } });
    const second = runTaskNow(
      f.kernel,
      f.context,
      {
        idempotencyKey: "run2",
        taskId: f.task.id,
        expectedRevision: getTask(f.kernel.db, f.task.id)!.revision,
      },
      f.deps,
    );
    expect(second).toMatchObject({
      ok: true,
      value: { status: "skipped", reason: "previous_run_still_going" },
    });
    const other = createTask(f.kernel, f.context, {
      ...f.command,
      idempotencyKey: "other",
      name: "Other",
    });
    if (!other.ok) throw Error("other");
    resumeTask(f.kernel, f.context, {
      idempotencyKey: "on2",
      taskId: other.value.id,
      expectedRevision: 0,
    });
    expect(
      runTaskNow(
        f.kernel,
        f.context,
        { idempotencyKey: "run3", taskId: other.value.id, expectedRevision: 1 },
        f.deps,
      ),
    ).toMatchObject({ ok: true, value: { status: "skipped", reason: "pc_busy" } });
  });
  it("keeps production execution default-off and records offline skips", () => {
    const f = fixture();
    resumeTask(f.kernel, f.context, {
      idempotencyKey: "on",
      taskId: f.task.id,
      expectedRevision: 0,
    });
    expect(
      runTaskNow(
        f.kernel,
        f.context,
        { idempotencyKey: "disabled", taskId: f.task.id, expectedRevision: 1 },
        { ...f.deps, enabled: false },
      ),
    ).toMatchObject({
      ok: false,
      conflict: { kind: "unavailable", reason: "scheduled_tasks_disabled" },
    });
    expect(
      runTaskNow(
        f.kernel,
        f.context,
        { idempotencyKey: "offline", taskId: f.task.id, expectedRevision: 1 },
        { ...f.deps, dispatcher: { ...f.deps.dispatcher, isConnected: () => false } },
      ),
    ).toMatchObject({ ok: true, value: { status: "skipped", reason: "pc_offline" } });
  });
  it("fires reminders once, preserves repeating series and snoozes with a movable clock", () => {
    const f = fixture();
    const scheduler = createProductivityScheduler(f.kernel, { ...f.deps, enabled: false });
    cleanups.unshift(() => scheduler.close());
    const reminder = createReminder(f.kernel, f.context, {
      idempotencyKey: "reminder",
      identityId: "vesper",
      text: "Take a break",
      trigger: { kind: "repeat", rule: { kind: "interval", hours: 1 } },
    });
    if (!reminder.ok) throw Error("reminder");
    f.advance(4 * 3_600_000);
    scheduler.pass();
    scheduler.pass();
    const due = getReminder(f.kernel.db, reminder.value.id)!;
    expect(due.status).toBe("due");
    expect(due.revision).toBe(1);
    expect(due.nextDueAt).toBe("2026-10-14T15:00:00.000Z");
    const snoozed = snoozeReminder(f.kernel, f.context, {
      idempotencyKey: "snooze",
      reminderId: due.id,
      expectedRevision: 1,
      until: "2026-10-14T14:30:00.000Z",
    });
    expect(snoozed.ok).toBe(true);
    f.advance(30 * 60_000);
    scheduler.pass();
    const again = getReminder(f.kernel.db, due.id)!;
    expect(again.status).toBe("due");
    expect(
      completeReminder(f.kernel, f.context, {
        idempotencyKey: "done",
        reminderId: due.id,
        expectedRevision: again.revision,
      }),
    ).toMatchObject({ ok: true, value: { status: "pending" } });
  });
  it("catches up one recent run, advances cadence and stops timed-out work", () => {
    const f = fixture();
    resumeTask(f.kernel, f.context, {
      idempotencyKey: "on",
      taskId: f.task.id,
      expectedRevision: 0,
    });
    const scheduler = createProductivityScheduler(f.kernel, f.deps);
    cleanups.unshift(() => scheduler.close());
    f.advance(5 * 3_600_000);
    scheduler.pass();
    scheduler.pass();
    expect(listTaskRuns(f.kernel.db, f.task.id).filter((r) => r.status === "running")).toHaveLength(
      1,
    );
    expect(getTask(f.kernel.db, f.task.id)!.nextDueAt).toBe("2026-10-14T16:00:00.000Z");
    f.advance(31 * 60_000);
    scheduler.pass();
    expect(listTaskRuns(f.kernel.db, f.task.id)[0]).toMatchObject({
      status: "failed",
      reason: "maximum_run_time",
    });
  });
  it("pauses after three failures and preserves run results", () => {
    const f = fixture();
    resumeTask(f.kernel, f.context, {
      idempotencyKey: "on",
      taskId: f.task.id,
      expectedRevision: 0,
    });
    const scheduler = createProductivityScheduler(f.kernel, f.deps);
    cleanups.unshift(() => scheduler.close());
    for (let i = 0; i < 3; i++) {
      const task = getTask(f.kernel.db, f.task.id)!;
      runTaskNow(
        f.kernel,
        f.context,
        { idempotencyKey: `run-${i}`, taskId: task.id, expectedRevision: task.revision },
        f.deps,
      );
      f.advance(31 * 60_000);
      scheduler.pass();
    }
    expect(getTask(f.kernel.db, f.task.id)).toMatchObject({ paused: true, consecutiveFailures: 3 });
    expect(listTaskRuns(f.kernel.db, f.task.id).filter((r) => r.status === "failed")).toHaveLength(
      3,
    );
  });
  it("derives approval task scope from its real job, persists exact permissions, and times out as needs you", () => {
    const f = fixture();
    resumeTask(f.kernel, f.context, {
      idempotencyKey: "on",
      taskId: f.task.id,
      expectedRevision: 0,
    });
    const run = runTaskNow(
      f.kernel,
      f.context,
      { idempotencyKey: "run", taskId: f.task.id, expectedRevision: 1 },
      f.deps,
    );
    if (!run.ok) throw Error("run");
    const turn = getTurn(f.kernel.db, run.value.turnId!)!;
    const ask = requestAuthority(
      f.kernel,
      { ...f.context, actorType: "identity", actorId: "vesper" },
      {
        idempotencyKey: "ask",
        actorId: "vesper",
        operationClass: "publish",
        capability: "git.push",
        target: { type: "repository", id: "repo" },
        consequenceSummary: "Push changes",
        reversibility: "partially_reversible",
        nodeJobId: turn.jobId!,
        askedByRuntime: true,
      },
    );
    expect(ask.ok).toBe(true);
    if (!ask.ok) return;
    expect(getApproval(f.kernel.db, ask.value.requestId)?.taskId).toBe(f.task.id);
    const grant = grantStandingPermission(f.kernel, f.context, {
      idempotencyKey: "grant",
      taskId: f.task.id,
      actorId: "vesper",
      operationClass: "publish",
      capability: "git.push",
      constraints: { targetType: "repository", targetIds: ["repo"] },
    });
    expect(grant).toMatchObject({ ok: true, value: { taskId: f.task.id } });
    const granted = requestAuthority(f.kernel, f.context, {
      idempotencyKey: "ask2",
      actorId: "vesper",
      operationClass: "publish",
      capability: "git.push",
      target: { type: "repository", id: "repo" },
      consequenceSummary: "Push changes",
      reversibility: "partially_reversible",
      nodeJobId: turn.jobId!,
      askedByRuntime: true,
    });
    expect(granted).toMatchObject({ ok: true, value: { outcome: "allow" } });
    const scheduler = createProductivityScheduler(f.kernel, f.deps);
    cleanups.unshift(() => scheduler.close());
    f.advance(31 * 60_000);
    scheduler.pass();
    expect(listTaskRuns(f.kernel.db, f.task.id)[0]).toMatchObject({
      status: "needs_you",
      reason: "approval_timeout",
    });
  });
  it("rejects permission grants from models and permissions for a foreign task identity", () => {
    const f = fixture();
    const command = {
      idempotencyKey: "grant",
      taskId: f.task.id,
      actorId: "vesper",
      operationClass: "publish" as const,
      capability: "git.push",
      constraints: { targetType: "repository", targetIds: ["repo"] },
    };
    expect(
      grantStandingPermission(
        f.kernel,
        { ...f.context, actorType: "identity", actorId: "vesper" },
        command,
      ).ok,
    ).toBe(false);
    expect(
      grantStandingPermission(f.kernel, f.context, {
        ...command,
        idempotencyKey: "foreign",
        actorId: "jester",
      }).ok,
    ).toBe(false);
  });
  it("does not leave a running reservation or job after core restart", () => {
    const f = fixture();
    resumeTask(f.kernel, f.context, {
      idempotencyKey: "on",
      taskId: f.task.id,
      expectedRevision: 0,
    });
    runTaskNow(
      f.kernel,
      f.context,
      { idempotencyKey: "run", taskId: f.task.id, expectedRevision: 1 },
      f.deps,
    );
    const scheduler = createProductivityScheduler(f.kernel, f.deps, { recover: true });
    cleanups.unshift(() => scheduler.close());
    expect(listTaskRuns(f.kernel.db, f.task.id)[0]).toMatchObject({
      status: "failed",
      reason: "core_restarted",
    });
    const run = listTaskRuns(f.kernel.db, f.task.id)[0]!;
    expect(getTurn(f.kernel.db, run.turnId!)?.status).toBe("cancelled");
  });
  it("only fires a PC reminder on owner presence edges and does not replay a one-shot", () => {
    const f = fixture();
    const scheduler = createProductivityScheduler(f.kernel, { ...f.deps, enabled: false });
    cleanups.unshift(() => scheduler.close());
    const reminder = createReminder(f.kernel, f.context, {
      idempotencyKey: "pc",
      identityId: "vesper",
      text: "At home",
      trigger: { kind: "at_pc", nodeId: f.nodeId, repeat: false },
    });
    if (!reminder.ok) throw Error("reminder");
    expect(getReminder(f.kernel.db, reminder.value.id)?.status).toBe("pending");
    const signal = (present: boolean) =>
      f.kernel.broker.publish([
        {
          id: f.kernel.ids.nextId(),
          sequence: 1,
          streamType: "node",
          streamId: f.nodeId,
          type: "node.owner_present.v1",
          actorType: "node",
          actorId: f.nodeId,
          payloadVersion: 1,
          payload: { nodeId: f.nodeId, present },
          correlationId: f.context.correlationId,
          occurredAt: new Date(f.kernel.clock.now()).toISOString(),
        },
      ]);
    signal(false);
    expect(getReminder(f.kernel.db, reminder.value.id)?.status).toBe("pending");
    signal(true);
    signal(true);
    expect(getReminder(f.kernel.db, reminder.value.id)?.revision).toBe(1);
  });
  it("preserves the scheduled time when the owner runs a repeating task early", () => {
    const f = fixture();
    resumeTask(f.kernel, f.context, {
      idempotencyKey: "on",
      taskId: f.task.id,
      expectedRevision: 0,
    });
    runTaskNow(
      f.kernel,
      f.context,
      { idempotencyKey: "early", taskId: f.task.id, expectedRevision: 1 },
      f.deps,
    );
    expect(getTask(f.kernel.db, f.task.id)?.nextDueAt).toBe("2026-10-14T11:00:00.000Z");
  });
  it("consumes a next-PC snooze without changing the original repeating schedule", () => {
    const f = fixture();
    const scheduler = createProductivityScheduler(f.kernel, { ...f.deps, enabled: false });
    cleanups.unshift(() => scheduler.close());
    const reminder = createReminder(f.kernel, f.context, {
      idempotencyKey: "remind",
      identityId: "vesper",
      text: "Later at home",
      trigger: { kind: "repeat", rule: { kind: "interval", hours: 2 } },
    });
    if (!reminder.ok) throw Error("reminder");
    snoozeReminder(f.kernel, f.context, {
      idempotencyKey: "pc-snooze",
      reminderId: reminder.value.id,
      expectedRevision: 0,
      atPcNodeId: f.nodeId,
    });
    f.kernel.broker.publish([
      {
        id: f.kernel.ids.nextId(),
        sequence: 1,
        streamType: "node",
        streamId: f.nodeId,
        type: "node.owner_present.v1",
        actorType: "node",
        actorId: f.nodeId,
        payloadVersion: 1,
        payload: { nodeId: f.nodeId, present: true },
        correlationId: f.context.correlationId,
        occurredAt: new Date(f.kernel.clock.now()).toISOString(),
      },
    ]);
    expect(getReminder(f.kernel.db, reminder.value.id)).toMatchObject({
      status: "due",
      trigger: reminder.value.trigger,
      nextDueAt: "2026-10-14T12:00:00.000Z",
    });
    expect(getReminder(f.kernel.db, reminder.value.id)?.snoozedUntilPcId).toBeUndefined();
  });
  it("stores model edits as suggestions until the owner accepts the exact update", () => {
    const f = fixture();
    resumeTask(f.kernel, f.context, {
      idempotencyKey: "on",
      taskId: f.task.id,
      expectedRevision: 0,
    });
    const { identityId: _identity, idempotencyKey: _key, ...fields } = f.command;
    void _identity; void _key;
    const suggestion = {
      ...fields,
      name: "Suggested name",
      prompt: "Inspect a different folder",
      taskId: f.task.id,
      idempotencyKey: "suggest",
    };
    const model = { ...f.context, actorType: "identity" as const, actorId: "vesper" };
    expect(proposeTaskUpdate(f.kernel, model, suggestion)).toMatchObject({
      ok: true,
      value: {
        prompt: f.task.prompt,
        paused: false,
        proposedUpdate: { prompt: suggestion.prompt },
      },
    });
    const pending = getTask(f.kernel.db, f.task.id)!;
    expect(
      proposeTaskUpdate(
        f.kernel,
        { ...model, actorId: "jester" },
        { ...suggestion, idempotencyKey: "foreign" },
      ).ok,
    ).toBe(false);
    expect(
      updateTask(f.kernel, f.context, { ...suggestion, expectedRevision: pending.revision }),
    ).toMatchObject({ ok: true, value: { prompt: suggestion.prompt } });
    expect(getTask(f.kernel.db, f.task.id)?.proposedUpdate).toBeUndefined();
  });
  it("keeps an unanswered runtime approval as needs you when the runtime stops first", () => {
    const f = fixture();
    resumeTask(f.kernel, f.context, {
      idempotencyKey: "on",
      taskId: f.task.id,
      expectedRevision: 0,
    });
    const scheduler = createProductivityScheduler(f.kernel, f.deps);
    cleanups.unshift(() => scheduler.close());
    const run = runTaskNow(
      f.kernel,
      f.context,
      { idempotencyKey: "run", taskId: f.task.id, expectedRevision: 1 },
      f.deps,
    );
    if (!run.ok) throw Error("run");
    const turn = getTurn(f.kernel.db, run.value.turnId!)!;
    f.deps.conversation.onAsk(f.nodeId, turn.jobId!, {
      itemId:"publish-step",kind:"command",
      askId: f.kernel.ids.nextId(),
      operationClass: "publish",
      capability: "git.push",
      target: { type: "repository", id: "repo" },
      summary: "Publish changes",
      reversibility: "partially_reversible",
      askedBy: "runtime",
    });
    expect(
      completeJob(f.kernel, f.context, {
        jobId: turn.jobId!,
        nodeId: f.nodeId,
        outcome: "failed",
        evidence: null,
        failureReason: "approval_timeout",
      }).ok,
    ).toBe(true);
    scheduler.pass();
    expect(listTaskRuns(f.kernel.db, f.task.id)[0]).toMatchObject({ status: "needs_you" });
  });
  it("records the actual completed reply and reuses only the task's continuation thread", () => {
    const f = fixture();
    const { idempotencyKey: _key, identityId: _identity, ...fields } = f.command;
    void _key; void _identity;
    updateTask(f.kernel, f.context, {
      ...fields,
      threadMode: "continue",
      taskId: f.task.id,
      expectedRevision: 0,
      idempotencyKey: "edit",
    });
    resumeTask(f.kernel, f.context, {
      idempotencyKey: "on",
      taskId: f.task.id,
      expectedRevision: 1,
    });
    const scheduler = createProductivityScheduler(f.kernel, f.deps);
    cleanups.unshift(() => scheduler.close());
    const run = runTaskNow(
      f.kernel,
      f.context,
      { idempotencyKey: "run", taskId: f.task.id, expectedRevision: 2 },
      f.deps,
    );
    if (!run.ok) throw Error("run");
    const turn = getTurn(f.kernel.db, run.value.turnId!)!;
    f.deps.conversation.onStreamItem(f.nodeId, turn.jobId!, 1, {
      itemId: "answer",
      kind: "agent_message",
      status: "completed",
      text: "Three files changed.",
    });
    expect(
      completeJob(f.kernel, f.context, {
        jobId: turn.jobId!,
        nodeId: f.nodeId,
        outcome: "succeeded",
        evidence: {
          model: f.command.model,
          itemCount: 1,
          stoppedReason: "completed",
          finalText: "Three files changed.",
        },
      }).ok,
    ).toBe(true);
    scheduler.pass();
    expect(listTaskRuns(f.kernel.db, f.task.id)[0]).toMatchObject({
      status: "completed",
      result: "Three files changed.",
    });
    expect(listConversations(f.kernel.db,"vesper")).toContainEqual(expect.objectContaining({id:run.value.threadId,taskId:f.task.id,taskName:f.task.name}));
    const current = getTask(f.kernel.db, f.task.id)!;
    const next = runTaskNow(
      f.kernel,
      f.context,
      { idempotencyKey: "next", taskId: f.task.id, expectedRevision: current.revision },
      f.deps,
    );
    expect(next).toMatchObject({ ok: true, value: { threadId: run.value.threadId } });
  });
  it("catches up an offline one-shot when the PC returns within a day, with one skip receipt", () => {
    const f = fixture();
    let connected = false;
    const { idempotencyKey: _key, identityId: _identity, ...fields } = f.command;
    void _key; void _identity;
    updateTask(f.kernel, f.context, {
      ...fields,
      trigger: { kind: "at", at: "2026-10-14T10:01:00.000Z" },
      taskId: f.task.id,
      expectedRevision: 0,
      idempotencyKey: "edit",
    });
    resumeTask(f.kernel, f.context, {
      idempotencyKey: "on",
      taskId: f.task.id,
      expectedRevision: 1,
    });
    const scheduler = createProductivityScheduler(f.kernel, {
      ...f.deps,
      dispatcher: { ...f.deps.dispatcher, isConnected: () => connected },
    });
    cleanups.unshift(() => scheduler.close());
    f.advance(60_000);
    scheduler.pass();
    scheduler.pass();
    expect(listTaskRuns(f.kernel.db, f.task.id)).toHaveLength(1);
    expect(getTask(f.kernel.db, f.task.id)?.paused).toBe(false);
    connected = true;
    f.advance(60_000);
    scheduler.pass();
    expect(listTaskRuns(f.kernel.db, f.task.id)[0]).toMatchObject({ status: "running" });
    expect(getTask(f.kernel.db, f.task.id)?.paused).toBe(true);
  });
});
