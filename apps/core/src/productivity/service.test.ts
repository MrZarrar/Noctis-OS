import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdFactory, fixedClock } from "@noctis/domain";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import { createLogger } from "../logging.js";
import { issuePairingCode, pairNode } from "../nodes/registry.js";
import type { Kernel } from "../kernel.js";
import {
  createReminder,
  updateReminder,
  completeReminder,
  snoozeReminder,
  deleteReminder,
  listReminders,
  getReminder,
  markReminderDue,
  createNote,
  updateNote,
  deleteNote,
  listNotes,
} from "./service.js";
const context = {
  correlationId: "0199a000-0000-7000-8000-0000000000c1",
  actorType: "user" as const,
  actorId: "local",
};
let kernel: Kernel;
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
describe("persistent productivity commands", () => {
  it("snoozes until owner presence at a validated PC while preserving the original repeat", () => {
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
    const created = createReminder(kernel, context, {
      idempotencyKey: "r",
      identityId: "vesper",
      text: "Break",
      trigger: { kind: "repeat", rule: { kind: "interval", hours: 2 } },
    });
    if (!created.ok) throw Error("create");
    const snoozed = snoozeReminder(kernel, context, {
      idempotencyKey: "s",
      reminderId: created.value.id,
      expectedRevision: 0,
      atPcNodeId: paired.value.nodeId,
    });
    expect(snoozed).toMatchObject({
      ok: true,
      value: {
        status: "snoozed",
        snoozedUntilPcId: paired.value.nodeId,
        trigger: created.value.trigger,
      },
    });
    if (!snoozed.ok) throw Error("snooze");
    expect(snoozed.value.nextDueAt).toBeUndefined();
    expect(
      snoozeReminder(kernel, context, {
        idempotencyKey: "unknown",
        reminderId: created.value.id,
        expectedRevision: 1,
        atPcNodeId: context.correlationId,
      }).ok,
    ).toBe(false);
    const due = markReminderDue(kernel, context, {
      idempotencyKey: "fire",
      reminderId: created.value.id,
      expectedRevision: 1,
      nextDueAt: "2026-10-14T16:00:00Z",
    });
    if (!due.ok) throw Error("fire");
    expect(due.value.snoozedUntilPcId).toBeUndefined();
  });
  it("stores to-dos with identity provenance, idempotency, revision checks and deletion", () => {
    const command = {
      idempotencyKey: "create",
      identityId: "jester" as const,
      text: "Renew tax",
      trigger: null,
    };
    const created = createReminder(kernel, context, command);
    if (!created.ok) throw Error("create failed");
    expect(created.value.identityId).toBe("jester");
    expect(created.value.nextDueAt).toBeUndefined();
    expect(createReminder(kernel, context, command)).toMatchObject({
      ok: false,
      conflict: { kind: "idempotent_replay" },
    });
    expect(listReminders(kernel.db)).toHaveLength(1);
    expect(
      updateReminder(kernel, context, {
        ...command,
        reminderId: created.value.id,
        expectedRevision: 4,
        idempotencyKey: "bad",
      }),
    ).toMatchObject({ ok: false, conflict: { kind: "revision_conflict" } });
    expect(
      completeReminder(kernel, context, {
        idempotencyKey: "done",
        reminderId: created.value.id,
        expectedRevision: 0,
      }),
    ).toMatchObject({ ok: true, value: { status: "done", revision: 1 } });
    expect(
      deleteReminder(kernel, context, {
        idempotencyKey: "delete",
        reminderId: created.value.id,
        expectedRevision: 1,
      }).ok,
    ).toBe(true);
    expect(listReminders(kernel.db)).toHaveLength(0);
  });
  it("rejects past and unknown-PC triggers without writes", () => {
    for (const trigger of [
      { kind: "at" as const, at: "2026-10-14T11:00:00Z" },
      { kind: "at_pc" as const, nodeId: "0199a000-0000-7000-8000-0000000000d1", repeat: false },
    ])
      expect(
        createReminder(kernel, context, {
          idempotencyKey: trigger.kind,
          identityId: "vesper",
          text: "Bad",
          trigger,
        }).ok,
      ).toBe(false);
    expect(listReminders(kernel.db)).toEqual([]);
  });
  it("fires once, snoozes and completes a repeating series without deleting its trigger", () => {
    const created = createReminder(kernel, context, {
      idempotencyKey: "repeat",
      identityId: "vesper",
      text: "Break",
      trigger: { kind: "repeat", rule: { kind: "interval", hours: 2 } },
    });
    if (!created.ok) throw Error("create");
    expect(created.value.nextDueAt).toBe("2026-10-14T14:00:00.000Z");
    expect(
      markReminderDue(kernel, context, {
        idempotencyKey: "fire",
        reminderId: created.value.id,
        expectedRevision: 0,
        nextDueAt: "2026-10-14T16:00:00Z",
      }),
    ).toMatchObject({ ok: true, value: { status: "due" } });
    expect(
      snoozeReminder(kernel, context, {
        idempotencyKey: "snooze",
        reminderId: created.value.id,
        expectedRevision: 1,
        until: "2026-10-14T15:00:00Z",
      }),
    ).toMatchObject({ ok: true, value: { status: "snoozed", nextDueAt: "2026-10-14T15:00:00Z" } });
    expect(
      completeReminder(kernel, context, {
        idempotencyKey: "complete",
        reminderId: created.value.id,
        expectedRevision: 2,
      }),
    ).toMatchObject({ ok: true, value: { status: "pending" } });
    expect(getReminder(kernel.db, created.value.id)?.trigger?.kind).toBe("repeat");
  });
  it("stores, searches, updates and deletes core-local notes", () => {
    const created = createNote(kernel, context, {
      idempotencyKey: "note",
      identityId: "vesper",
      title: "Garden",
      body: "Plant jasmine",
    });
    if (!created.ok) throw Error("create");
    expect(listNotes(kernel.db, 200, "JASMINE")).toHaveLength(1);
    expect(listNotes(kernel.db, 200, "absent")).toEqual([]);
    expect(
      updateNote(kernel, context, {
        idempotencyKey: "edit",
        noteId: created.value.id,
        expectedRevision: 0,
        title: "Garden",
        body: "Plant mint",
      }),
    ).toMatchObject({ ok: true, value: { revision: 1 } });
    expect(
      deleteNote(kernel, context, {
        idempotencyKey: "delete",
        noteId: created.value.id,
        expectedRevision: 1,
      }).ok,
    ).toBe(true);
    expect(listNotes(kernel.db)).toEqual([]);
  });
});
