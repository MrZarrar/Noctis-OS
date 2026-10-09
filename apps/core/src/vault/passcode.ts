import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { NoctisDatabase } from "../db/connection.js";

/**
 * The passcode that shows sensitive Vault notes. Ported from the Jarvis donor's
 * Brain PIN lock (`server/lib/brain-lock.js`, ee7b4527, MIT; see
 * DONOR-PORT-LEDGER.md): scrypt with a random salt, a constant-time compare,
 * five wrong tries and a 15-minute lockout, an unlock that lasts a chosen
 * number of minutes and is extended by use.
 *
 * An unlock is keyed by the request's credential (a session id, or `bearer`),
 * so it needs no cookie of its own and ends with the session.
 *
 * ponytail: no change or reset. Forgotten, it is cleared with
 * `DELETE FROM passcode` in core.db, which then offers setup again.
 */

export const PASSCODE_TIMEOUTS: readonly number[] = [1, 5, 15, 30];
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;
const HASH_BYTES = 64;

export interface PasscodeStatus {
  configured: boolean;
  unlocked: boolean;
  timeoutMinutes: number;
  lockoutSeconds: number;
}

export type PasscodeResult =
  | { ok: true }
  | { ok: false; reason: "bad_passcode" | "bad_timeout" | "already_configured" | "not_configured" }
  | { ok: false; reason: "wrong_passcode"; attemptsRemaining: number }
  | { ok: false; reason: "locked_out"; retryAfterSeconds: number };

interface Row {
  salt: string;
  hash: string;
  failed_attempts: number;
  locked_until: string | null;
  timeout_minutes: number;
}

function row(db: NoctisDatabase): Row | undefined {
  return db.prepare("SELECT * FROM passcode WHERE id = 1").get() as Row | undefined;
}

function hashOf(pin: string, salt: string): Buffer {
  return scryptSync(pin, salt, HASH_BYTES);
}

function remainingSeconds(until: string | null, now: number): number {
  return until === null ? 0 : Math.max(0, Math.ceil((Date.parse(until) - now) / 1000));
}

function grant(db: NoctisDatabase, now: number, principal: string, minutes: number): void {
  db.prepare(
    `INSERT INTO passcode_unlocks (principal, expires_at) VALUES (?, ?)
     ON CONFLICT (principal) DO UPDATE SET expires_at = excluded.expires_at`,
  ).run(principal, new Date(now + minutes * 60_000).toISOString());
}

export function passcodeStatus(db: NoctisDatabase, now: number, principal: string): PasscodeStatus {
  const config = row(db);

  return {
    configured: config !== undefined,
    unlocked: isUnlocked(db, now, principal),
    timeoutMinutes: config?.timeout_minutes ?? 5,
    lockoutSeconds: remainingSeconds(config?.locked_until ?? null, now),
  };
}

/** True while this credential's unlock is live; each true answer extends it. */
export function isUnlocked(db: NoctisDatabase, now: number, principal: string): boolean {
  const config = row(db);

  if (config === undefined) {
    return false;
  }

  const unlock = db
    .prepare("SELECT expires_at FROM passcode_unlocks WHERE principal = ?")
    .get(principal) as { expires_at: string } | undefined;

  if (unlock === undefined || Date.parse(unlock.expires_at) <= now) {
    return false;
  }

  grant(db, now, principal, config.timeout_minutes);
  return true;
}

export function setupPasscode(
  db: NoctisDatabase,
  now: number,
  principal: string,
  pin: string,
  timeoutMinutes: number,
): PasscodeResult {
  if (!/^\d{4,8}$/.test(pin)) {
    return { ok: false, reason: "bad_passcode" };
  }

  if (!PASSCODE_TIMEOUTS.includes(timeoutMinutes)) {
    return { ok: false, reason: "bad_timeout" };
  }

  if (row(db) !== undefined) {
    return { ok: false, reason: "already_configured" };
  }

  const salt = randomBytes(16).toString("hex");

  db.prepare(
    `INSERT INTO passcode (id, salt, hash, timeout_minutes, created_at) VALUES (1, ?, ?, ?, ?)`,
  ).run(salt, hashOf(pin, salt).toString("hex"), timeoutMinutes, new Date(now).toISOString());
  grant(db, now, principal, timeoutMinutes);

  return { ok: true };
}

export function unlockPasscode(
  db: NoctisDatabase,
  now: number,
  principal: string,
  pin: string,
): PasscodeResult {
  const config = row(db);

  if (config === undefined) {
    return { ok: false, reason: "not_configured" };
  }

  const lockout = remainingSeconds(config.locked_until, now);

  if (lockout > 0) {
    return { ok: false, reason: "locked_out", retryAfterSeconds: lockout };
  }

  const expected = Buffer.from(config.hash, "hex");

  if (!/^\d{4,8}$/.test(pin) || !timingSafeEqual(hashOf(pin, config.salt), expected)) {
    const failed = config.failed_attempts + 1;

    if (failed >= MAX_FAILURES) {
      db.prepare("UPDATE passcode SET failed_attempts = 0, locked_until = ? WHERE id = 1").run(
        new Date(now + LOCKOUT_MS).toISOString(),
      );
      return { ok: false, reason: "locked_out", retryAfterSeconds: LOCKOUT_MS / 1000 };
    }

    db.prepare("UPDATE passcode SET failed_attempts = ? WHERE id = 1").run(failed);
    return { ok: false, reason: "wrong_passcode", attemptsRemaining: MAX_FAILURES - failed };
  }

  db.prepare("UPDATE passcode SET failed_attempts = 0, locked_until = NULL WHERE id = 1").run();
  grant(db, now, principal, config.timeout_minutes);

  return { ok: true };
}

export function lockPasscode(db: NoctisDatabase, principal: string): void {
  db.prepare("DELETE FROM passcode_unlocks WHERE principal = ?").run(principal);
}
