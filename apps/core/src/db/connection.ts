import { DatabaseSync } from "node:sqlite";

/**
 * The only module that may construct the SQLite driver. Phase 1 uses the
 * built-in node:sqlite; Phase 3 may qualify better-sqlite3 and swap it here.
 * (sqlite-availability.test.ts is a deliberate exception that probes the
 * built-in module directly.) An ESLint rule (no-restricted-imports on
 * "node:sqlite") enforces that nothing else under apps/** imports it.
 */
export type NoctisDatabase = DatabaseSync;

export function openDatabase(path: string): NoctisDatabase {
  const database = new DatabaseSync(path);

  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");

  if (path !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
  }

  return database;
}

/**
 * Whether `db` currently has an open transaction. The one name node:sqlite's
 * `DatabaseSync` spells differently from better-sqlite3 (`isTransaction` vs.
 * `inTransaction`) — centralised here so the Phase 3 driver swap is a
 * one-file change instead of six call-site edits.
 */
export function inTransaction(db: NoctisDatabase): boolean {
  return db.isTransaction;
}
