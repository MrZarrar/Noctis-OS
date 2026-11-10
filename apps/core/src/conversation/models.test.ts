import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";

import { defaultModelFor } from "./models.js";

const CARRY_OVER = readFileSync("apps/core/migrations/0025_pinned_claude_models.sql", "utf8");

function migratedDatabase() {
  const db = openDatabase(":memory:");
  migrate(db, { directory: "apps/core/migrations", clock: { now: () => 0 } });
  return db;
}

function storeDefault(db: ReturnType<typeof openDatabase>, identityId: string, model: unknown) {
  db.prepare(
    `INSERT INTO runtime_kv (key, value_version, value_json, updated_at)
       VALUES (?, 1, ?, '2026-11-10T00:00:00.000Z')`,
  ).run(`identity_model_default:${identityId}`, JSON.stringify(model));
}

it("carries a default saved under a Claude alias over to the pinned model", () => {
  const db = migratedDatabase();
  storeDefault(db, "vesper", { providerId: "claude", model: "opus", label: "Claude Opus" });
  storeDefault(db, "atlas", { providerId: "claude", model: "sonnet" });

  db.exec(CARRY_OVER);

  expect(defaultModelFor(db, "vesper")).toEqual({
    providerId: "claude",
    model: "claude-opus-5-5",
    label: "Claude Opus 5.5",
  });
  expect(defaultModelFor(db, "atlas")).toEqual({
    providerId: "claude",
    model: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
  });
  db.close();
});

it("leaves a default that already names a model alone", () => {
  const db = migratedDatabase();
  const hermes = { providerId: "hermes", model: "opus", label: "Hermes opus" };
  storeDefault(db, "jester", hermes);
  storeDefault(db, "vesper", {
    providerId: "claude",
    model: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
  });

  db.exec(CARRY_OVER);

  expect(defaultModelFor(db, "jester")).toEqual(hermes);
  expect(defaultModelFor(db, "vesper")).toEqual({
    providerId: "claude",
    model: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
  });
  db.close();
});
