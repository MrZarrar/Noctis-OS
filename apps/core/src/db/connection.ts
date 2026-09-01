import { DatabaseSync } from "node:sqlite";

/**
 * The only module that names the SQLite driver. Phase 1 uses the built-in
 * node:sqlite; Phase 3 may qualify better-sqlite3 and swap it here alone.
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
