import { afterEach, beforeEach, expect, it } from "vitest";
import { createIdFactory, fixedClock } from "@noctis/domain";
import type { RuntimeProposal } from "@noctis/contracts";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import { createLogger } from "../logging.js";
import type { Kernel } from "../kernel.js";
import type { Turn } from "./service.js";
import { applyProposal } from "./proposals.js";
import { listEdits } from "../vault/promote.js";
import { listReminders, listNotes } from "../productivity/service.js";
import { listTasks, resumeTask, getTask, listTaskRuns } from "../productivity/tasks.js";
import { createDispatcher } from "../nodes/dispatch.js";
import { issuePairingCode, pairNode, grantCapability } from "../nodes/registry.js";
let kernel: Kernel;
const context = {
  correlationId: "0199a000-0000-7000-8000-0000000000c1",
  actorType: "user" as const,
  actorId: "local",
};
const turn: Turn = {
  id: "0199a000-0000-7000-8000-000000000001",
  threadId: "0199a000-0000-7000-8000-000000000002",
  identityId: "jester",
  userMessageId: "0199a000-0000-7000-8000-000000000003",
  model: { providerId: "codex", model: "gpt-5.4" },
  status: "completed",
  items: [],
  startedAt: "2026-10-14T12:00:00Z",
};
beforeEach(() => {
  const clock = fixedClock(Date.parse("2026-10-14T12:00:00Z"));
  const db = openDatabase(":memory:");
  migrate(db, { directory: "apps/core/migrations", clock });
  kernel = {
    db,
    clock,
    ids: createIdFactory(clock),
    broker: createEventBroker(),
    logger: createLogger({ clock, sink: () => undefined }),
  };
});
afterEach(() => kernel.db.close());
it("captures reminders and notes with immutable source identity/thread provenance", () => {
  applyProposal(kernel, context, turn, { kind: "reminder", text: "Renew tax", trigger: null }, "r");
  applyProposal(kernel, context, turn, { kind: "note", title: "Idea", body: "Keep this" }, "n");
  expect(listReminders(kernel.db)).toMatchObject([
    { identityId: "jester", threadId: turn.threadId },
  ]);
  expect(listNotes(kernel.db)).toMatchObject([{ identityId: "jester", threadId: turn.threadId }]);
  expect(
    kernel.db
      .prepare("SELECT actor_type,actor_id FROM orchestration_events WHERE stream_type='reminder'")
      .get(),
  ).toMatchObject({ actor_type: "identity", actor_id: "jester" });
});
it("refuses invalid or forged productivity proposals without throwing or writes", () => {
  for (const proposal of [
    { kind: "reminder", text: "Bad", trigger: { kind: "at", at: "2020-01-01T00:00:00Z" } },
    { kind: "note", title: "Spoof", body: "No", identityId: "vesper" },
  ])
    expect(() =>
      applyProposal(kernel, context, turn, proposal as RuntimeProposal, "bad"),
    ).not.toThrow();
  expect(listReminders(kernel.db)).toEqual([]);
  expect(listNotes(kernel.db)).toEqual([]);
});
it("captures proposed tasks paused and refuses a model-supplied activation field", () => {
  const issued = issuePairingCode(kernel, context, {
    idempotencyKey: "pair-code",
    hostId: "fixture",
  });
  if (!issued.ok) throw Error("code");
  const paired = pairNode(
    kernel,
    context,
    { code: issued.value.code, hostId: "fixture", fingerprint: "test", agentVersion: "test" },
    "0".repeat(32),
  );
  if (!paired.ok) throw Error("pair");
  grantCapability(kernel, context, {
    idempotencyKey: "grant",
    nodeId: paired.value.nodeId,
    capability: "runtime.turn",
    constraints: {
      providers: ["codex"],
      roots: [{ grantId: "repo", path: "C:/fixture", mode: "write", localOnly: false }],
    },
  });
  const proposal = {
    kind: "task" as const,
    name: "Check repo",
    prompt: "List changes",
    model: { providerId: "codex" as const, model: "fake" },
    nodeId: paired.value.nodeId,
    rootGrantId: "repo",
    trigger: { kind: "repeat" as const, rule: { kind: "interval" as const, hours: 1 } },
    threadMode: "new" as const,
    maxRunMinutes: 30,
  };
  const source = { ...turn, identityId: "vesper" as const };
  const id = applyProposal(kernel, context, source, proposal, "task");
  expect(id).toEqual(expect.any(String));
  expect(listTasks(kernel.db)).toMatchObject([{ id, identityId: "vesper", paused: true }]);
  applyProposal(
    kernel,
    context,
    source,
    { ...proposal, paused: false } as RuntimeProposal,
    "forged",
  );
  expect(listTasks(kernel.db)).toHaveLength(1);
  if (id === undefined) throw Error("capture");
  expect(
    resumeTask(kernel, context, { idempotencyKey: "on", taskId: id, expectedRevision: 0 }).ok,
  ).toBe(true);
  const updated = applyProposal(
    kernel,
    context,
    source,
    { ...proposal, taskId: id, prompt: "New suggestion" },
    "suggestion",
  );
  expect(updated).toBe(id);
  expect(listTasks(kernel.db)).toMatchObject([
    { id, paused: false, prompt: "List changes", proposedUpdate: { prompt: "New suggestion" } },
  ]);
  const action = { kind: "task_action" as const, taskId: id, action: "pause" as const };
  expect(applyProposal(kernel, context, turn, action, "foreign-pause")).toBeUndefined();
  expect(getTask(kernel.db, id)?.paused).toBe(false);
  expect(applyProposal(kernel, context, source, action, "pause")).toBe(id);
  expect(getTask(kernel.db, id)?.paused).toBe(true);
  resumeTask(kernel, context, {
    idempotencyKey: "on-again",
    taskId: id,
    expectedRevision: getTask(kernel.db, id)!.revision,
  });
  const run = { ...action, action: "run_now" as const };
  expect(applyProposal(kernel, context, source, run, "run-off")).toBeUndefined();
  const dispatcher = createDispatcher({ kernel });
  const deps = {
    dispatcher,
    enabled: false,
    conversation: {
      sendMessage: () => {
        throw Error("unexpected dispatch");
      },
      cancelTurn: () => {
        throw Error("unexpected cancellation");
      },
    },
  };
  expect(
    applyProposal(kernel, context, source, run, "run-disabled", { taskExecution: deps }),
  ).toBeUndefined();
  expect(listTaskRuns(kernel.db, id)).toHaveLength(0);
  expect(
    applyProposal(kernel, context, source, run, "run-enabled", {
      taskExecution: { ...deps, enabled: true },
    }),
  ).toBe(id);
  expect(
    applyProposal(kernel, context, source, run, "run-enabled", {
      taskExecution: { ...deps, enabled: true },
    }),
  ).toBe(id);
  expect(listTaskRuns(kernel.db, id)).toHaveLength(1);
  dispatcher.stop();
});
it("hands a Vault fact to the promoter, which records it against the turn", () => {
  applyProposal(
    kernel,
    context,
    turn,
    { kind: "vault_fact", path: "people/alex-kerr.md", fact: "Likes tea.", source: "inbox/a.md" },
    "v",
  );
  expect(listEdits(kernel.db, 5)).toMatchObject([
    { kind: "fact", status: "refused", reason: "no_vault", turnId: turn.id },
  ]);
});
