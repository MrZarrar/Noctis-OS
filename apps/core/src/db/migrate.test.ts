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

  it("applies every migration and creates all 27 tables", () => {
    const db = openDatabase(":memory:");

    migrate(db, { directory: "apps/core/migrations", clock });
    const row = db
      .prepare(
        "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { c: number };
    db.close();

    expect(row.c).toBe(27);
  });
});
