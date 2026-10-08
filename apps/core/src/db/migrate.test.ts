import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixedClock } from "@noctis/domain";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";
import { MigrationError, migrate } from "./migrate.js";

const clock = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));
const directories: string[] = [];

function makeMigrations(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "noctis-migrations-"));
  directories.push(directory);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(directory, name), sql, "utf8");
  }
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migrate", () => {
  it("applies a migration to an empty database", () => {
    const directory = makeMigrations({ "0001_init.sql": "CREATE TABLE a (id TEXT PRIMARY KEY);" });
    const db = openDatabase(":memory:");

    const outcome = migrate(db, { directory, clock });

    expect(outcome.appliedVersions).toEqual([1]);
    expect(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='a'").get()).toEqual({
      c: 1,
    });
    db.close();
  });

  it("is idempotent when re-run against a populated database", () => {
    const directory = makeMigrations({ "0001_init.sql": "CREATE TABLE a (id TEXT PRIMARY KEY);" });
    const db = openDatabase(":memory:");

    migrate(db, { directory, clock });
    db.prepare("INSERT INTO a VALUES (?)").run("row-1");
    const second = migrate(db, { directory, clock });

    expect(second.appliedVersions).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) c FROM a").get()).toEqual({ c: 1 });
    db.close();
  });

  it("applies multiple migrations in version order", () => {
    const directory = makeMigrations({
      "0002_second.sql": "CREATE TABLE b (id TEXT PRIMARY KEY);",
      "0001_first.sql": "CREATE TABLE a (id TEXT PRIMARY KEY);",
    });
    const db = openDatabase(":memory:");

    expect(migrate(db, { directory, clock }).appliedVersions).toEqual([1, 2]);
    db.close();
  });

  it("refuses a database recording a version newer than any known file", () => {
    const directory = makeMigrations({ "0001_init.sql": "CREATE TABLE a (id TEXT PRIMARY KEY);" });
    const db = openDatabase(":memory:");
    migrate(db, { directory, clock });
    db.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(
      99,
      "x",
      "2026-09-01T12:00:00.000Z",
    );

    expect(() => migrate(db, { directory, clock })).toThrow(MigrationError);
    db.close();
  });

  it("refuses an applied migration whose checksum changed", () => {
    const directory = makeMigrations({ "0001_init.sql": "CREATE TABLE a (id TEXT PRIMARY KEY);" });
    const db = openDatabase(":memory:");
    migrate(db, { directory, clock });

    const tampered = makeMigrations({ "0001_init.sql": "CREATE TABLE tampered (id TEXT);" });

    expect(() => migrate(db, { directory: tampered, clock })).toThrow(/checksum/i);
    db.close();
  });

  it("leaves no ledger row and no objects when a migration fails", () => {
    const directory = makeMigrations({
      "0001_bad.sql": "CREATE TABLE good (id TEXT); THIS IS NOT SQL;",
    });
    const db = openDatabase(":memory:");

    expect(() => migrate(db, { directory, clock })).toThrow();
    expect(db.prepare("SELECT COUNT(*) c FROM schema_migrations").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='good'").get()).toEqual({
      c: 0,
    });
    db.close();
  });

  it("applies every migration and creates all 41 tables", () => {
    const db = openDatabase(":memory:");

    migrate(db, { directory: "apps/core/migrations", clock });
    const row = db
      .prepare(
        "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { c: number };
    const names = (type: string) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type=?").all(type) as { name: string }[])
        .map((r) => r.name)
        .sort();
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
    const tables = names("table");
    const indexes = names("index");
    const approvals = columns("approvals");
    const nodeJobs = columns("node_jobs");
    const nodes = columns("nodes");
    const threads = columns("identity_threads");
    const runtimeSessions = columns("identity_sessions");
    const version = db.prepare("SELECT MAX(version) v FROM schema_migrations").get() as {
      v: number;
    };
    db.close();

    expect(row.c).toBe(41);
    expect(tables).toEqual(
      expect.arrayContaining([
        "identity_message_content",
        "identity_sessions",
        "identity_turns",
        "provider_decisions",
        "sessions",
        "push_subscriptions",
        "attachments",
        "turn_attachments",
      ]),
    );
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_approvals_ask",
        "idx_identity_turns_thread",
        "idx_identity_threads_objective",
        "idx_identity_threads_free",
        "idx_identity_threads_parent",
        "idx_sessions_cookie_hash",
        "idx_sessions_expires_at",
        "idx_push_subscriptions_session",
      ]),
    );
    expect(approvals).toEqual(
      expect.arrayContaining(["node_job_id", "ask_id", "declined_at", "declined_by"]),
    );
    expect(nodeJobs).toContain("pinned_node_id");
    expect(nodes).toContain("providers_json");
    expect(threads).toEqual(
      expect.arrayContaining([
        "objective_id",
        "parent_thread_id",
        "parent_turn_id",
        "kind",
        "title",
        "node_id",
        "root_grant_id",
        "provider_id",
        "adopted_session_ref",
        "archived_at",
      ]),
    );
    expect(runtimeSessions).toContain("fork_pending");
    expect(version.v).toBe(13);
  });
});
