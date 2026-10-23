import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
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

  it("THE GATE (panels): preserves intents, overrides and snapshots across the owner migration", () => {
    const files = Object.fromEntries(
      readdirSync("apps/core/migrations")
        .filter((name) => Number(name.slice(0, 4)) < 16)
        .map((name) => [name, readFileSync(join("apps/core/migrations", name), "utf8")]),
    );
    const db = openDatabase(":memory:");
    migrate(db, { directory: makeMigrations(files), clock });
    db.exec(
      "INSERT INTO objectives (id,title,intent,status,identity_id,created_at,updated_at) VALUES ('o','title','intent','draft','vesper','now','now')",
    );
    db.exec(
      "INSERT INTO surface_intents VALUES ('s','o','detail','primary','objective','proposed',1,'compact',NULL,'[]','[]',1,'{}','now'), ('s2','o','detail','supporting','objective','proposed',2,'compact',NULL,'[\"source\"]','[]',1,'{}','now')",
    );
    db.exec(
      "INSERT INTO surface_overrides VALUES ('v','s','client','display','main','compact','now',NULL), ('v2','s2','client','display','main','compact','now','later')",
    );
    db.exec(
      "INSERT INTO composition_snapshots VALUES ('c','o','layout','display','{}','[]','now')",
    );
    const before = ["surface_intents", "surface_overrides", "composition_snapshots"].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    );
    expect(migrate(db, { directory: "apps/core/migrations", clock }).appliedVersions).toContain(16);
    for (const [index, table] of [
      "surface_intents",
      "surface_overrides",
      "composition_snapshots",
    ].entries()) {
      const rows = db
        .prepare(`SELECT * FROM ${table} ORDER BY id`)
        .all()
        .map((row) => {
          return Object.fromEntries(
            Object.entries(row as Record<string, unknown>).filter(
              ([name]) => name !== "thread_id" && name !== "presence" && name !== "slot_order",
            ),
          );
        });
      expect(rows).toEqual(before[index]);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    for (const owners of [
      [null, null, null],
      ["o", null, 1],
      ["o", "missing", null],
      ["o", "missing", 1],
      [null, "missing", 1],
      [null, null, 0],
    ]) {
      expect(() =>
        db
          .prepare(
            "INSERT INTO surface_intents (id,objective_id,thread_id,presence,kind,role,persistence,lifecycle,priority,min_size,payload_version,payload_json,requested_at) VALUES ('bad',?,?,?,'detail','primary','objective','proposed',1,'compact',1,'{}','now')",
          )
          .run(...owners),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO composition_snapshots (id,objective_id,thread_id,presence,layout_id,display_fingerprint,plan_json,generated_at) VALUES ('bad',?,?,?,'layout','display','{}','now')",
          )
          .run(...owners),
      ).toThrow();
    }
    db.close();
  });

  it("applies every migration and creates all 55 tables", () => {
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
    const vaultItems = columns("vault_items");
    const version = db.prepare("SELECT MAX(version) v FROM schema_migrations").get() as {
      v: number;
    };
    db.close();

    expect(row.c).toBe(56);
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
        "passcode",
        "passcode_unlocks",
        "live_sessions",
        "live_session_entries",
        "reminders",
        "notes",
        "scheduled_tasks",
        "task_runs",
        "node_owner_presence",
        "vault_edits",
        "vault_promotions",
        "vault_promoter",
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
        "idx_live_sessions_updated",
        "idx_live_session_entries_session",
        "idx_task_runs_active_task",
        "idx_task_runs_active_node",
        "idx_permissions_task",
      ]),
    );
    expect(approvals).toEqual(
      expect.arrayContaining(["node_job_id", "ask_id", "declined_at", "declined_by", "task_id"]),
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
    expect(runtimeSessions).toEqual(expect.arrayContaining(["fork_pending", "root_grant_id"]));
    expect(version.v).toBe(24);
    expect(tables).toEqual(
      expect.arrayContaining(["health_report", "health_runs", "place_events"]),
    );
    expect(vaultItems).toContain("sensitive");
    expect(vaultItems).toContain("tags");
  });
});
