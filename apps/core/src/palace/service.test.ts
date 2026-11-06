import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdFactory } from "@noctis/domain";
import type { PalaceContents } from "@noctis/contracts";
import { expect, it } from "vitest";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import { createLogger } from "../logging.js";
import { VaultConflict } from "../vault/writes.js";
import { readPalaceEntry, savePalaceEntry, archivePalaceEntry } from "./service.js";

it("refuses stale saves, creates over existing files, changed retry payloads and locked edits without changing bytes", () => {
  const root = { path: mkdtempSync(join(tmpdir(), "noctis-palace-conflict-")), live: false };
  const db = openDatabase(":memory:");
  const clock = { now: () => Date.parse("2026-11-06T12:00:00Z") };
  migrate(db, { directory: join(process.cwd(), "apps/core/migrations"), clock });
  const kernel = {
    db,
    clock,
    ids: createIdFactory(clock),
    broker: createEventBroker(),
    logger: createLogger({ sink: () => undefined, level: "error" }),
  };
  const deps = { kernel, root, env: { NOCTIS_VAULT_ALLOW_WRITES: "true" }, principal: "bearer" };
  const context = {
    correlationId: kernel.ids.nextId(),
    actorId: "local",
    actorType: "user" as const,
  };
  const entryId = kernel.ids.nextId();
  const contents: PalaceContents = {
    kind: "thought",
    body: "Original\n\nOriginal",
    tags: [],
    archived: false,
    sensitive: false,
    connections: [],
  };
  const command = { entryId, contents, idempotencyKey: "first" };
  try {
    const saved = savePalaceEntry(deps, context, command);
    expect(saved.ok).toBe(true);
    expect(savePalaceEntry(deps, context, command)).toEqual(saved);
    const file = join(root.path, "palace", "entries", `${entryId}.md`);
    const before = readFileSync(file, "utf8");
    const hash = readPalaceEntry(deps, entryId)!.contentHash;
    expect(() =>
      savePalaceEntry(deps, context, { ...command, idempotencyKey: "create-again" }),
    ).toThrow(VaultConflict);
    const reused = savePalaceEntry(deps, context, {
      ...command,
      contents: { ...contents, body: "Changed payload" },
    });
    expect(reused.ok).toBe(false);
    writeFileSync(file, before + "\nExternal edit");
    const external = readFileSync(file);
    expect(() =>
      savePalaceEntry(deps, context, { ...command, idempotencyKey: "stale", expectedHash: hash }),
    ).toThrow(VaultConflict);
    expect(() =>
      archivePalaceEntry(deps, context, { entryId, expectedHash: hash, idempotencyKey: "archive" }),
    ).toThrow(VaultConflict);
    expect(readFileSync(file)).toEqual(external);
    const sensitive = before.replace("sensitive: false", "sensitive: true");
    writeFileSync(file, sensitive);
    expect(readPalaceEntry(deps, entryId)).toBeUndefined();
    expect(savePalaceEntry(deps, context, command).ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(sensitive);
  } finally {
    db.close();
  }
});
