import { fixedClock } from "@noctis/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type NoctisDatabase } from "./connection.js";
import { appendEvent, type EventDraft } from "./events.js";
import { migrate } from "./migrate.js";

const clock = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));

const OBJECTIVE_ID = "01941f29-7c00-7000-8000-000000000002";

let db: NoctisDatabase;

function insertObjective(target: NoctisDatabase, id: string): void {
  target
    .prepare(
      `INSERT INTO objectives (id, title, intent, status, identity_id, created_at, updated_at)
       VALUES (?, 'T', 'I', 'draft', 'vesper', '2026-09-01T12:00:00.000Z', '2026-09-01T12:00:00.000Z')`,
    )
    .run(id);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db, { directory: "apps/core/migrations", clock });
});

describe("appendEvent", () => {
  it("returns a payload equal to what a replay reads back", () => {
    const draft: EventDraft = {
      id: "01941f29-7c00-7000-8000-000000000020",
      streamType: "objective",
      streamId: OBJECTIVE_ID,
      type: "objective.created.v1",
      actorType: "user",
      actorId: "mushaf",
      payloadVersion: 1,
      payload: { at: new Date("2026-09-01T12:00:00Z"), n: Number.NaN, u: undefined },
      correlationId: "01941f29-7c00-7000-8000-000000000011",
      occurredAt: "2026-09-01T12:00:00.000Z",
    };

    db.exec("BEGIN IMMEDIATE");
    insertObjective(db, OBJECTIVE_ID);
    const committed = appendEvent(db, draft);
    db.exec("COMMIT");

    const row = db
      .prepare("SELECT payload_json FROM orchestration_events WHERE id = ?")
      .get(draft.id) as { payload_json: string };

    expect(JSON.parse(row.payload_json)).toEqual(committed.payload);
    expect(JSON.parse(row.payload_json)).toEqual({ at: "2026-09-01T12:00:00.000Z", n: null });
  });

  it("throws when called outside an open transaction", () => {
    const draft: EventDraft = {
      id: "01941f29-7c00-7000-8000-000000000021",
      streamType: "objective",
      streamId: OBJECTIVE_ID,
      type: "objective.created.v1",
      actorType: "user",
      actorId: "mushaf",
      payloadVersion: 1,
      payload: {},
      correlationId: "01941f29-7c00-7000-8000-000000000011",
      occurredAt: "2026-09-01T12:00:00.000Z",
    };

    expect(() => appendEvent(db, draft)).toThrow("appendEvent must run inside an open transaction");
  });
});
