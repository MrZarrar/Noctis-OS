import { createIdFactory, fixedClock } from "@noctis/domain";
import { beforeEach, describe, expect, it } from "vitest";

import type { NoctisDatabase } from "../db/connection.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { MIGRATIONS_DIRECTORY } from "../server.js";

import {
  SESSION_COOKIE,
  createSession,
  hashSecret,
  refreshCsrf,
  revokeSession,
  verifySession,
} from "./session.js";

const HOUR_MS = 3_600_000;

function deps(nowMs: number, db: NoctisDatabase) {
  const clock = fixedClock(nowMs);
  return { db, clock, ids: createIdFactory(clock) };
}

describe("sessions", () => {
  let db: NoctisDatabase;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db, { directory: MIGRATIONS_DIRECTORY, clock: fixedClock(0) });
  });

  it("issues a cookie value and a csrf token that differ", () => {
    const created = createSession(deps(0, db), 1);

    expect(created.cookieValue).not.toBe(created.csrf);
    expect(created.cookieValue.length).toBeGreaterThanOrEqual(43);
    expect(created.csrf.length).toBeGreaterThanOrEqual(43);
  });

  it("never stores the cookie value or the csrf token in plaintext", () => {
    const created = createSession(deps(0, db), 1);
    const row = db.prepare("SELECT * FROM sessions").get() as Record<string, string>;

    expect(JSON.stringify(row)).not.toContain(created.cookieValue);
    expect(JSON.stringify(row)).not.toContain(created.csrf);
  });

  it("verifies a presented cookie", () => {
    const created = createSession(deps(0, db), 1);

    expect(verifySession(deps(0, db), `${SESSION_COOKIE}=${created.cookieValue}`)?.id).toBe(
      created.id,
    );
  });

  it("refuses a cookie that has expired", () => {
    const created = createSession(deps(0, db), 1);

    expect(
      verifySession(deps(HOUR_MS + 1, db), `${SESSION_COOKIE}=${created.cookieValue}`),
    ).toBeUndefined();
  });

  it("refuses an unknown, absent, or empty cookie", () => {
    createSession(deps(0, db), 1);

    expect(verifySession(deps(0, db), `${SESSION_COOKIE}=nonsense`)).toBeUndefined();
    expect(verifySession(deps(0, db), undefined)).toBeUndefined();
    expect(verifySession(deps(0, db), `${SESSION_COOKIE}=`)).toBeUndefined();
  });

  it("refuses the value under a different cookie name", () => {
    const created = createSession(deps(0, db), 1);

    expect(verifySession(deps(0, db), `other=${created.cookieValue}`)).toBeUndefined();
  });

  it("revokes a session so the same cookie stops working", () => {
    const created = createSession(deps(0, db), 1);
    const cookie = `${SESSION_COOKIE}=${created.cookieValue}`;

    expect(revokeSession(deps(0, db), cookie)).toBe(true);
    expect(verifySession(deps(0, db), cookie)).toBeUndefined();
    expect(revokeSession(deps(0, db), cookie)).toBe(false);
  });

  it("re-mints a csrf value for a session that already exists, without touching its cookie", () => {
    const created = createSession(deps(0, db), 1);
    const cookie = `${SESSION_COOKIE}=${created.cookieValue}`;

    const minted = refreshCsrf(deps(0, db), created.id);

    expect(minted).not.toBe(created.csrf);
    // The cookie is untouched: the browser keeps the credential it already has.
    expect(verifySession(deps(0, db), cookie)?.id).toBe(created.id);
    expect(verifySession(deps(0, db), cookie)?.csrfHash).toBe(hashSecret(minted));
  });

  it("stops the previous csrf value working, so a leaked one is not live forever", () => {
    const created = createSession(deps(0, db), 1);

    refreshCsrf(deps(0, db), created.id);

    const stored = verifySession(deps(0, db), `${SESSION_COOKIE}=${created.cookieValue}`);

    expect(stored?.csrfHash).not.toBe(hashSecret(created.csrf));
  });

  it("never stores a re-minted csrf value in plaintext either", () => {
    const created = createSession(deps(0, db), 1);
    const minted = refreshCsrf(deps(0, db), created.id);
    const row = db.prepare("SELECT * FROM sessions").get() as Record<string, string>;

    expect(JSON.stringify(row)).not.toContain(minted);
  });

  it("deletes expired rows on the way past, so the table cannot grow without bound", () => {
    createSession(deps(0, db), 1);
    createSession(deps(HOUR_MS * 2, db), 1);

    const count = db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };

    expect(count.c).toBe(1);
  });
});
