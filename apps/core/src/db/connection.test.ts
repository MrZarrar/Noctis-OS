import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";

const temporary: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "noctis-connection-"));

  temporary.push(directory);

  return directory;
}

afterEach(() => {
  while (temporary.length > 0) {
    rmSync(temporary.pop() ?? "", { recursive: true, force: true });
  }
});

describe("openDatabase", () => {
  it("enables foreign key enforcement", () => {
    const db = openDatabase(":memory:");
    const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    db.close();

    expect(row.foreign_keys).toBe(1);
  });

  it("actually rejects a violating write", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE parent (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE child (parent_id TEXT REFERENCES parent(id))");

    expect(() => db.prepare("INSERT INTO child VALUES (?)").run("missing")).toThrow(/FOREIGN KEY/i);

    db.close();
  });

  it("round-trips a row", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (v TEXT NOT NULL)");
    db.prepare("INSERT INTO t VALUES (?)").run("hello");
    const row = db.prepare("SELECT v FROM t").get() as { v: string };
    db.close();

    expect(row.v).toBe("hello");
  });

  /**
   * THE GATE: a first run points `NOCTIS_DATABASE_PATH` somewhere that does not
   * exist yet. SQLite answers `unable to open database file`, which reads like a
   * permissions problem rather than a missing folder — it sent a qualification
   * run looking in the wrong place before this existed.
   */
  it("creates the directory a database path names", () => {
    const path = join(scratch(), "Noctis", "core.db");

    const db = openDatabase(path);
    db.exec("CREATE TABLE t (v TEXT)");
    db.close();

    expect(existsSync(path)).toBe(true);
  });

  it("creates a whole missing tree, not just the last folder", () => {
    const path = join(scratch(), "one", "two", "three", "core.db");

    const db = openDatabase(path);
    db.close();

    expect(existsSync(path)).toBe(true);
  });

  it("is content for the directory to exist already", () => {
    const path = join(scratch(), "core.db");

    openDatabase(path).close();
    // Twice: the second call finds the directory there and must not object.
    openDatabase(path).close();

    expect(existsSync(path)).toBe(true);
  });

  /** `:memory:` has no directory, and must not have one created for it. */
  it("does not try to make a folder for an in-memory database", () => {
    openDatabase(":memory:").close();

    expect(existsSync(join(process.cwd(), ":memory:"))).toBe(false);
  });
});
