import { describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";

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
});
