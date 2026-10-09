import { beforeEach, describe, expect, it } from "vitest";

import type { NoctisDatabase } from "../db/connection.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { fixedClock } from "@noctis/domain";
import { MIGRATIONS_DIRECTORY } from "../server.js";

import {
  isUnlocked,
  lockPasscode,
  passcodeStatus,
  setupPasscode,
  unlockPasscode,
} from "./passcode.js";

const T0 = 1_760_000_000_000;
const MINUTE = 60_000;

describe("passcode", () => {
  let db: NoctisDatabase;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db, { directory: MIGRATIONS_DIRECTORY, clock: fixedClock(T0) });
  });

  it("starts unconfigured and locked", () => {
    expect(passcodeStatus(db, T0, "s1")).toEqual({
      configured: false,
      unlocked: false,
      timeoutMinutes: 5,
      lockoutSeconds: 0,
    });
    expect(isUnlocked(db, T0, "s1")).toBe(false);
  });

  it("is set once, unlocks the credential that set it, and refuses a second setup", () => {
    expect(setupPasscode(db, T0, "s1", "2468", 5)).toEqual({ ok: true });
    expect(isUnlocked(db, T0, "s1")).toBe(true);
    expect(isUnlocked(db, T0, "s2")).toBe(false);
    expect(setupPasscode(db, T0, "s1", "1111", 5)).toEqual({
      ok: false,
      reason: "already_configured",
    });
  });

  it("refuses a passcode that is not 4 to 8 digits, or an odd timeout", () => {
    for (const pin of ["123", "123456789", "12a4", ""]) {
      expect(setupPasscode(db, T0, "s1", pin, 5)).toEqual({ ok: false, reason: "bad_passcode" });
    }

    expect(setupPasscode(db, T0, "s1", "1234", 7)).toEqual({ ok: false, reason: "bad_timeout" });
  });

  it("unlocks with the right passcode until the timeout, and use extends it", () => {
    setupPasscode(db, T0, "s1", "2468", 5);
    lockPasscode(db, "s1");
    expect(isUnlocked(db, T0, "s1")).toBe(false);

    expect(unlockPasscode(db, T0, "s2", "2468")).toEqual({ ok: true });
    expect(isUnlocked(db, T0 + 4 * MINUTE, "s2")).toBe(true);
    // Used at 4 minutes, so it now lasts until 9.
    expect(isUnlocked(db, T0 + 8 * MINUTE, "s2")).toBe(true);
    expect(isUnlocked(db, T0 + 14 * MINUTE, "s2")).toBe(false);
  });

  it("locks out for 15 minutes after five wrong tries, then lets the right one in", () => {
    setupPasscode(db, T0, "s1", "2468", 5);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(unlockPasscode(db, T0, "s2", "0000")).toEqual({
        ok: false,
        reason: "wrong_passcode",
        attemptsRemaining: 5 - attempt,
      });
    }

    expect(unlockPasscode(db, T0, "s2", "0000")).toEqual({
      ok: false,
      reason: "locked_out",
      retryAfterSeconds: 900,
    });
    // Even the right passcode waits out the lockout.
    expect(unlockPasscode(db, T0 + MINUTE, "s2", "2468")).toMatchObject({ reason: "locked_out" });
    expect(passcodeStatus(db, T0 + MINUTE, "s2").lockoutSeconds).toBe(840);
    expect(unlockPasscode(db, T0 + 16 * MINUTE, "s2", "2468")).toEqual({ ok: true });
  });

  it("never stores the passcode itself", () => {
    setupPasscode(db, T0, "s1", "2468", 5);

    expect(JSON.stringify(db.prepare("SELECT * FROM passcode").all())).not.toContain("2468");
  });
});
