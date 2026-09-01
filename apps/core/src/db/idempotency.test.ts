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
    const result = claimIdempotencyKey(db, {
      key: "k1",
      scope: "objective.create",
      resultId: "01941f29-7c00-7000-8000-000000000002",
      clock,
    });

    expect(result).toEqual({ ok: true, value: "01941f29-7c00-7000-8000-000000000002" });
  });

  it("returns idempotent_replay with the original id on a second claim", () => {
    const options = {
      key: "k1",
      scope: "objective.create",
      resultId: "01941f29-7c00-7000-8000-000000000002",
      clock,
    };
    claimIdempotencyKey(db, options);

    const replay = claimIdempotencyKey(db, {
      ...options,
      resultId: "01941f29-7c00-7000-8000-00000000000f",
    });

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
    claimIdempotencyKey(db, { ...base, scope: "objective.create" });

    expect(claimIdempotencyKey(db, { ...base, scope: "mission.create" }).ok).toBe(true);
  });
});
