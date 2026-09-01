import { createHash, timingSafeEqual } from "node:crypto";

const BEARER = /^Bearer (.+)$/;

/**
 * Constant-time bearer check.
 *
 * The presented value is compared as a SHA-256 digest rather than raw bytes,
 * because `timingSafeEqual` throws on a length mismatch — and an exception
 * thrown only for wrong-length tokens is itself a timing signal that leaks the
 * token's length. Digests are always 32 bytes, so every comparison takes the
 * same path.
 */
export function isAuthorized(header: string | undefined, token: string): boolean {
  const match = header === undefined ? null : BEARER.exec(header);

  if (match?.[1] === undefined) {
    return false;
  }

  return timingSafeEqual(
    createHash("sha256").update(match[1], "utf8").digest(),
    createHash("sha256").update(token, "utf8").digest(),
  );
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
