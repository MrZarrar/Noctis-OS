import { fixedClock } from "@noctis/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type NoctisDatabase } from "./connection.js";
import { claimIdempotencyKey } from "./idempotency.js";
import { migrate } from "./migrate.js";

const clock = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));
let db: NoctisDatabase;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db, { directory: "apps/core/migrations", clock });
});

describe("claimIdempotencyKey", () => {
  it("claims an unused key", () => {
    db.exec("BEGIN IMMEDIATE");
    const result = claimIdempotencyKey(db, {
      key: "k1",
      scope: "objective.create",
      resultId: "01941f29-7c00-7000-8000-000000000002",
      clock,
    });
    db.exec("COMMIT");

    expect(result).toEqual({ ok: true, value: "01941f29-7c00-7000-8000-000000000002" });
  });

  it("returns idempotent_replay with the original id on a second claim", () => {
    const options = {
      key: "k1",
      scope: "objective.create",
      resultId: "01941f29-7c00-7000-8000-000000000002",
      clock,
    };
    db.exec("BEGIN IMMEDIATE");
    claimIdempotencyKey(db, options);
    db.exec("COMMIT");

    db.exec("BEGIN IMMEDIATE");
    const replay = claimIdempotencyKey(db, {
      ...options,
      resultId: "01941f29-7c00-7000-8000-00000000000f",
    });
    db.exec("COMMIT");

    expect(replay).toEqual({
      ok: false,
      conflict: {
        kind: "idempotent_replay",
        key: "k1",
        existingId: "01941f29-7c00-7000-8000-000000000002",
      },
    });
  });

  it("treats the same key in a different scope as distinct", () => {
    const base = { key: "k1", resultId: "01941f29-7c00-7000-8000-000000000002", clock };
    db.exec("BEGIN IMMEDIATE");
    claimIdempotencyKey(db, { ...base, scope: "objective.create" });
    db.exec("COMMIT");

    db.exec("BEGIN IMMEDIATE");
    const result = claimIdempotencyKey(db, { ...base, scope: "mission.create" });
    db.exec("COMMIT");

    expect(result.ok).toBe(true);
  });

  it("does not collide when one scope is a colon-prefix of another key", () => {
    // Regression: a `${scope}:${key}` concatenation would map scope="a", key="b:c"
    // and scope="a:b", key="c" to the same string. The composite primary key
    // (scope, key) keeps them distinct.
    db.exec("BEGIN IMMEDIATE");
    claimIdempotencyKey(db, {
      key: "b:c",
      scope: "a",
      resultId: "01941f29-7c00-7000-8000-000000000002",
      clock,
    });
    db.exec("COMMIT");

    db.exec("BEGIN IMMEDIATE");
    const result = claimIdempotencyKey(db, {
      key: "c",
      scope: "a:b",
      resultId: "01941f29-7c00-7000-8000-00000000000f",
      clock,
    });
    db.exec("COMMIT");

    expect(result).toEqual({ ok: true, value: "01941f29-7c00-7000-8000-00000000000f" });
  });

  it("throws when called outside an open transaction", () => {
    expect(() =>
      claimIdempotencyKey(db, {
        key: "k1",
        scope: "objective.create",
        resultId: "01941f29-7c00-7000-8000-000000000002",
        clock,
      }),
    ).toThrow("claimIdempotencyKey must run inside an open transaction");
  });
});
