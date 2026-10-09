import { expect, it } from "vitest";

import { passcodeRefusal } from "./vault-lock.js";

it("says why a passcode was refused, in words", () => {
  const refusal = (code: string, details?: unknown) =>
    passcodeRefusal({ error: { code, message: "x", details } });

  expect(refusal("wrong_passcode", { attemptsRemaining: 2 })).toBe(
    "That passcode is wrong. 2 tries left before a 15-minute lockout.",
  );
  expect(refusal("locked_out", { retryAfterSeconds: 840 })).toBe(
    "Too many wrong tries. Try again in 14 minutes.",
  );
  expect(refusal("bad_passcode")).toBe("A passcode is 4 to 8 digits.");
  expect(refusal("already_configured")).toBe("A passcode is already set.");
  expect(passcodeRefusal(undefined)).toBe("The core did not accept that.");
});
