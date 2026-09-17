import { createHash, randomBytes } from "node:crypto";

import type { Clock, IdFactory } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";

import { parseCookies } from "./cookie.js";

/**
 * The `__Host-` prefix is not decoration: a browser refuses to store a cookie
 * under this name unless it carries `Secure`, has `Path=/`, and names no
 * `Domain` — which is exactly what `sessionCookie` in `http.ts` already sets.
 *
 * It is the prevention that `cookie.ts`'s drop-both rule can only mitigate. A
 * sibling origin cannot plant a second `(name, path)` pair under a prefixed
 * name at all, so the duplicate that turns a session into a lockout never
 * arrives. That sibling is concrete here rather than hypothetical: every peer
 * on the tailnet is a host under the same `*.<tailnet>.ts.net` parent, so the
 * machine next door is the attacker this closes.
 */
export const SESSION_COOKIE = "__Host-noctis_session";

/** 32 bytes → 43 url-safe characters. Unguessable, and short enough to send as a cookie. */
const SECRET_BYTES = 32;

export interface SessionDeps {
  db: NoctisDatabase;
  clock: Clock;
  ids: IdFactory;
}

export interface VerifiedSession {
  id: string;
  csrfHash: string;
}

export interface CreatedSession {
  id: string;
  cookieValue: string;
  csrf: string;
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Mints a session. The plaintext is returned exactly once — to the response that
 * sets the cookie — and only its digest is written down, so a stolen database
 * yields nothing a browser could present.
 *
 * ponytail: a direct INSERT, no command, no event, no idempotency claim. A
 * session is transport state, not domain state: replaying a login must mint a
 * new secret, never return the old one, which is the opposite of what an
 * idempotency key promises. If logins ever need an audit trail, add a
 * `session.established.v1` carrying the session id and never its secret.
 */
export function createSession(deps: SessionDeps, ttlHours: number): CreatedSession {
  const nowMs = deps.clock.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlHours * 3_600_000).toISOString();

  // ponytail: swept opportunistically on login, not on a schedule. A core that
  // is never logged into again never grows this table, and one that is cleans
  // it on the way past — so the only unbounded case is a core logged into once
  // and then left, which holds a single dead row. Add a startup sweep or a
  // timer if a deployment ever accumulates sessions faster than it logs in.
  deps.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);

  const cookieValue = randomBytes(SECRET_BYTES).toString("base64url");
  const csrf = randomBytes(SECRET_BYTES).toString("base64url");
  const id = deps.ids.nextId();

  deps.db
    .prepare(
      `INSERT INTO sessions (id, cookie_hash, csrf_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, hashSecret(cookieValue), hashSecret(csrf), now, now, expiresAt);

  return { id, cookieValue, csrf };
}

/**
 * Mints a new CSRF value for a session that already exists, and forgets the old
 * one.
 *
 * This is what makes "log in once" true. The cookie lives thirty days in the
 * browser; the CSRF value lives in one page's memory, and a reload, an iOS tab
 * eviction, a Home Screen cold start or a notification tap all destroy it. With
 * no way to re-mint it, every one of those sent the owner back to the token
 * prompt while a perfectly good session sat in the cookie jar.
 *
 * The old value stops working, rather than both being accepted: a re-mint that
 * left the previous value live would turn a leak of it into a permanent one.
 *
 * ponytail: a direct UPDATE, no command, no event, no idempotency claim — the
 * same reasoning `createSession` writes down. A replayed re-mint must produce a
 * new secret, which is the opposite of what an idempotency key promises.
 */
export function refreshCsrf(deps: SessionDeps, sessionId: string): string {
  const csrf = randomBytes(SECRET_BYTES).toString("base64url");

  deps.db
    .prepare("UPDATE sessions SET csrf_hash = ? WHERE id = ?")
    .run(hashSecret(csrf), sessionId);

  return csrf;
}

function presentedCookie(cookieHeader: string | undefined): string | undefined {
  const value = parseCookies(cookieHeader).get(SESSION_COOKIE);

  return value === undefined || value === "" ? undefined : value;
}

export function verifySession(
  deps: SessionDeps,
  cookieHeader: string | undefined,
): VerifiedSession | undefined {
  const presented = presentedCookie(cookieHeader);

  if (presented === undefined) {
    return undefined;
  }

  const now = new Date(deps.clock.now()).toISOString();
  const row = deps.db
    .prepare(
      "SELECT id, csrf_hash AS csrfHash FROM sessions WHERE cookie_hash = ? AND expires_at > ?",
    )
    .get(hashSecret(presented), now) as VerifiedSession | undefined;

  if (row === undefined) {
    return undefined;
  }

  try {
    deps.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, row.id);
  } catch {
    /* last_seen_at is a nicety — never fail authentication over it */
  }

  return row;
}

/**
 * Ends a session. True if a row was deleted; false means the presented cookie
 * named no session, which a caller reports as `no_session` rather than an error.
 *
 * ponytail: a direct DELETE, no command, no event, no idempotency claim — the
 * mirror of `createSession`, and deliberately unconditional: logging out must
 * never be refused because a ledger write failed. If revocations ever need to
 * be auditable, add a `session.revoked.v1` after the row is gone.
 */
export function revokeSession(deps: SessionDeps, cookieHeader: string | undefined): boolean {
  const presented = presentedCookie(cookieHeader);

  if (presented === undefined) {
    return false;
  }

  const result = deps.db
    .prepare("DELETE FROM sessions WHERE cookie_hash = ?")
    .run(hashSecret(presented));

  return Number(result.changes) > 0;
}
