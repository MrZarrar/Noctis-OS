import { createHash, timingSafeEqual } from "node:crypto";

import type { VerifiedSession } from "./session.js";
import { hashSecret } from "./session.js";

const BEARER = /^Bearer (.+)$/;

/**
 * Constant-time equality for two secrets of any length, and the module's one
 * way to compare one.
 *
 * Both sides are reduced to a SHA-256 digest rather than compared as raw bytes,
 * because `timingSafeEqual` throws on a length mismatch — and an exception
 * thrown only for wrong-length input is itself a timing signal that leaks the
 * secret's length. Digests are always 32 bytes, so every comparison takes the
 * same path.
 */
function secretsMatch(presented: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(presented, "utf8").digest(),
    createHash("sha256").update(expected, "utf8").digest(),
  );
}

/** Constant-time bearer check. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  const match = header === undefined ? null : BEARER.exec(header);

  if (match?.[1] === undefined) {
    return false;
  }

  return secretsMatch(match[1], token);
}

/**
 * Section 9.2: "Same-origin and CSRF protections for browser mutations; CORS is
 * not treated as CSRF protection." So this gates the request itself rather than
 * emitting permissive CORS headers.
 *
 * An absent Origin means the caller is not a browser — a native shell, the Rust
 * proxy, or a test — and cannot be a cross-site forgery. It still has to present
 * the bearer token, which a forged browser request has no way to obtain, since
 * the token is never a cookie.
 */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin === undefined ? true : allowed.includes(origin);
}

export interface AuthorizeInput {
  method: string;
  authorization: string | undefined;
  cookie: string | undefined;
  csrfHeader: string | undefined;
  token: string;
  session: (cookie: string | undefined) => VerifiedSession | undefined;
}

export type AuthorizeResult =
  | { kind: "bearer" }
  | { kind: "session"; id: string }
  | { kind: "denied"; reason: "unauthorized" | "csrf" };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Two ways to be authorised, in a fixed order.
 *
 * A presented `Authorization` header is answered on its own merits: if it is
 * wrong, the request is refused rather than quietly falling through to the
 * cookie. Anything else would let a caller probe tokens for free by attaching a
 * session it already holds.
 *
 * `SameSite=Strict` already stops a cross-site browser from sending the cookie.
 * The CSRF header is the second lock: its value has to be read from a login
 * response served by this same origin, which a cross-origin page cannot do.
 */
export function authorize(input: AuthorizeInput): AuthorizeResult {
  if (input.authorization !== undefined) {
    return isAuthorized(input.authorization, input.token)
      ? { kind: "bearer" }
      : { kind: "denied", reason: "unauthorized" };
  }

  const session = input.session(input.cookie);

  if (session === undefined) {
    return { kind: "denied", reason: "unauthorized" };
  }

  if (SAFE_METHODS.has(input.method.toUpperCase())) {
    return { kind: "session", id: session.id };
  }

  // Compared the same way the bearer token is, for the same reason: the header
  // is attacker-supplied, and `===` on two strings stops at the first differing
  // character.
  if (
    input.csrfHeader === undefined ||
    !secretsMatch(hashSecret(input.csrfHeader), session.csrfHash)
  ) {
    return { kind: "denied", reason: "csrf" };
  }

  return { kind: "session", id: session.id };
}
