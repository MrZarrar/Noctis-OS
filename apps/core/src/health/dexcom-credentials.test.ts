import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createDexcomCredentials } from "./dexcom-credentials.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

function harness(databasePath = ":memory:") {
  const db = openDatabase(databasePath);
  migrate(db, { directory: "apps/core/migrations", clock: { now: () => Date.now() } });
  return { db, credentials: createDexcomCredentials({ db, databasePath }) };
}

describe("createDexcomCredentials", () => {
  it("has none by default", () => {
    const { credentials } = harness();
    expect(credentials.hasCredentials()).toBe(false);
    expect(credentials.readCredentials()).toBeUndefined();
  });

  it("round-trips a saved login", () => {
    const { credentials } = harness();
    credentials.setCredentials({ username: "me@example.com", password: "hunter2" });
    expect(credentials.hasCredentials()).toBe(true);
    expect(credentials.readCredentials()).toEqual({
      username: "me@example.com",
      password: "hunter2",
    });
  });

  it("clears a saved login", () => {
    const { credentials } = harness();
    credentials.setCredentials({ username: "me@example.com", password: "hunter2" });
    credentials.clearCredentials();
    expect(credentials.hasCredentials()).toBe(false);
  });

  it("never stores the password as plain text in the database", () => {
    const { db, credentials } = harness();
    credentials.setCredentials({ username: "me@example.com", password: "hunter2" });
    const row = db
      .prepare("SELECT value_json FROM runtime_kv WHERE key = 'dexcom:credentials'")
      .get() as { value_json: string };
    expect(row.value_json).not.toContain("hunter2");
    expect(row.value_json).not.toContain("me@example.com");
  });

  it("keeps the key on disk so a restart can still decrypt", () => {
    const directory = mkdtempSync(join(tmpdir(), "dexcom-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "core.db");

    const first = harness(databasePath);
    first.credentials.setCredentials({ username: "me@example.com", password: "hunter2" });
    first.db.close();

    const reopenedDb = openDatabase(databasePath);
    const reopened = createDexcomCredentials({ db: reopenedDb, databasePath });
    expect(reopened.readCredentials()).toEqual({
      username: "me@example.com",
      password: "hunter2",
    });
    expect(() => readFileSync(join(directory, "dexcom.key"))).not.toThrow();
    reopenedDb.close();
  });
});
