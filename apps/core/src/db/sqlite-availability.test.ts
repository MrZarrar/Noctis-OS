import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("node:sqlite availability", () => {
  it("opens an in-memory database and round-trips a row", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE probe (value TEXT NOT NULL)");
    db.prepare("INSERT INTO probe (value) VALUES (?)").run("ok");
    const row = db.prepare("SELECT value FROM probe").get() as { value: string };
    db.close();

    expect(row.value).toBe("ok");
  });
});
