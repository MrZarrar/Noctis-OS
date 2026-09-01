import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Clock } from "@noctis/domain";

import { inTransaction, type NoctisDatabase } from "./connection.js";

export class MigrationError extends Error {}

export interface MigrateOptions {
  directory: string;
  clock: Clock;
}

export interface MigrationOutcome {
  appliedVersions: number[];
}

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

function readMigrations(directory: string): MigrationFile[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => {
      const match = /^(\d+)_/.exec(name);
      if (match?.[1] === undefined) {
        throw new MigrationError(`Migration file name must start with a version: ${name}`);
      }
      const sql = readFileSync(join(directory, name), "utf8");
      return {
        version: Number.parseInt(match[1], 10),
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    })
    .sort((a, b) => a.version - b.version);
}

/**
 * Applies pending migrations. Each migration and its ledger row commit in one
 * transaction, so a failure leaves neither the schema change nor the record.
 */
export function migrate(db: NoctisDatabase, options: MigrateOptions): MigrationOutcome {
  db.exec(LEDGER);

  const files = readMigrations(options.directory);
  const known = new Map(files.map((file) => [file.version, file]));
  const applied = db
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number; checksum: string }>;

  const highestKnown = files.reduce((max, file) => Math.max(max, file.version), 0);

  for (const row of applied) {
    if (row.version > highestKnown) {
      throw new MigrationError(
        `Database is at schema version ${row.version} but the newest known migration is ${highestKnown}. Refusing to start against an unknown newer schema.`,
      );
    }

    const file = known.get(row.version);
    if (file !== undefined && file.checksum !== row.checksum) {
      throw new MigrationError(
        `Migration ${file.name} has checksum ${file.checksum} but was applied as ${row.checksum}. An applied migration must never be edited.`,
      );
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = files.filter((file) => !appliedVersions.has(file.version));
  const result: number[] = [];

  for (const file of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(file.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
      ).run(file.version, file.checksum, new Date(options.clock.now()).toISOString());
      db.exec("COMMIT");
      result.push(file.version);
    } catch (error) {
      // SQLite already auto-rolls-back on some errors (e.g. SQLITE_FULL), which
      // leaves no transaction open. Swallow only that rollback failure so the
      // original error still reaches the caller instead of being replaced by it.
      if (inTransaction(db)) {
        db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  return { appliedVersions: result };
}
