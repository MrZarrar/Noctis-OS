import { fixedClock } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type NoctisDatabase } from "./connection.js";
import { migrate } from "./migrate.js";
import { commitStateAndEvent, type Mutation } from "./transactions.js";

const clock = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));

const OBJECTIVE_ID = "01941f29-7c00-7000-8000-000000000002";
const CORRELATION_ID = "01941f29-7c00-7000-8000-000000000011";

let db: NoctisDatabase;

function insertObjective(target: NoctisDatabase, id: string): void {
  target
    .prepare(
      `INSERT INTO objectives (id, title, intent, status, identity_id, created_at, updated_at)
       VALUES (?, 'T', 'I', 'draft', 'vesper', '2026-09-01T12:00:00.000Z', '2026-09-01T12:00:00.000Z')`,
    )
    .run(id);
}

function draftEvent(id: string, streamId: string) {
  return {
    id,
    streamType: "objective" as const,
    streamId,
    type: "objective.created.v1" as const,
    actorType: "user" as const,
    actorId: "mushaf",
    payloadVersion: 1,
    payload: {},
    correlationId: CORRELATION_ID,
    occurredAt: "2026-09-01T12:00:00.000Z",
  };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db, { directory: "apps/core/migrations", clock });
});

describe("commitStateAndEvent", () => {
  it("commits state and its event together", () => {
    const result = commitStateAndEvent(db, (tx) => {
      insertObjective(tx, OBJECTIVE_ID);
      return ok({
        value: OBJECTIVE_ID,
        events: [draftEvent("01941f29-7c00-7000-8000-000000000020", OBJECTIVE_ID)],
      });
    });

    expect(result.ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) c FROM objectives").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM orchestration_events").get()).toEqual({ c: 1 });
  });

  it("assigns a monotonic sequence to committed events", () => {
    for (const [index, id] of [
      "01941f29-7c00-7000-8000-00000000002a",
      "01941f29-7c00-7000-8000-00000000002b",
    ].entries()) {
      const objectiveId = `01941f29-7c00-7000-8000-00000000003${index}`;
      commitStateAndEvent(db, (tx) => {
        insertObjective(tx, objectiveId);
        return ok({ value: null, events: [draftEvent(id, objectiveId)] });
      });
    }

    const rows = db
      .prepare("SELECT sequence FROM orchestration_events ORDER BY sequence")
      .all() as Array<{ sequence: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[1]!.sequence).toBeGreaterThan(rows[0]!.sequence);
  });

  it("THE GATE: a refusal writes neither state nor event", () => {
    const result = commitStateAndEvent(db, (tx) => {
      insertObjective(tx, OBJECTIVE_ID);
      return conflict<Mutation<string>>({
        kind: "forbidden_transition",
        machine: "objective",
        from: "completed",
        to: "active",
      });
    });

    expect(result.ok).toBe(false);
    expect(db.prepare("SELECT COUNT(*) c FROM objectives").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM orchestration_events").get()).toEqual({ c: 0 });
  });

  it("THE GATE: a thrown failure between the writes leaves both tables empty", () => {
    expect(() =>
      commitStateAndEvent(db, (tx) => {
        insertObjective(tx, OBJECTIVE_ID);
        throw new Error("injected failure between state and event");
      }),
    ).toThrow("injected failure");

    expect(db.prepare("SELECT COUNT(*) c FROM objectives").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM orchestration_events").get()).toEqual({ c: 0 });
  });

  it("returns committed events so delivery happens only after commit", () => {
    const result = commitStateAndEvent(db, (tx) => {
      insertObjective(tx, OBJECTIVE_ID);
      return ok({
        value: OBJECTIVE_ID,
        events: [draftEvent("01941f29-7c00-7000-8000-000000000040", OBJECTIVE_ID)],
      });
    });

    expect(result.ok ? result.value.committedEvents[0]?.sequence : undefined).toBe(1);
  });

  it("rolls back a violating event without leaving the state row", () => {
    expect(() =>
      commitStateAndEvent(db, (tx) => {
        insertObjective(tx, OBJECTIVE_ID);
        return ok({
          value: null,
          events: [
            {
              ...draftEvent("01941f29-7c00-7000-8000-000000000050", OBJECTIVE_ID),
              type: "not.a.registered.event" as never,
            },
          ],
        });
      }),
    ).toThrow();

    expect(db.prepare("SELECT COUNT(*) c FROM objectives").get()).toEqual({ c: 0 });
  });
});
