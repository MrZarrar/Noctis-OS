import { fixedClock } from "@noctis/domain";
import { beforeEach, describe, expect, it } from "vitest";

import type { NoctisDatabase } from "../db/connection.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { MIGRATIONS_DIRECTORY } from "../server.js";

import { digestLine, msUntilNext, readDigest } from "./digest.js";

const DAY_FROM = "2026-10-09T00:00:00.000Z";
const DAY_TO = "2026-10-10T00:00:00.000Z";

describe("the daily digest", () => {
  let db: NoctisDatabase;
  let n = 0;

  function thread(identityId: string, title: string | null): string {
    n += 1;
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    db.prepare(
      `INSERT INTO identity_threads (id, identity_id, created_at, updated_at, kind, title)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, identityId, DAY_FROM, DAY_FROM, title === null ? "free" : "named", title);
    return id;
  }

  function turn(
    threadId: string,
    providerId: string,
    status: string,
    startedAt: string,
    items: unknown[] = [],
  ): void {
    n += 1;
    const id = `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
    db.prepare(
      `INSERT INTO identity_messages (id, thread_id, role, content_ref, created_at)
       VALUES (?, ?, 'user', 'x', ?)`,
    ).run(id, threadId, startedAt);
    db.prepare(
      `INSERT INTO identity_turns (id, thread_id, user_message_id, provider_id, model_json, status,
                                   items_json, started_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`,
    ).run(id, threadId, id, providerId, status, JSON.stringify(items), startedAt);
  }

  function approval(outcome: string, decided: "confirmed" | "declined" | null): void {
    n += 1;
    db.prepare(
      `INSERT INTO approvals (id, actor_id, operation_class, capability, target_json,
                              consequence_summary, reversibility, idempotency_key, outcome,
                              requested_at, confirmed_at, declined_at)
       VALUES (?, 'agent', 'external_write', 'x', '{}', 'x', 'irreversible', ?, ?, ?, ?, ?)`,
    ).run(
      `a${String(n)}`,
      `k${String(n)}`,
      outcome,
      "2026-10-09T10:00:00.000Z",
      decided === "confirmed" ? "2026-10-09T10:01:00.000Z" : null,
      decided === "declined" ? "2026-10-09T10:01:00.000Z" : null,
    );
  }

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db, { directory: MIGRATIONS_DIRECTORY, clock: fixedClock(Date.parse(DAY_FROM)) });
    db.exec("PRAGMA foreign_keys = OFF");
  });

  it("counts the day's turns, agents, files, outputs and approvals, and nothing outside it", () => {
    const free = thread("vesper", null);
    const named = thread("vesper", "Thought Unfolds script");

    turn(free, "claude", "completed", "2026-10-09T09:00:00.000Z", [
      { kind: "file_change", paths: ["a.md", "b.md"] },
    ]);
    turn(named, "codex", "completed", "2026-10-09T11:00:00.000Z", [{ kind: "output" }]);
    turn(named, "codex", "failed", "2026-10-09T12:00:00.000Z");
    turn(named, "codex", "completed", "2026-10-08T23:59:00.000Z");
    approval("require_confirmation", "confirmed");
    approval("require_confirmation", "declined");
    approval("require_confirmation", null);
    approval("allow", null);

    const digest = readDigest(db, DAY_FROM, DAY_TO);

    expect(digest.turns).toEqual({ total: 3, completed: 2, failed: 1, cancelled: 0 });
    expect(digest.agents).toEqual([
      { providerId: "codex", turns: 2 },
      { providerId: "claude", turns: 1 },
    ]);
    expect(digest.threads).toEqual([
      {
        threadId: named,
        identityId: "vesper",
        title: "Thought Unfolds script",
        turns: 2,
        failed: 1,
      },
      { threadId: free, identityId: "vesper", title: null, turns: 1, failed: 0 },
    ]);
    expect(digest.files).toBe(2);
    expect(digest.outputs).toBe(1);
    expect(digest.approvals).toEqual({ asked: 3, approved: 1, declined: 1, unanswered: 1 });
  });

  it("says the day in one line, and says when nothing happened", () => {
    const named = thread("vesper", "Script");
    turn(named, "claude", "completed", "2026-10-09T09:00:00.000Z", [
      { kind: "file_change", paths: ["a.md"] },
    ]);
    turn(named, "codex", "failed", "2026-10-09T10:00:00.000Z");
    approval("require_confirmation", "confirmed");

    expect(digestLine(readDigest(db, DAY_FROM, DAY_TO))).toBe(
      "2 turns in 1 thread (Claude 1, Codex 1), 1 failed. 1 file written. 1 approval asked: 1 approved.",
    );
    expect(digestLine(readDigest(db, DAY_TO, "2026-10-11T00:00:00.000Z"))).toBe(
      "The agents did nothing.",
    );
  });

  it("says how much was filed from the inbox and how much waits", () => {
    const named = thread("vesper", "Vault upkeep");
    turn(named, "claude", "completed", "2026-10-09T03:00:00.000Z");
    const edit = db.prepare(
      `INSERT INTO vault_edits (id, kind, path, source, text, status, created_at)
       VALUES (?, ?, 'people/a.md', 'inbox/a.md', 'x', ?, '2026-10-09T03:00:00.000Z')`,
    );
    edit.run("e1", "fact", "applied");
    edit.run("e2", "note", "applied");
    edit.run("e3", "revision", "pending");

    expect(digestLine(readDigest(db, DAY_FROM, DAY_TO))).toContain(
      "filed 2 facts from the inbox, 1 change waits for you",
    );
  });

  it("waits until the next time of day, tomorrow if it has passed", () => {
    const at = (iso: string) => new Date(iso);

    expect(msUntilNext(at("2026-10-09T20:00:00"), "21:30")).toBe(90 * 60_000);
    expect(msUntilNext(at("2026-10-09T22:00:00"), "21:30")).toBe(23.5 * 3_600_000);
    expect(msUntilNext(at("2026-10-09T21:30:00"), "21:30")).toBe(24 * 3_600_000);
    expect(msUntilNext(at("2026-10-09T21:30:00"), "25:00")).toBeUndefined();
    expect(msUntilNext(at("2026-10-09T21:30:00"), "")).toBeUndefined();
  });
});
