import { fixedClock } from "@noctis/domain";
import { afterEach, beforeEach, expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import type { NoctisDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { listMessages, listTurns } from "./service.js";

const THREAD = "0199a000-0000-7000-8000-000000000002";
let db: NoctisDatabase;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db, { directory: "apps/core/migrations", clock: fixedClock(0) });
  db.prepare(
    "INSERT INTO identity_threads (id, identity_id, created_at, updated_at) VALUES (?, 'vesper', ?, ?)",
  ).run(THREAD, "2026-10-26T00:00:00.000Z", "2026-10-26T00:00:00.000Z");

  for (let i = 0; i < 5; i += 1) {
    const at = new Date(Date.UTC(2026, 9, 26, 0, 0, i)).toISOString();
    db.prepare(
      "INSERT INTO identity_messages (id, thread_id, role, content_ref, created_at) VALUES (?, ?, 'user', '', ?)",
    ).run(`m${String(i)}`, THREAD, at);
    db.prepare(
      `INSERT INTO identity_turns (id, thread_id, user_message_id, provider_id, model_json, status, started_at)
       VALUES (?, ?, ?, 'claude', '{"providerId":"claude","model":"opus"}', 'completed', ?)`,
    ).run(`t${String(i)}`, THREAD, `m${String(i)}`, at);
  }
});

afterEach(() => db.close());

it("a long thread keeps its newest messages and turns, oldest first", () => {
  expect(listMessages(db, THREAD, 3).map((message) => message.id)).toEqual(["m2", "m3", "m4"]);
  expect(listTurns(db, THREAD, 3).map((turn) => turn.id)).toEqual(["t2", "t3", "t4"]);
});
