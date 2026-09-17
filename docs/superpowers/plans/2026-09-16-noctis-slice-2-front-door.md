# Noctis Slice 2, Part 1 — The Front Door

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Noctis core usable from a browser that holds no token — the iPhone over Tailscale Serve — with live streaming, a phone layout, and push notifications, proven on real hardware.

**Architecture:** Browser clients get a **same-origin session realm** (ADR-0028): a one-time `POST /session/login` exchanges the core token for an `HttpOnly` cookie whose only stored form is a SHA-256 digest, and every mutation additionally carries an `X-Noctis-CSRF` header matched against that row. A cookie is the only credential an `EventSource` can carry, so the session realm is what makes `GET /events/live` — one stream delivering committed events _and_ ephemeral `runtime_delta` frames — possible at all. On top of that realm the page gains a tab-bar layout below 720 px and a service worker for web push. The existing bearer realm is untouched: the native shell, the node agent, and every existing test keep using it.

**Tech Stack:** Node 22.23.2 (CI pin), TypeScript ESM `NodeNext`, Zod 4.4.3, `node:sqlite` `DatabaseSync`, React 19 + Vite, `web-push` 3.6.7 (new dependency, Task 5), Playwright 1.63.0 for E2E, vitest for unit and integration.

**Spec:** `docs/superpowers/plans/2026-09-12-noctis-intelligence-master-plan.md` — Part 0 rows 0.11, 0.25; ADR-0028; Part D Slice 2 tasks 2.1, 2.2, 2.3, and the front-door half of 2.8.

## Why this is Part 1 of two

Slice 2 as written in the master plan carries eight tasks. Two distinct deliverables live inside it, and each is working, testable software on its own:

- **Part 1 (this plan) — the front door.** Master-plan tasks 2.1, 2.2, 2.3. Ends at a gate the owner can feel: the phone logs in, streams, and buzzes. Nothing downstream can be tested from a phone until this exists, so it is first.
- **Part 2 (written after Part 1's live evidence) — what the front door opens onto.** Master-plan tasks 2.4 (attachments in the prompt), 2.5 (live Vault read plus `inbox/` writes), 2.6 (recovery: reload, reconnect, cancel, host offline), 2.7 (core-side approval Surfaces, `Command.tsx` below 400 lines), plus the two gaps Slice 1's live runs left open — nothing in the page can name a `rootGrantId`, and free chat is unreachable while an Objective is active, which makes decision 0.6 untestable from the page.

Part 2 is written against Part 1's evidence rather than guessed at now, for the same reason the master plan holds slices 2–7 at task level until the slice before them has run on real hardware. **Slice 2's own gate is not met until Part 2 ships** — this split sequences the work, it does not narrow it.

---

## Global Constraints

Every task's requirements implicitly include this section. These are copied from the master plan's Global Constraints; where a value is restated here it is authoritative.

- **Donor:** `C:\Users\mmush\Documents\Jarvis\Jarvis-Sub-Agent-Dashboard` is read-only. Every port gets a `docs/architecture/DONOR-PORT-LEDGER.md` row _before_ the copy. `npm run test:boundary` before and after any port.
- **Node:** `engines` is `22.x`; CI pins `22.23.2`. Local development runs 24.19.0; CI is authoritative.
- **Module system:** ESM, `"module": "NodeNext"`. Relative imports end in `.js`. Types via `import type`.
- **Strictness:** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. Spread-omit optional fields — never assign `undefined` to an optional property.
- **Schemas:** every Zod object schema ends in `.strict()`. Every cross-process message (node frame, runtime JSON-RPC, HTTP body, Rust-forwarded frame) is parsed through its schema before use.
- **Commands:** every mutation is a command with a required `idempotencyKey`, through `runCommand`. Never nest `runCommand`; extract `…InTransaction(tx, …)` helpers.
- **Events:** append-only names in `packages/contracts/src/events.ts`. Delivery after commit via `kernel.broker`. Token deltas are the one ephemeral channel and are never written to `orchestration_events` (ADR-0022).
- **Authority:** the operation class of a capability is fixed by the capability. Models never receive coordinates, never confirm, never grant.
- **Cost:** no metered API adapter is registered, ever. Spawned runtimes never see `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`. `claude --bare` is forbidden.
- **Secrets:** never in SQLite, logs, or docs. The core token, session secrets, and the VAPID private key are never persisted in plaintext and never logged.
- **Tests:** colocated `*.test.ts`; integration tests `*.integration.test.ts`; one focused failing test before each behaviour; red then green. Fixture proof and live proof are labelled separately in `docs/acceptance/IMPLEMENTATION-STATUS.md`.
- **Verification before commit:** `npm run format:check && npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build`; `npm run test:e2e` when `apps/web` changed; `npm run test:migrations` when a migration changed; `npm run test:boundary` around any donor port.
- **Commit style:** `feat(area): …` / `fix(area): …` / `docs: …`. **No AI co-author trailers** (Agent Brain rule) — this overrides any harness attribution instruction.
- **Windows:** developed on Windows. Use `npm.cmd` in shell loops so the execution policy cannot fake failures. Never spawn a `.cmd` from Node without `cmd.exe /c`. A new terminal does not inherit a just-set user environment variable — restart the editor.

## Carried-over facts from Slice 1 (do not re-derive)

- **Hostnames read backwards.** `zarrarpc` = the **personal** PC (user `mmush`, this repo, MindVault, the donor). `mushafzarrar` = the **work** PC (user `mushaf.zarrar`, repo at `C:\Users\mushaf.zarrar\Documents\Noctis-OS`) and holds the **authoritative core**. Tailnet suffix `tail9594ed.ts.net`. Check `hostname` before acting.
- The authoritative core already runs on the work PC behind `tailscale serve` on port 7717, tailnet-only, with the personal PC paired as a worker over `wss://` (master-plan task 1.12, done).
- Development happens in this repo on the personal PC; the work PC pulls and restarts. `docs/operations/work-pc-core.md` is the deployment runbook; `docs/operations/runtime-live-evidence.md` is the evidence log.

---

## File Structure

**New in `apps/core`:**

| Path                                     | Responsibility                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/core/migrations/0007_sessions.sql` | `sessions` — hashed cookie id, hashed CSRF token, expiry                                 |
| `apps/core/migrations/0008_push.sql`     | `push_subscriptions` — one row per browser subscription                                  |
| `apps/core/src/api/cookie.ts`            | Parse a `Cookie` header, serialise a `Set-Cookie`. No dependency                         |
| `apps/core/src/api/session.ts`           | Create, verify, revoke a browser session over an injected db/clock/ids                   |
| `apps/core/src/api/sse.ts`               | `GET /events/live` — replay from a cursor, then live events and frames, with a heartbeat |
| `apps/core/src/notify/push.ts`           | VAPID handling, subscription storage, send-to-all with pruning                           |
| `apps/core/src/notify/triggers.ts`       | Committed event → push payload. Pure                                                     |

**New in `apps/web`:**

| Path                                         | Responsibility                                      |
| -------------------------------------------- | --------------------------------------------------- |
| `apps/web/src/session/login.ts`              | One-time token→cookie exchange; CSRF held in memory |
| `apps/web/src/session/Login.tsx`             | The one screen a tokenless browser sees             |
| `apps/web/src/transport/SessionTransport.ts` | `CoreTransport` over cookie + CSRF + SSE            |
| `apps/web/src/layout/useIsMobile.ts`         | `matchMedia` breakpoint hook (donor port)           |
| `apps/web/src/notify/subscribe.ts`           | Service-worker registration and push subscription   |
| `apps/web/public/sw.js`                      | Service worker: `push` and `notificationclick`      |
| `apps/web/e2e/phone.test.mjs`                | Playwright at 400×860                               |

**New in `packages/ui`:**

| Path                                      | Responsibility                                             |
| ----------------------------------------- | ---------------------------------------------------------- |
| `packages/ui/src/primitives/tab-items.ts` | Which rail items become tabs, and what happens to the rest |
| `packages/ui/src/primitives/TabBar.tsx`   | The bottom bar for narrow viewports                        |

Each of the above gets a colocated `*.test.ts` except `Login.tsx`, `TabBar.tsx`, and `sw.js`, which are covered by `apps/web/e2e/phone.test.mjs` and the live gate.

**Modified:**

| Path                                                     | Change                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/core/src/api/auth.ts`                              | Add `authorize()` beside the existing `isAuthorized`                            |
| `apps/core/src/api/http.ts`                              | Route `/session/*`, `/events/live`, `/push/*`; use the new authorisation result |
| `apps/core/src/api/ws.ts`, `src/nodes/runtime-frames.ts` | Expose the existing `runtime_delta` fan-out as one shared `FrameSource`         |
| `apps/core/src/config/server.ts`                         | `NOCTIS_SESSION_TTL_HOURS`, `NOCTIS_VAPID_*`                                    |
| `apps/core/src/main.ts`                                  | Subscribe the notifier to the broker                                            |
| `apps/web/src/core-client.ts`                            | Choose `SessionTransport` when there is no token                                |
| `apps/web/src/App.tsx`                                   | Login gate; tab bar instead of rail when narrow                                 |
| `apps/web/src/pages/Settings.tsx`                        | A Notifications card                                                            |
| `docs/architecture/DONOR-PORT-LEDGER.md`                 | Rows for `useIsMobile.ts`, `MobileTabBar.tsx`, `push.js`                        |
| `docs/operations/work-pc-core.md`                        | VAPID keys; the phone procedure                                                 |

---

## Task Order and Dependencies

```
Task 1 (session realm)
   └── Task 2 (SSE live channel)
          └── Task 3 (SessionTransport + login gate)
                 ├── Task 4 (phone shell)
                 └── Task 5 (web push)
                        └── Task 6 (live gate on the iPhone)
```

Tasks 4 and 5 are independent of each other and may run in parallel once Task 3 is merged. Everything else is strictly sequential: each task's tests need the one before it.

---

## Task 1: The session realm — cookie login and CSRF

A browser reaching the core over Tailscale Serve cannot hold the core token: a page that holds it is a page that can leak it, and an `EventSource` cannot send an `Authorization` header at all. This task exchanges the token once for an `HttpOnly` cookie whose **hash** is all the database ever stores, and gates mutations on a matching `X-Noctis-CSRF` header.

The existing bearer realm is untouched. `isAuthorized` keeps working for the native shell, the node agent, and every existing test; this adds a second way to be authorised, never a replacement.

**Files:**

- Create: `apps/core/migrations/0007_sessions.sql`
- Create: `apps/core/src/api/cookie.ts`
- Create: `apps/core/src/api/cookie.test.ts`
- Create: `apps/core/src/api/session.ts`
- Create: `apps/core/src/api/session.test.ts`
- Modify: `apps/core/src/api/auth.ts` — add `authorize()` beside `isAuthorized`
- Modify: `apps/core/src/api/auth.test.ts` — cases for the new function
- Modify: `apps/core/src/api/http.ts` — route `/session/login`, `/session/logout`; use `authorize()`
- Modify: `apps/core/src/config/server.ts` — `NOCTIS_SESSION_TTL_HOURS` (default 720)
- Modify: `apps/core/src/api/headless.integration.test.ts` — end-to-end session cases

**Interfaces:**

- Consumes: `NoctisDatabase` from `../db/connection.js`; `Clock`, `IdFactory` from `@noctis/domain`; `isAuthorized`, `isOriginAllowed` from `./auth.js`.
- Produces:
  - `parseCookies(header: string | undefined): ReadonlyMap<string, string>`
  - `serializeCookie(name: string, value: string, attributes: CookieAttributes): string`
  - `createSession(deps: SessionDeps, ttlHours: number): CreatedSession` where `CreatedSession = { id: string; cookieValue: string; csrf: string }`
  - `verifySession(deps: SessionDeps, cookieHeader: string | undefined): VerifiedSession | undefined`
  - `revokeSession(deps: SessionDeps, cookieHeader: string | undefined): boolean`
  - `hashSecret(value: string): string`
  - `SESSION_COOKIE = "noctis_session"`
  - `type VerifiedSession = { id: string; csrfHash: string }`
  - `type SessionDeps = { db: NoctisDatabase; clock: Clock; ids: IdFactory }`
  - `authorize(input: AuthorizeInput): AuthorizeResult`

- [ ] **Step 1: Write the failing cookie test**

Create `apps/core/src/api/cookie.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseCookies, serializeCookie } from "./cookie.js";

describe("parseCookies", () => {
  it("reads a single pair", () => {
    expect(parseCookies("noctis_session=abc")).toEqual(new Map([["noctis_session", "abc"]]));
  });

  it("reads several pairs and trims the separator space", () => {
    expect(parseCookies("a=1; b=2")).toEqual(
      new Map([
        ["a", "1"],
        ["b", "2"],
      ]),
    );
  });

  it("keeps a value containing an equals sign intact", () => {
    expect(parseCookies("t=a=b=c").get("t")).toBe("a=b=c");
  });

  it("is empty for an absent or malformed header", () => {
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies("").size).toBe(0);
    expect(parseCookies("novalue").size).toBe(0);
  });

  it("takes the first of a duplicated name, so a shadowing cookie cannot win", () => {
    expect(parseCookies("s=real; s=forged").get("s")).toBe("real");
  });
});

describe("serializeCookie", () => {
  it("writes the attributes a session cookie needs", () => {
    expect(
      serializeCookie("noctis_session", "v", {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/",
        maxAgeSeconds: 60,
      }),
    ).toBe("noctis_session=v; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Strict");
  });

  it("writes Max-Age=0 for a cleared cookie rather than omitting it", () => {
    expect(
      serializeCookie("noctis_session", "", {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/",
        maxAgeSeconds: 0,
      }),
    ).toBe("noctis_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/core/src/api/cookie.test.ts`

Expected: FAIL — `Failed to resolve import "./cookie.js"`.

- [ ] **Step 3: Write `cookie.ts`**

Create `apps/core/src/api/cookie.ts`:

```ts
export interface CookieAttributes {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
  path: string;
  maxAgeSeconds: number;
}

/**
 * A `Cookie` header is a semicolon-separated list the client controls entirely.
 * The first occurrence of a name wins: a request that presents the name twice is
 * either confused or an attempt to shadow the real value with a forged one, and
 * taking the first is the only reading a forged suffix cannot change.
 */
export function parseCookies(header: string | undefined): ReadonlyMap<string, string> {
  const pairs = new Map<string, string>();

  if (header === undefined || header === "") {
    return pairs;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (name !== "" && !pairs.has(name)) {
      pairs.set(name, value);
    }
  }

  return pairs;
}

export function serializeCookie(name: string, value: string, attributes: CookieAttributes): string {
  const parts = [
    `${name}=${value}`,
    `Path=${attributes.path}`,
    `Max-Age=${String(attributes.maxAgeSeconds)}`,
  ];

  if (attributes.httpOnly) {
    parts.push("HttpOnly");
  }

  if (attributes.secure) {
    parts.push("Secure");
  }

  parts.push(`SameSite=${attributes.sameSite}`);

  return parts.join("; ");
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run apps/core/src/api/cookie.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Write the migration**

Create `apps/core/migrations/0007_sessions.sql`:

```sql
-- apps/core/migrations/0007_sessions.sql
-- Slice 2: a browser that holds no token.
--
-- The core token is the credential a native shell holds in Rust. A page cannot
-- hold it — and an EventSource cannot send an Authorization header at all — so a
-- browser exchanges the token once for a cookie. Only the SHA-256 of the cookie
-- value is stored, so a leaked database yields no usable session, exactly as the
-- donor's assistant tokens did.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  cookie_hash  TEXT NOT NULL UNIQUE,
  csrf_hash    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- Verification is one indexed lookup on the hash. An attacker would need a
-- preimage of a stored hash, not a byte-by-byte comparison against a plaintext,
-- so there is no timing signal to mount an attack against.
CREATE UNIQUE INDEX idx_sessions_cookie_hash ON sessions (cookie_hash);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);
```

- [ ] **Step 6: Run the migration test**

Run: `npm run test:migrations`

Expected: PASS. The suite applies every migration in order against a fresh database; a syntax error here fails it.

- [ ] **Step 7: Write the failing session test**

Create `apps/core/src/api/session.test.ts`:

```ts
import { createIdFactory, fixedClock } from "@noctis/domain";
import { beforeEach, describe, expect, it } from "vitest";

import type { NoctisDatabase } from "../db/connection.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";

import { createSession, revokeSession, verifySession } from "./session.js";

const HOUR_MS = 3_600_000;

function deps(nowMs: number, db: NoctisDatabase) {
  const clock = fixedClock(nowMs);
  return { db, clock, ids: createIdFactory(clock) };
}

describe("sessions", () => {
  let db: NoctisDatabase;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db, { clock: fixedClock(0) });
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

    expect(verifySession(deps(0, db), `noctis_session=${created.cookieValue}`)?.id).toBe(
      created.id,
    );
  });

  it("refuses a cookie that has expired", () => {
    const created = createSession(deps(0, db), 1);

    expect(
      verifySession(deps(HOUR_MS + 1, db), `noctis_session=${created.cookieValue}`),
    ).toBeUndefined();
  });

  it("refuses an unknown, absent, or empty cookie", () => {
    createSession(deps(0, db), 1);

    expect(verifySession(deps(0, db), "noctis_session=nonsense")).toBeUndefined();
    expect(verifySession(deps(0, db), undefined)).toBeUndefined();
    expect(verifySession(deps(0, db), "noctis_session=")).toBeUndefined();
  });

  it("refuses the value under a different cookie name", () => {
    const created = createSession(deps(0, db), 1);

    expect(verifySession(deps(0, db), `other=${created.cookieValue}`)).toBeUndefined();
  });

  it("revokes a session so the same cookie stops working", () => {
    const created = createSession(deps(0, db), 1);
    const cookie = `noctis_session=${created.cookieValue}`;

    expect(revokeSession(deps(0, db), cookie)).toBe(true);
    expect(verifySession(deps(0, db), cookie)).toBeUndefined();
    expect(revokeSession(deps(0, db), cookie)).toBe(false);
  });

  it("deletes expired rows on the way past, so the table cannot grow without bound", () => {
    createSession(deps(0, db), 1);
    createSession(deps(HOUR_MS * 2, db), 1);

    const count = db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };

    expect(count.c).toBe(1);
  });
});
```

- [ ] **Step 8: Run it and watch it fail**

Run: `npx vitest run apps/core/src/api/session.test.ts`

Expected: FAIL — `Failed to resolve import "./session.js"`.

- [ ] **Step 9: Write `session.ts`**

Create `apps/core/src/api/session.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

import type { Clock, IdFactory } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";

import { parseCookies } from "./cookie.js";

export const SESSION_COOKIE = "noctis_session";

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
 */
export function createSession(deps: SessionDeps, ttlHours: number): CreatedSession {
  const nowMs = deps.clock.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlHours * 3_600_000).toISOString();

  // Opportunistic: a core that is never logged into again never grows this
  // table, and one that is cleans it on the way past. No scheduler for one
  // DELETE.
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
```

- [ ] **Step 10: Run it and watch it pass**

Run: `npx vitest run apps/core/src/api/session.test.ts`

Expected: PASS, 8 tests.

- [ ] **Step 11: Write the failing authorisation test**

Append to `apps/core/src/api/auth.test.ts`, adding `authorize` to the `./auth.js` import and `hashSecret` from `./session.js`:

```ts
describe("authorize", () => {
  const token = "a".repeat(32);
  const session = { id: "sess-1", csrfHash: "hash-of-csrf" };
  const found = () => session;
  const none = () => undefined;

  it("accepts the bearer token without asking for a session", () => {
    expect(
      authorize({
        method: "POST",
        authorization: `Bearer ${token}`,
        cookie: undefined,
        csrfHeader: undefined,
        token,
        session: none,
      }),
    ).toEqual({ kind: "bearer" });
  });

  it("accepts a session on a read without a csrf header", () => {
    expect(
      authorize({
        method: "GET",
        authorization: undefined,
        cookie: "noctis_session=v",
        csrfHeader: undefined,
        token,
        session: found,
      }),
    ).toEqual({ kind: "session", id: "sess-1" });
  });

  it("refuses a session mutation with no csrf header", () => {
    expect(
      authorize({
        method: "POST",
        authorization: undefined,
        cookie: "noctis_session=v",
        csrfHeader: undefined,
        token,
        session: found,
      }),
    ).toEqual({ kind: "denied", reason: "csrf" });
  });

  it("refuses a session mutation whose csrf header does not match", () => {
    expect(
      authorize({
        method: "POST",
        authorization: undefined,
        cookie: "noctis_session=v",
        csrfHeader: "wrong",
        token,
        session: found,
      }),
    ).toEqual({ kind: "denied", reason: "csrf" });
  });

  it("accepts a session mutation whose csrf header hashes to the stored digest", () => {
    const csrf = "the-real-csrf";

    expect(
      authorize({
        method: "POST",
        authorization: undefined,
        cookie: "noctis_session=v",
        csrfHeader: csrf,
        token,
        session: () => ({ id: "sess-1", csrfHash: hashSecret(csrf) }),
      }),
    ).toEqual({ kind: "session", id: "sess-1" });
  });

  it("refuses when neither credential is presented", () => {
    expect(
      authorize({
        method: "GET",
        authorization: undefined,
        cookie: undefined,
        csrfHeader: undefined,
        token,
        session: none,
      }),
    ).toEqual({ kind: "denied", reason: "unauthorized" });
  });

  it("refuses a wrong bearer token even when a valid session exists, rather than silently downgrading", () => {
    expect(
      authorize({
        method: "GET",
        authorization: "Bearer wrong",
        cookie: "noctis_session=v",
        csrfHeader: undefined,
        token,
        session: found,
      }),
    ).toEqual({ kind: "denied", reason: "unauthorized" });
  });
});
```

- [ ] **Step 12: Run it and watch it fail**

Run: `npx vitest run apps/core/src/api/auth.test.ts`

Expected: FAIL — `authorize is not a function`.

- [ ] **Step 13: Add `authorize` to `auth.ts`**

Append to `apps/core/src/api/auth.ts`:

```ts
import type { VerifiedSession } from "./session.js";
import { hashSecret } from "./session.js";

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

  if (input.csrfHeader === undefined || hashSecret(input.csrfHeader) !== session.csrfHash) {
    return { kind: "denied", reason: "csrf" };
  }

  return { kind: "session", id: session.id };
}
```

- [ ] **Step 14: Run it and watch it pass**

Run: `npx vitest run apps/core/src/api/auth.test.ts`

Expected: PASS — the original bearer tests plus 7 new ones.

- [ ] **Step 15: Add the session TTL to the core config**

In `apps/core/src/config/server.ts`, add to the config interface:

```ts
/** How long a browser session lasts. A phone should not be asked to log in weekly. */
sessionTtlHours: number;
```

and inside `loadCoreConfig`, beside the other numeric variables:

```ts
const DEFAULT_SESSION_TTL_HOURS = 720;

const ttlRaw = env.NOCTIS_SESSION_TTL_HOURS;
const sessionTtlHours = ttlRaw === undefined ? DEFAULT_SESSION_TTL_HOURS : Number(ttlRaw);

if (!Number.isInteger(sessionTtlHours) || sessionTtlHours < 1 || sessionTtlHours > 8760) {
  throw new ConfigurationError(
    "NOCTIS_SESSION_TTL_HOURS must be a whole number of hours between 1 and 8760",
  );
}
```

Add `sessionTtlHours` to the returned object, and this case to `apps/core/src/config/server.test.ts`:

```ts
it("defaults the session lifetime to thirty days and rejects a fractional one", () => {
  expect(loadCoreConfig(env({})).sessionTtlHours).toBe(720);
  expect(() => loadCoreConfig(env({ NOCTIS_SESSION_TTL_HOURS: "1.5" }))).toThrow(
    ConfigurationError,
  );
});
```

- [ ] **Step 16: Wire the credential check in `http.ts`**

Replace the bearer gate inside `handleRequest`. Order stays: health, origin, **then** credential, then routing.

```ts
// `/session/login` runs before the credential check, because presenting the
// token in the body is how a browser obtains one. It is a POST with no
// session, so the CSRF rule cannot apply to it either.
const isLogin = req.method === "POST" && url.pathname === "/session/login";
const isPair = req.method === "POST" && url.pathname === PAIR_PATH;

if (!isLogin && !isPair) {
  const decision = authorize({
    method: req.method ?? "GET",
    authorization: req.headers.authorization,
    cookie: req.headers.cookie,
    csrfHeader: headerValue(req.headers["x-noctis-csrf"]),
    token: deps.config.token,
    session: (cookie) => verifySession(sessionDeps(deps), cookie),
  });

  if (decision.kind === "denied") {
    logger.log("warn", "rejected request", { reason: decision.reason });
    send(
      res,
      decision.reason === "csrf" ? 403 : 401,
      decision.reason === "csrf"
        ? errorBody("csrf_required", "A matching X-Noctis-CSRF header is required")
        : errorBody("unauthorized", "A valid bearer token or session is required"),
      correlationId,
    );
    return;
  }
}
```

Add these helpers near the other module-level functions:

```ts
function headerValue(raw: string | string[] | undefined): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

function sessionDeps(deps: ApiDeps): SessionDeps {
  return { db: deps.kernel.db, clock: deps.kernel.clock, ids: deps.kernel.ids };
}
```

- [ ] **Step 17: Handle the two session routes**

After the body has been read and parsed, beside the `isPair` branch:

```ts
if (isLogin) {
  const parsed = LoginBodySchema.safeParse(body);

  if (!parsed.success) {
    send(res, 400, errorBody("invalid_request", "Body must be {token}"), correlationId);
    return;
  }

  // The same constant-time comparison the bearer realm uses. A failed login
  // says only that it failed.
  if (!isAuthorized(`Bearer ${parsed.data.token}`, deps.config.token)) {
    logger.log("warn", "rejected session login");
    send(res, 401, errorBody("unauthorized", "The token is not valid"), correlationId);
    return;
  }

  const created = createSession(sessionDeps(deps), deps.config.sessionTtlHours);

  res.setHeader(
    "set-cookie",
    serializeCookie(SESSION_COOKIE, created.cookieValue, {
      httpOnly: true,
      // Tailscale Serve terminates TLS, so the browser always sees HTTPS.
      secure: true,
      sameSite: "Strict",
      path: "/",
      maxAgeSeconds: deps.config.sessionTtlHours * 3600,
    }),
  );

  logger.log("info", "session established");
  send(res, 200, { csrf: created.csrf }, correlationId);
  return;
}

if (req.method === "POST" && url.pathname === "/session/logout") {
  const revoked = revokeSession(sessionDeps(deps), req.headers.cookie);

  res.setHeader(
    "set-cookie",
    serializeCookie(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
      maxAgeSeconds: 0,
    }),
  );

  send(res, 200, { status: revoked ? "revoked" : "no_session" }, correlationId);
  return;
}
```

Define the schema beside the other request schemas:

```ts
const LoginBodySchema = z.object({ token: z.string().min(1) }).strict();
```

- [ ] **Step 18: Write the failing integration test**

Append to `apps/core/src/api/headless.integration.test.ts`. Read the top of that file first and reuse its existing `base`, `TOKEN`, and command names rather than inventing new ones — `objective.create` and its body shape below are placeholders for whatever the suite already creates.

```ts
it("refuses a page with no credential, issues one for the right token, then serves reads and gated mutations", async () => {
  const denied = await fetch(`${base}/objectives`);
  expect(denied.status).toBe(401);

  const bad = await fetch(`${base}/session/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "wrong" }),
  });
  expect(bad.status).toBe(401);
  expect(bad.headers.get("set-cookie")).toBe(null);

  const loginResponse = await fetch(`${base}/session/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
  expect(loginResponse.status).toBe(200);

  const setCookie = loginResponse.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Secure");

  const { csrf } = (await loginResponse.json()) as { csrf: string };
  const cookie = setCookie.split(";")[0] ?? "";

  expect((await fetch(`${base}/objectives`, { headers: { cookie } })).status).toBe(200);

  const withoutCsrf = await fetch(`${base}/commands/objective.create`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "k1", title: "t" }),
  });
  expect(withoutCsrf.status).toBe(403);

  const withCsrf = await fetch(`${base}/commands/objective.create`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-noctis-csrf": csrf },
    body: JSON.stringify({ idempotencyKey: "k1", title: "t" }),
  });
  expect(withCsrf.status).toBe(200);

  await fetch(`${base}/session/logout`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-noctis-csrf": csrf },
    body: "{}",
  });

  expect((await fetch(`${base}/objectives`, { headers: { cookie } })).status).toBe(401);
});
```

Extract the login steps into a `login()` helper in this file — Task 2 needs it too.

- [ ] **Step 19: Run it and watch it pass**

Run: `npx vitest run apps/core/src/api/headless.integration.test.ts`

Expected: PASS. `fetch` sends no `Origin` header for a same-process request, which `isOriginAllowed` already permits, so the origin gate does not interfere.

- [ ] **Step 20: Full gate**

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build`

Expected: all green.

- [ ] **Step 21: Commit**

```bash
git add apps/core/migrations/0007_sessions.sql apps/core/src/api apps/core/src/config
git commit -m "feat(core): a browser can hold a session where it cannot hold a token"
```

---

## Task 2: The live channel — server-sent events

`/events` is a poll: one request per interval, delivering at interval latency, and it never carries token deltas because those are never written to the ledger (ADR-0022). This task gives the core one stream carrying both — committed events replayed from a cursor, then live events and `runtime_delta` frames as they happen.

`EventSource` cannot set headers, which is exactly why Task 1 came first.

**Files:**

- Create: `apps/core/src/api/sse.ts`
- Create: `apps/core/src/api/sse.test.ts`
- Modify: `apps/core/src/nodes/runtime-frames.ts` — expose the existing fan-out as a `FrameSource`
- Modify: `apps/core/src/api/ws.ts` — consume that same `FrameSource` instead of its own closure
- Modify: `apps/core/src/api/http.ts` — route `GET /events/live`
- Modify: `apps/core/src/api/headless.integration.test.ts` — one live-stream case

**Interfaces:**

- Consumes: `authorize` and `verifySession` from Task 1; `deps.kernel.broker` (`subscribe(listener) => () => void`); the function the existing `/events` read branch already uses to page the ledger; `ServerFrame` from `@noctis/contracts`.
- Produces:
  - `formatSseMessage(event: string, data: unknown): string`
  - `openEventStream(deps: StreamDeps, res: ServerResponse, afterSequence: number): () => void` — returns the close function
  - `type FrameSource = { subscribe: (listener: (frame: ServerFrame) => void) => () => void }`
  - `type StreamDeps = { broker: EventBroker; readEvents: (afterSequence: number, limit: number) => readonly OrchestrationEvent[]; frames: FrameSource; heartbeatMs: number; setInterval: typeof setInterval; clearInterval: typeof clearInterval }`
  - `deps.frames: FrameSource` added to `ApiDeps`

- [ ] **Step 1: Find the frame source the core already has**

Read `apps/core/src/api/ws.ts` and `apps/core/src/nodes/runtime-frames.ts`. `/ws/clients` already fans `runtime_delta` out to connected clients. The SSE route must subscribe to the **same** source, not a second one — two independent fan-outs would drift the moment one gains a filter the other lacks.

If the fan-out is a closure inside `ws.ts`, extract it into `runtime-frames.ts` as a `FrameSource` and have both `ws.ts` and the new `sse.ts` consume it. Add it to `ApiDeps` as `frames`.

Expected outcome: `deps.frames` exists, `ws.ts` behaves identically, and `npx vitest run apps/core` is still green before any new behaviour is added.

- [ ] **Step 2: Write the failing framing test**

Create `apps/core/src/api/sse.test.ts`:

```ts
import type { ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { formatSseMessage, openEventStream } from "./sse.js";

function fakeResponse() {
  const chunks: string[] = [];

  const res = {
    writableEnded: false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: vi.fn(),
  } as unknown as ServerResponse;

  return { chunks, res };
}

const idleFrames = { subscribe: () => () => undefined };

function event(sequence: number) {
  return {
    sequence,
    name: "objective.created.v1",
    payload: {},
    occurredAt: "2026-09-16T00:00:00.000Z",
    streamType: "objective",
    streamId: "o1",
  } as never;
}

describe("formatSseMessage", () => {
  it("writes an event name, a single data line, and a blank line", () => {
    expect(formatSseMessage("event", { a: 1 })).toBe('event: event\ndata: {"a":1}\n\n');
  });

  it("never emits a bare newline inside data, which would end the message early", () => {
    const message = formatSseMessage("event", { text: "one\ntwo" });

    expect(message.split("\n\n")).toHaveLength(2);
    expect(message).toContain("one\\ntwo");
  });
});

describe("openEventStream", () => {
  it("replays committed events after the cursor", () => {
    const { res, chunks } = fakeResponse();

    openEventStream(
      {
        broker: { subscribe: () => () => undefined, publish: () => undefined, listenerCount: 0 },
        readEvents: () => [event(4), event(5)],
        frames: idleFrames,
        heartbeatMs: 15_000,
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
      },
      res,
      3,
    );

    expect(chunks.join("")).toContain('"sequence":4');
    expect(chunks.join("")).toContain('"sequence":5');
  });

  it("drops a live event at or below the replayed cursor, so a client never sees one twice", () => {
    const { res, chunks } = fakeResponse();
    let publish: ((events: readonly never[]) => void) | undefined;

    openEventStream(
      {
        broker: {
          subscribe: (listener) => {
            publish = listener as never;
            return () => undefined;
          },
          publish: () => undefined,
          listenerCount: 0,
        },
        readEvents: () => [event(4)],
        frames: idleFrames,
        heartbeatMs: 15_000,
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
      },
      res,
      3,
    );

    const before = chunks.length;
    publish?.([event(4), event(5)]);

    expect(chunks).toHaveLength(before + 1);
    expect(chunks.at(-1)).toContain('"sequence":5');
  });

  it("delivers a frame under its own event name, so a client can tell the channels apart", () => {
    const { res, chunks } = fakeResponse();
    let emit: ((frame: unknown) => void) | undefined;

    openEventStream(
      {
        broker: { subscribe: () => () => undefined, publish: () => undefined, listenerCount: 0 },
        readEvents: () => [],
        frames: {
          subscribe: (listener) => {
            emit = listener as never;
            return () => undefined;
          },
        },
        heartbeatMs: 15_000,
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
      },
      res,
      0,
    );

    emit?.({ type: "runtime_delta", turnId: "t1", text: "hi" });

    expect(chunks.at(-1)).toContain("event: frame");
    expect(chunks.at(-1)).toContain("runtime_delta");
  });

  it("unsubscribes from both sources and stops the heartbeat when closed", () => {
    const { res } = fakeResponse();
    const stopEvents = vi.fn();
    const stopFrames = vi.fn();
    const stopHeartbeat = vi.fn();

    const close = openEventStream(
      {
        broker: { subscribe: () => stopEvents, publish: () => undefined, listenerCount: 0 },
        readEvents: () => [],
        frames: { subscribe: () => stopFrames },
        heartbeatMs: 15_000,
        setInterval: (() => 7) as never,
        clearInterval: stopHeartbeat,
      },
      res,
      0,
    );

    close();
    close();

    expect(stopEvents).toHaveBeenCalledOnce();
    expect(stopFrames).toHaveBeenCalledOnce();
    expect(stopHeartbeat).toHaveBeenCalledWith(7);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run apps/core/src/api/sse.test.ts`

Expected: FAIL — `Failed to resolve import "./sse.js"`.

- [ ] **Step 4: Write `sse.ts`**

Create `apps/core/src/api/sse.ts`:

```ts
import type { ServerResponse } from "node:http";

import type { OrchestrationEvent, ServerFrame } from "@noctis/contracts";

import type { EventBroker } from "../events/broker.js";

/** The core caps a page at 500 (`MAX_PAGE_SIZE`); replay asks for the same. */
const REPLAY_LIMIT = 500;

export interface FrameSource {
  subscribe: (listener: (frame: ServerFrame) => void) => () => void;
}

export interface StreamDeps {
  broker: EventBroker;
  readEvents: (afterSequence: number, limit: number) => readonly OrchestrationEvent[];
  frames: FrameSource;
  heartbeatMs: number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

/**
 * `JSON.stringify` escapes every newline inside the payload, so the encoded body
 * is always one line. That matters: a raw newline in a `data:` line would end the
 * SSE message early and the client would parse half a frame as a whole one.
 */
export function formatSseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * One stream carrying both channels.
 *
 * Committed events are replayed from the cursor first and deduplicated against
 * the live feed, so a client that reconnects sees every event exactly once.
 * `runtime_delta` frames are unsequenced by design (ADR-0022): they are never
 * replayed, and a client that missed one simply missed it.
 */
export function openEventStream(
  deps: StreamDeps,
  res: ServerResponse,
  afterSequence: number,
): () => void {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  // Tailscale Serve is a reverse proxy; without this it may buffer the response
  // and deliver nothing until it ends, which for a stream is never.
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();

  let highest = afterSequence;

  const write = (message: string): void => {
    if (!res.writableEnded) {
      res.write(message);
    }
  };

  for (const event of deps.readEvents(afterSequence, REPLAY_LIMIT)) {
    highest = Math.max(highest, event.sequence);
    write(formatSseMessage("event", event));
  }

  const stopEvents = deps.broker.subscribe((events) => {
    for (const event of events) {
      if (event.sequence <= highest) {
        continue;
      }

      highest = event.sequence;
      write(formatSseMessage("event", event));
    }
  });

  const stopFrames = deps.frames.subscribe((frame) => {
    write(formatSseMessage("frame", frame));
  });

  // A comment line keeps the connection alive through a proxy that would time an
  // idle one out. Clients ignore it.
  const heartbeat = deps.setInterval(() => {
    write(": ping\n\n");
  }, deps.heartbeatMs);

  let closed = false;

  return () => {
    if (closed) {
      return;
    }

    closed = true;
    stopEvents();
    stopFrames();
    deps.clearInterval(heartbeat);

    if (!res.writableEnded) {
      res.end();
    }
  };
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run apps/core/src/api/sse.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 6: Route `GET /events/live` in `http.ts`**

Place this **before** the generic `if (req.method === "GET")` read branch, since that branch answers with a single JSON body and would consume the path:

```ts
if (req.method === "GET" && url.pathname === "/events/live") {
  const cursor = Number(url.searchParams.get("afterSequence") ?? "0");

  if (!Number.isInteger(cursor) || cursor < 0) {
    send(
      res,
      400,
      errorBody("invalid_request", "afterSequence must be a whole number"),
      correlationId,
    );
    return;
  }

  const close = openEventStream(
    {
      broker: deps.kernel.broker,
      readEvents: (after, limit) => readEventsAfter(deps.kernel.db, after, limit),
      frames: deps.frames,
      heartbeatMs: HEARTBEAT_MS,
      setInterval,
      clearInterval,
    },
    res,
    cursor,
  );

  req.on("close", close);
  req.on("error", close);
  return;
}
```

`readEventsAfter` above is a stand-in name: use whatever function the existing `GET /events` read branch already calls to page the ledger (find it at `apps/core/src/api/http.ts`, the `segments[0] === "events"` branch in `handleRead`). Reuse it rather than writing a second query — two ways to read the ledger is two things to keep in step. Add `const HEARTBEAT_MS = 15_000;` beside the other module constants.

- [ ] **Step 7: Write the failing integration test**

Append to `apps/core/src/api/headless.integration.test.ts`, using the `login()` helper extracted in Task 1:

```ts
it("streams a committed event to a logged-in browser over SSE", async () => {
  const { cookie, csrf } = await login();
  const controller = new AbortController();

  const stream = await fetch(`${base}/events/live?afterSequence=0`, {
    headers: { cookie, accept: "text/event-stream" },
    signal: controller.signal,
  });

  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toContain("text/event-stream");

  const reader = stream.body?.getReader();
  expect(reader).toBeDefined();

  await fetch(`${base}/commands/objective.create`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-noctis-csrf": csrf },
    body: JSON.stringify({ idempotencyKey: "sse-1", title: "streamed" }),
  });

  const decoder = new TextDecoder();
  let seen = "";

  while (!seen.includes("objective.created.v1")) {
    const chunk = await reader?.read();

    if (chunk?.done === true) {
      break;
    }

    seen += decoder.decode(chunk?.value ?? new Uint8Array(), { stream: true });
  }

  expect(seen).toContain("event: event");
  expect(seen).toContain("objective.created.v1");

  controller.abort();
});

it("refuses the stream to a browser with no session", async () => {
  const response = await fetch(`${base}/events/live?afterSequence=0`);

  expect(response.status).toBe(401);
});
```

- [ ] **Step 8: Run it and watch it pass**

Run: `npx vitest run apps/core/src/api/headless.integration.test.ts`

Expected: PASS. A hang means the response is being buffered — check that `flushHeaders()` is called and that nothing compresses the response.

- [ ] **Step 9: Full gate and commit**

```bash
npm run format:check && npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build
git add apps/core/src/api apps/core/src/nodes
git commit -m "feat(core): one stream for committed events and live deltas"
```

---

## Task 3: `SessionTransport` — the page that holds no token

`BrowserTransport` holds the core token and polls `/events`. That was honest for a development page on loopback; it is wrong for a phone. This task adds a second `CoreTransport` that authenticates with the cookie, sends the CSRF header on mutations, and receives events over SSE — and makes `core-client.ts` choose it whenever no token is configured.

`BrowserTransport` stays for local development. Its own `ponytail:` comment — "if this ever becomes a shipped surface, give the core a browser-usable credential rather than making the poll faster" — is what this task does.

**Files:**

- Create: `apps/web/src/session/login.ts`
- Create: `apps/web/src/session/login.test.ts`
- Create: `apps/web/src/session/Login.tsx`
- Create: `apps/web/src/transport/SessionTransport.ts`
- Create: `apps/web/src/transport/SessionTransport.test.ts`
- Modify: `apps/web/src/core-client.ts`
- Modify: `apps/web/src/App.tsx` — show `Login` until a session exists

**Interfaces:**

- Consumes: `CoreTransport`, `CoreMethod`, `CoreResponse`, `SubscribeOptions`, `Subscription`, `resolveCoreUrl`, `parseCoreBody`, `isEvent` from `./CoreTransport.js`; `ServerFrameSchema` from `@noctis/contracts`.
- Produces:
  - `login(baseUrl: string, token: string, fetchImpl?: Fetch): Promise<{ csrf: string }>`
  - `class LoginRefused extends Error`
  - `class SessionTransport implements CoreTransport`, constructed with `{ baseUrl: string; csrf: string; fetch?: Fetch; EventSourceImpl?: typeof EventSource }`
  - `resolveCoreTransport(csrf?: string): CoreTransport` — the existing export, now taking an optional CSRF value
  - `class CoreTransportUnavailable extends Error`

- [ ] **Step 1: Write the failing login test**

Create `apps/web/src/session/login.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { login } from "./login.js";

function respond(status: number, body: unknown) {
  return vi.fn(async () => ({ status, text: async () => JSON.stringify(body) }));
}

describe("login", () => {
  it("posts the token and returns the csrf the core issued", async () => {
    const fetchImpl = respond(200, { csrf: "csrf-value" });

    await expect(login("https://core.example", "the-token", fetchImpl as never)).resolves.toEqual({
      csrf: "csrf-value",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://core.example/session/login",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ token: "the-token" }),
      }),
    );
  });

  it("rejects a refused token rather than returning a transport with no session", async () => {
    const fetchImpl = respond(401, { error: { code: "unauthorized" } });

    await expect(login("https://core.example", "wrong", fetchImpl as never)).rejects.toThrow(
      /unauthorized/i,
    );
  });

  it("rejects a 200 that carries no csrf, which would leave every mutation refused", async () => {
    const fetchImpl = respond(200, {});

    await expect(login("https://core.example", "t", fetchImpl as never)).rejects.toThrow(/csrf/i);
  });

  it("never puts the token in the URL, where a proxy log would keep it", async () => {
    const fetchImpl = respond(200, { csrf: "c" });

    await login("https://core.example", "secret-token", fetchImpl as never);

    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("secret-token");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/web/src/session/login.test.ts`

Expected: FAIL — `Failed to resolve import "./login.js"`.

- [ ] **Step 3: Write `login.ts`**

Create `apps/web/src/session/login.ts`:

```ts
import { parseCoreBody, resolveCoreUrl } from "../transport/CoreTransport.js";

type Fetch = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number; text: () => Promise<string> }>;

export class LoginRefused extends Error {}

/**
 * The token leaves the page exactly once, in a request body — never in a URL,
 * where a reverse-proxy access log would keep a copy of it forever.
 *
 * `credentials: "include"` is what lets the browser store the `Set-Cookie` the
 * core answers with. Everything after this call authenticates with that cookie
 * and the returned CSRF value; the token is never needed again.
 */
export async function login(
  baseUrl: string,
  token: string,
  fetchImpl: Fetch = (url, init) => fetch(url, init),
): Promise<{ csrf: string }> {
  const url = resolveCoreUrl(baseUrl, "/session/login");
  const response = await fetchImpl(url.href, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });

  const body = parseCoreBody(await response.text());

  if (response.status !== 200) {
    throw new LoginRefused(
      response.status === 401
        ? "unauthorized: the token is not valid"
        : `login failed (${String(response.status)})`,
    );
  }

  const csrf = (body as { csrf?: unknown }).csrf;

  if (typeof csrf !== "string" || csrf === "") {
    throw new LoginRefused("the core issued no csrf token");
  }

  return { csrf };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run apps/web/src/session/login.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing transport test**

Create `apps/web/src/transport/SessionTransport.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionTransport } from "./SessionTransport.js";

class FakeEventSource {
  static last: FakeEventSource | undefined;

  readonly listeners = new Map<string, (event: MessageEvent) => void>();
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly init: EventSourceInit,
  ) {
    FakeEventSource.last = this;
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(name, listener);
  }

  emit(name: string, data: unknown): void {
    this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  close(): void {
    this.closed = true;
  }
}

function transport(fetchImpl = vi.fn(async () => ({ status: 200, text: async () => "{}" }))) {
  return {
    fetchImpl,
    subject: new SessionTransport({
      baseUrl: "https://core.example",
      csrf: "csrf-value",
      fetch: fetchImpl as never,
      EventSourceImpl: FakeEventSource as never,
    }),
  };
}

const committed = {
  sequence: 13,
  name: "objective.created.v1",
  payload: {},
  occurredAt: "2026-09-16T00:00:00.000Z",
  streamType: "objective",
  streamId: "o1",
};

describe("SessionTransport", () => {
  beforeEach(() => {
    FakeEventSource.last = undefined;
  });

  it("sends the cookie and no authorization header on a read", async () => {
    const { subject, fetchImpl } = transport();
    await subject.request("GET", "/objectives");

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;

    expect(init.credentials).toBe("include");
    expect(JSON.stringify(init.headers ?? {})).not.toContain("authorization");
  });

  it("adds the csrf header to a mutation and not to a read", async () => {
    const { subject, fetchImpl } = transport();

    await subject.request("GET", "/objectives");
    await subject.request("POST", "/commands/objective.create", { idempotencyKey: "k" });

    expect(JSON.stringify(fetchImpl.mock.calls[0]?.[1])).not.toContain("x-noctis-csrf");
    expect(JSON.stringify(fetchImpl.mock.calls[1]?.[1])).toContain("x-noctis-csrf");
  });

  it("opens the stream at the caller's cursor and delivers committed events", async () => {
    const received: unknown[] = [];
    await transport().subject.subscribe({
      afterSequence: 12,
      onEvent: (event) => received.push(event),
    });

    expect(FakeEventSource.last?.url).toContain("afterSequence=12");
    expect(FakeEventSource.last?.init.withCredentials).toBe(true);

    FakeEventSource.last?.emit("event", committed);

    expect(received).toHaveLength(1);
  });

  it("delivers a runtime_delta as a frame, never as an event", async () => {
    const events: unknown[] = [];
    const frames: unknown[] = [];

    await transport().subject.subscribe({
      afterSequence: 0,
      onEvent: (event) => events.push(event),
      onFrame: (frame) => frames.push(frame),
    });

    FakeEventSource.last?.emit("frame", { type: "runtime_delta", turnId: "t1", text: "hello" });

    expect(events).toHaveLength(0);
    expect(frames).toHaveLength(1);
  });

  it("ignores a frame that does not parse, rather than handing the page a malformed one", async () => {
    const frames: unknown[] = [];

    await transport().subject.subscribe({
      afterSequence: 0,
      onEvent: () => undefined,
      onFrame: (frame) => frames.push(frame),
    });

    FakeEventSource.last?.emit("frame", { type: "not_a_frame" });

    expect(frames).toHaveLength(0);
  });

  it("closes the stream when the subscription is closed", async () => {
    const subscription = await transport().subject.subscribe({
      afterSequence: 0,
      onEvent: () => undefined,
    });

    subscription.close();

    expect(FakeEventSource.last?.closed).toBe(true);
  });

  it("reports a stream error to the caller rather than failing silently", async () => {
    const errors: unknown[] = [];

    await transport().subject.subscribe({
      afterSequence: 0,
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
    });

    FakeEventSource.last?.onerror?.(new Event("error"));

    expect(errors).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run apps/web/src/transport/SessionTransport.test.ts`

Expected: FAIL — `Failed to resolve import "./SessionTransport.js"`.

- [ ] **Step 7: Write `SessionTransport.ts`**

Create `apps/web/src/transport/SessionTransport.ts`:

```ts
import type { OrchestrationEvent } from "@noctis/contracts";
import { ServerFrameSchema } from "@noctis/contracts";

import type {
  CoreMethod,
  CoreResponse,
  CoreTransport,
  SubscribeOptions,
  Subscription,
} from "./CoreTransport.js";
import { isEvent, parseCoreBody, resolveCoreUrl } from "./CoreTransport.js";

type Fetch = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface SessionTransportOptions {
  baseUrl: string;
  /** Returned by `login` once. Held in memory only — never a cookie, never storage. */
  csrf: string;
  fetch?: Fetch;
  EventSourceImpl?: typeof EventSource;
}

/**
 * The transport a page uses when it holds no token.
 *
 * The credential is the `HttpOnly` cookie the browser attaches on its own, so
 * script never touches it: an XSS that reads every variable in this file still
 * cannot exfiltrate a usable credential. The CSRF value it *can* read is useless
 * without the cookie, which `SameSite=Strict` will not send cross-site.
 */
export class SessionTransport implements CoreTransport {
  readonly #baseUrl: string;
  readonly #csrf: string;
  readonly #fetch: Fetch;
  readonly #EventSource: typeof EventSource;

  constructor(options: SessionTransportOptions) {
    this.#baseUrl = options.baseUrl;
    this.#csrf = options.csrf;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#EventSource = options.EventSourceImpl ?? EventSource;
  }

  async request(method: CoreMethod, path: string, body?: unknown): Promise<CoreResponse> {
    const url = resolveCoreUrl(this.#baseUrl, path);
    const headers: Record<string, string> = {};

    if (method !== "GET") {
      headers["x-noctis-csrf"] = this.#csrf;
    }

    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await this.#fetch(url.href, {
      method,
      credentials: "include",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: parseCoreBody(await response.text()) };
  }

  subscribe(options: SubscribeOptions): Promise<Subscription> {
    const url = resolveCoreUrl(this.#baseUrl, "/events/live");
    url.searchParams.set("afterSequence", String(options.afterSequence));

    const source = new this.#EventSource(url.href, { withCredentials: true });

    source.addEventListener("event", (message) => {
      const parsed = parseCoreBody((message as MessageEvent<string>).data);

      if (isEvent(parsed)) {
        options.onEvent(parsed as OrchestrationEvent);
      }
    });

    source.addEventListener("frame", (message) => {
      const parsed = ServerFrameSchema.safeParse(
        parseCoreBody((message as MessageEvent<string>).data),
      );

      if (parsed.success) {
        options.onFrame?.(parsed.data);
      }
    });

    source.onerror = (error) => {
      // The browser reconnects an EventSource on its own and resumes from the
      // cursor in the URL, so this reports the gap rather than tearing down.
      options.onError?.(error);
    };

    return Promise.resolve({
      close: () => {
        source.close();
      },
    });
  }
}
```

- [ ] **Step 8: Run it and watch it pass**

Run: `npx vitest run apps/web/src/transport/SessionTransport.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 9: Write `Login.tsx`**

Read `apps/web/src/pages/Settings.tsx` first and match its form idiom exactly — the same input styling, the same button, the same error presentation, the same `@noctis/ui` tokens (`depth`, `typography`, `spacing`). Do not introduce a component library or a CSS framework.

The screen is one centred card: a heading, one `type="password"` input labelled "Core token", one submit button, and one error line. On submit it calls `login(baseUrl, token)`; on success it calls `props.onAuthenticated(csrf)`; on `LoginRefused` it shows the message and clears the input. The token is never written to `localStorage`, `sessionStorage`, or a URL.

```tsx
export interface LoginProps {
  baseUrl: string;
  onAuthenticated: (csrf: string) => void;
}
```

- [ ] **Step 10: Choose the transport in `core-client.ts`**

Read the existing file first and keep its Tauri detection, its `baseUrl` resolution, and its exported names. Change only the fallback:

```ts
/**
 * A page that was handed a token is a development page on loopback and keeps the
 * polling transport. A page served over Tailscale Serve has no token, logs in
 * once, and gets the session realm — which is the only transport an EventSource
 * can authenticate at all.
 */
export function resolveCoreTransport(csrf?: string): CoreTransport {
  // …existing Tauri branch stays first and unchanged…

  const token = import.meta.env.VITE_NOCTIS_TOKEN;

  if (typeof token === "string" && token !== "") {
    return new BrowserTransport({ baseUrl, token });
  }

  if (csrf === undefined) {
    throw new CoreTransportUnavailable("This page has no token and no session");
  }

  return new SessionTransport({ baseUrl, csrf });
}

export class CoreTransportUnavailable extends Error {}
```

Export two more functions beside it, so `App.tsx` can decide without catching an exception and can tell `Login` where to post:

```ts
/** True when there is no Tauri bridge and no build-time token: this page must log in. */
export function needsLogin(): boolean;

/** The core's origin, already resolved by the same logic the transports use. */
export function coreBaseUrl(): string;
```

`coreBaseUrl` is the existing `baseUrl` resolution lifted out of `resolveCoreTransport` into its own exported function — move it, do not duplicate it.

- [ ] **Step 11: Gate `App.tsx` behind the session**

`const transport = resolveCoreTransport()` currently runs at module scope. It must now be constructed after login:

```tsx
export function App(): JSX.Element {
  const [csrf, setCsrf] = useState<string>();
  const transport = useMemo(
    () => (needsLogin() && csrf === undefined ? undefined : resolveCoreTransport(csrf)),
    [csrf],
  );

  if (transport === undefined) {
    return <Login baseUrl={coreBaseUrl()} onAuthenticated={setCsrf} />;
  }

  return <Workbench transport={transport} />;
}
```

Move the existing body of `App` — the identity hook, the conversation hook, the rail, the handoff state — into a `Workbench` component in the same file that takes `transport` as a prop. The hooks cannot run before login, and React forbids calling them conditionally, which is why this is a component split rather than an early return.

- [ ] **Step 12: Run the web tests and the E2E suite**

Run: `npx vitest run apps/web && npm run test:e2e`

Expected: PASS. The existing E2E harness sets `VITE_NOCTIS_TOKEN`, so it keeps the `BrowserTransport` path and should need no change. If a test fails because `App` no longer builds the transport at module scope, update the harness to await the workbench rather than reverting the split.

- [ ] **Step 13: Full gate and commit**

```bash
npm run format:check && npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build && npm run test:e2e
git add apps/web/src
git commit -m "feat(web): a page that logs in once and streams thereafter"
```

---

## Task 4: The phone shell — a tab bar under the breakpoint

The rail is a fixed 72 px column of eight items. On a 400 px phone that is 18% of the screen given to navigation, and eight targets stacked vertically are unreachable one-handed. This task collapses the rail to a bottom tab bar below 720 px.

The donor's `MobileTabBar` supplies the **shape** — four primary destinations, a centre action, and a "More" overflow — but none of its code: it is built on Tailwind, `react-router`, `lucide-react`, and `i18next`, and Noctis has none of them. Porting the dependencies to reuse eighty lines of JSX would be the expensive way round. The ledger records what was taken and what was not.

**Files:**

- Create: `packages/ui/src/primitives/tab-items.ts`
- Create: `packages/ui/src/primitives/tab-items.test.ts`
- Create: `packages/ui/src/primitives/TabBar.tsx`
- Create: `apps/web/src/layout/useIsMobile.ts`
- Create: `apps/web/src/layout/useIsMobile.test.ts`
- Create: `apps/web/e2e/phone.test.mjs`
- Modify: `packages/ui/src/index.ts` — export `TabBar`, `TAB_ITEMS`, `tabsFor`
- Modify: `apps/web/src/App.tsx` — render `TabBar` instead of `Rail` when narrow
- Modify: `docs/architecture/DONOR-PORT-LEDGER.md` — rows for `useIsMobile.ts` and `MobileTabBar.tsx`

**Interfaces:**

- Consumes: `RAIL_ITEMS`, `RailItem` from `./rail-items.js`; the design tokens from `../tokens/index.js`.
- Produces:
  - `TAB_ITEMS: readonly RailItem[]` — the four that get a tab
  - `tabsFor(active: RailItem): { tabs: readonly RailItem[]; overflow: readonly RailItem[] }`
  - `function TabBar(props: TabBarProps): JSX.Element` where `TabBarProps = { active: RailItem; onSelect: (item: RailItem) => void; onMore: () => void }`
  - `function useIsMobile(): boolean`

- [ ] **Step 1: Write the ledger rows before the port**

Add two rows to `docs/architecture/DONOR-PORT-LEDGER.md`, following the existing column order exactly. Get the donor commit with:

```bash
git -C "C:/Users/mmush/Documents/Jarvis/Jarvis-Sub-Agent-Dashboard" log -1 --format=%h -- client/src/hooks/useIsMobile.ts client/src/components/MobileTabBar.tsx
```

- `client/src/hooks/useIsMobile.ts` → `apps/web/src/layout/useIsMobile.ts`. **Retained:** the `matchMedia` subscription, the initial synchronous read so the first paint is already correct, and the SSR guard. **Changed:** the breakpoint moves from 767 px to 719 px, because Noctis switches on whether the 72 px rail still fits rather than on a Tailwind tier; the listener is added with the modern `addEventListener` only, since no supported browser needs `addListener`. **Verification:** `apps/web/src/layout/useIsMobile.test.ts`.
- `client/src/components/MobileTabBar.tsx` → `packages/ui/src/primitives/TabBar.tsx`. **Retained:** the information architecture only — a fixed bottom bar, four primary destinations, a centre action that is the phone's front door, a "More" control for everything else, and `env(safe-area-inset-bottom)` padding. **Changed:** no code is copied. Tailwind classes become the existing design tokens, `NavLink` becomes the `onSelect` callback the `Rail` already uses, `lucide-react` icons become the rail's own glyphs, and `i18next` is dropped because Noctis has no translation layer. The centre action opens Chat rather than a separate assistant sheet, because in Noctis Chat _is_ the assistant. **Verification:** `packages/ui/src/primitives/tab-items.test.ts` and `apps/web/e2e/phone.test.mjs`.

Then run the boundary check:

```bash
npm run test:boundary
```

Expected: PASS — the donor tree is untouched.

- [ ] **Step 2: Write the failing tab-selection test**

Create `packages/ui/src/primitives/tab-items.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { RAIL_ITEMS } from "./rail-items.js";
import { TAB_ITEMS, tabsFor } from "./tab-items.js";

describe("tabsFor", () => {
  it("shows the four primary destinations", () => {
    expect(tabsFor("Command").tabs).toEqual(TAB_ITEMS);
  });

  it("puts everything that is not a tab in the overflow", () => {
    const { tabs, overflow } = tabsFor("Command");

    expect([...tabs, ...overflow].sort()).toEqual([...RAIL_ITEMS].sort());
  });

  it("promotes the active item into the bar when it lives in the overflow, so the phone always shows where it is", () => {
    const { tabs, overflow } = tabsFor("Nodes");

    expect(tabs).toContain("Nodes");
    expect(overflow).not.toContain("Nodes");
    expect(tabs).toHaveLength(TAB_ITEMS.length);
  });

  it("drops the last primary tab to make room, never Command or Chat", () => {
    const { tabs } = tabsFor("Nodes");

    expect(tabs).toContain("Command");
    expect(tabs).toContain("Chat");
  });

  it("changes nothing when the active item is already a tab", () => {
    expect(tabsFor("Chat").tabs).toEqual(TAB_ITEMS);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run packages/ui/src/primitives/tab-items.test.ts`

Expected: FAIL — `Failed to resolve import "./tab-items.js"`.

- [ ] **Step 4: Write `tab-items.ts`**

```ts
import type { RailItem } from "./rail-items.js";
import { RAIL_ITEMS } from "./rail-items.js";

/**
 * What a phone is for. Command is where a prompt is written and Chat is where
 * the answer streams, so those two are never displaced; Missions and Vault are
 * the two destinations worth a thumb. The other four reach the phone through
 * "More", which is the donor's own answer to the same problem.
 */
export const TAB_ITEMS = [
  "Command",
  "Chat",
  "Missions",
  "Vault",
] as const satisfies readonly RailItem[];

export interface TabLayout {
  tabs: readonly RailItem[];
  overflow: readonly RailItem[];
}

/**
 * A bar that cannot show where you are is worse than one item short, so an
 * active overflow destination takes the last primary slot for as long as it is
 * active. Command and Chat are never the slot that gives way.
 */
export function tabsFor(active: RailItem): TabLayout {
  const overflow = RAIL_ITEMS.filter((item) => !TAB_ITEMS.includes(item as never));

  if (!overflow.includes(active)) {
    return { tabs: TAB_ITEMS, overflow };
  }

  return {
    tabs: [...TAB_ITEMS.slice(0, TAB_ITEMS.length - 1), active],
    overflow: overflow.filter((item) => item !== active),
  };
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run packages/ui/src/primitives/tab-items.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 6: Write `TabBar.tsx`**

Read `Rail.tsx` first and mirror it: plain `<button>` elements, the same tokens, the same active treatment, the same `aria-label="Primary"` on the `<nav>`. The differences are the axis, the fixed bottom placement, the 44 px minimum target height, `paddingBottom: "env(safe-area-inset-bottom)"`, and a fifth "More" button that calls `props.onMore`.

```tsx
export interface TabBarProps {
  active: RailItem;
  onSelect: (item: RailItem) => void;
  onMore: () => void;
}
```

Export it and `TAB_ITEMS`/`tabsFor` from `packages/ui/src/index.ts` in the style the file already uses (named value export, then the props type).

- [ ] **Step 7: Write the failing `useIsMobile` test**

Create `apps/web/src/layout/useIsMobile.test.ts`:

```ts
import { renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useIsMobile } from "./useIsMobile.js";

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };

  vi.stubGlobal("matchMedia", () => query);

  return {
    query,
    change(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useIsMobile", () => {
  it("reads the viewport synchronously, so the first paint is already correct", () => {
    stubMatchMedia(true);

    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
  });

  it("follows the viewport when it changes", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);

    act(() => {
      media.change(true);
    });

    expect(result.current).toBe(true);
  });

  it("removes its listener on unmount", () => {
    const media = stubMatchMedia(false);
    renderHook(() => useIsMobile()).unmount();

    expect(media.listenerCount()).toBe(0);
  });

  it("is false where matchMedia does not exist, rather than throwing", () => {
    vi.stubGlobal("matchMedia", undefined);

    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
  });
});
```

If `@testing-library/react` is not already a dev dependency of `apps/web`, check first — read `apps/web/package.json`. If it is absent, do **not** add it: rewrite these four cases against a plain function `isMobile(matchMedia)` extracted from the hook, test that, and leave the hook itself as three lines of `useState`/`useEffect` around it.

- [ ] **Step 8: Run it and watch it fail, then write `useIsMobile.ts`**

Run: `npx vitest run apps/web/src/layout/useIsMobile.test.ts`

Expected: FAIL — module not found. Then:

```ts
import { useEffect, useState } from "react";

/**
 * Ported from the donor's `useIsMobile`. The breakpoint is Noctis's own: the
 * rail is 72 px of fixed chrome, and below 720 px that is more of the screen
 * than navigation has earned.
 */
const MOBILE_QUERY = "(max-width: 719px)";

function matches(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(MOBILE_QUERY).matches
    : false;
}

export function useIsMobile(): boolean {
  // Read synchronously, so the first paint is already the right shell rather
  // than a desktop rail that flashes away on the next frame.
  const [isMobile, setIsMobile] = useState(matches);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia(MOBILE_QUERY);
    const onChange = (): void => {
      setIsMobile(query.matches);
    };

    onChange();
    query.addEventListener("change", onChange);

    return () => {
      query.removeEventListener("change", onChange);
    };
  }, []);

  return isMobile;
}
```

Run again. Expected: PASS, 4 tests.

- [ ] **Step 9: Branch the shell in `App.tsx`**

Inside `Workbench` (the component Task 3 split out):

```tsx
const isMobile = useIsMobile();
const [moreOpen, setMoreOpen] = useState(false);
const { tabs, overflow } = tabsFor(active);
```

Render the page area first and the navigation after it in the DOM when mobile — a bottom bar that comes first in source order is the first thing a screen reader announces on every page. The layout switches from `flexDirection: "row"` to `"column"`, and the page area gets `paddingBottom` equal to the bar's height so the last row of content is not covered.

"More" opens a simple sheet listing `overflow`; selecting an item calls `setActive` and closes it. Use a `<dialog>` element — it gives focus trapping and Escape-to-close natively, which is the whole feature without a library.

- [ ] **Step 10: Write the phone E2E test**

Create `apps/web/e2e/phone.test.mjs`, following `apps/web/e2e/chat.test.mjs` exactly for harness setup and teardown. At a 400×860 viewport assert:

1. the rail is not rendered and the tab bar is;
2. every tab button's bounding box is at least 44 px tall;
3. tapping "Chat" shows the Chat page;
4. the page does not scroll horizontally — `document.documentElement.scrollWidth <= 400`;
5. a pending approval's confirm and decline controls are both visible and tappable without horizontal scrolling;
6. at 1280×800 the rail is rendered and the tab bar is not.

- [ ] **Step 11: Run the E2E suite**

Run: `npm run test:e2e`

Expected: PASS, including the existing desktop tests unchanged.

- [ ] **Step 12: Full gate and commit**

```bash
npm run test:boundary
npm run format:check && npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build && npm run test:e2e
git add packages/ui/src apps/web/src apps/web/e2e docs/architecture/DONOR-PORT-LEDGER.md
git commit -m "feat(web): the rail becomes a tab bar where a rail does not fit"
```

---

## Task 5: Web push — the phone hears about it

Decision 0.25: the phone is notified when an approval is waiting, when a turn or Objective finishes or blocks, and later when Sense suggests something. Without this the phone is a screen you have to remember to look at.

Push needs HTTPS, which Tailscale Serve already provides. It also needs VAPID keys, which are a **credential**: the private key never goes in SQLite, never in a log, and never in the repo.

`web-push` is a new dependency. It is the right rung: VAPID JWT signing plus ECDH plus AES128GCM payload encryption is a working afternoon of `node:crypto` to get subtly wrong, and this library is the one the donor already proved against real browsers.

**Files:**

- Create: `apps/core/migrations/0008_push.sql`
- Create: `apps/core/src/notify/push.ts`
- Create: `apps/core/src/notify/push.test.ts`
- Create: `apps/core/src/notify/triggers.ts`
- Create: `apps/core/src/notify/triggers.test.ts`
- Create: `apps/web/public/sw.js`
- Create: `apps/web/src/notify/subscribe.ts`
- Create: `apps/web/src/notify/subscribe.test.ts`
- Modify: `apps/core/package.json` — `"web-push": "3.6.7"`
- Modify: `apps/core/src/config/server.ts` — `NOCTIS_VAPID_PUBLIC_KEY`, `NOCTIS_VAPID_PRIVATE_KEY`, `NOCTIS_VAPID_SUBJECT`
- Modify: `apps/core/src/api/http.ts` — `GET /push/key`, `POST /push/subscribe`, `POST /push/unsubscribe`
- Modify: `apps/core/src/main.ts` — subscribe the notifier to the broker
- Modify: `apps/web/src/pages/Settings.tsx` — a "Notifications" card
- Modify: `docs/architecture/DONOR-PORT-LEDGER.md` — a row for `server/lib/push.js`
- Modify: `docs/operations/work-pc-core.md` — generating and setting the VAPID keys

**Interfaces:**

- Consumes: `deps.kernel.broker`; `OrchestrationEvent` from `@noctis/contracts`; the session id from `authorize` (a subscription belongs to a session).
- Produces:
  - `type PushPayload = { title: string; body: string; url: string; tag: string }`
  - `pushFor(event: OrchestrationEvent): PushPayload | undefined` — pure
  - `createNotifier(deps: NotifierDeps): { subscribe(sessionId: string, subscription: unknown): void; unsubscribe(endpoint: string): void; publicKey(): string | undefined; notify(events: readonly OrchestrationEvent[]): Promise<void> }`
  - `type NotifierDeps = { db: NoctisDatabase; clock: Clock; ids: IdFactory; vapid: VapidKeys | undefined; send: SendPush; logger: Logger }`
  - `type SendPush = (subscription: StoredSubscription, payload: string) => Promise<{ statusCode: number }>`

- [ ] **Step 1: Write the ledger row before the port**

Add a row for `server/lib/push.js` → `apps/core/src/notify/push.ts`. **Retained:** the subscription table shape keyed by endpoint, the send-to-all loop, and the rule that a 404 or 410 from the push service prunes that subscription rather than retrying it. **Changed:** VAPID keys come from the environment and are never written to disk — the donor generated them into a JSON file beside its database, which for Noctis would be a secret in a data directory; there are no push categories, because Noctis pushes only the three events in `triggers.ts` and a category table with one live member is configuration for a value that never changes; the Electron branch is dropped; sending is injected as `SendPush` so the tests never touch the network. **Verification:** `apps/core/src/notify/push.test.ts`.

Run `npm run test:boundary`. Expected: PASS.

- [ ] **Step 2: Write the migration**

Create `apps/core/migrations/0008_push.sql`:

```sql
-- apps/core/migrations/0008_push.sql
-- Slice 2, decision 0.25: the phone hears about an approval, a finished turn,
-- and a blocked one.
--
-- A subscription is a browser's own opaque endpoint plus two public key
-- material fields the push service requires. None of it is a Noctis secret --
-- the VAPID private key is, and that lives in the environment, never here.
CREATE TABLE push_subscriptions (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_push_subscriptions_session ON push_subscriptions (session_id);
```

Run `npm run test:migrations`. Expected: PASS.

- [ ] **Step 3: Write the failing trigger test**

Create `apps/core/src/notify/triggers.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { pushFor } from "./triggers.js";

function event(name: string, payload: Record<string, unknown>) {
  return {
    sequence: 1,
    name,
    payload,
    occurredAt: "2026-09-16T00:00:00.000Z",
    streamType: "identity",
    streamId: "s1",
  } as never;
}

describe("pushFor", () => {
  it("pushes when a decision is recorded as pending, because that is a person being asked", () => {
    const payload = pushFor(
      event("authority.decision_recorded.v1", { decision: "pending", summary: "Delete 3 files" }),
    );

    expect(payload?.title).toContain("Approval");
    expect(payload?.body).toContain("Delete 3 files");
    expect(payload?.url).toBe("/approvals");
  });

  it("does not push when a decision is recorded as confirmed or declined", () => {
    expect(
      pushFor(event("authority.decision_recorded.v1", { decision: "confirmed" })),
    ).toBeUndefined();
    expect(
      pushFor(event("authority.decision_recorded.v1", { decision: "declined" })),
    ).toBeUndefined();
  });

  it("pushes a failed or blocked turn", () => {
    expect(pushFor(event("identity.turn_completed.v1", { status: "failed" }))?.title).toContain(
      "failed",
    );
    expect(pushFor(event("identity.turn_completed.v1", { status: "blocked" }))?.title).toContain(
      "blocked",
    );
  });

  it("does not push an ordinary successful turn, which would make the phone buzz all day", () => {
    expect(pushFor(event("identity.turn_completed.v1", { status: "succeeded" }))).toBeUndefined();
  });

  it("ignores every other event", () => {
    expect(pushFor(event("objective.created.v1", {}))).toBeUndefined();
    expect(pushFor(event("node.connected.v1", {}))).toBeUndefined();
  });

  it("tags by stream so a second push about the same thing replaces the first", () => {
    const payload = pushFor(event("authority.decision_recorded.v1", { decision: "pending" }));

    expect(payload?.tag).toBe("s1");
  });
});
```

Read the real payload shapes in `packages/contracts/src/events.ts` first and correct the field names above to match — `decision` and `status` are the expected names, but the contracts file is authoritative.

- [ ] **Step 4: Run it, watch it fail, write `triggers.ts`**

Run: `npx vitest run apps/core/src/notify/triggers.test.ts` → FAIL, module not found.

`pushFor` is a pure `switch` on `event.name` returning `PushPayload | undefined`. Keep the three cases and nothing else:

```ts
// ponytail: three events, hard-coded. A category table with one live member is
// configuration for a value that never changes; add one when Sense (Slice 4)
// gives the second producer.
```

Run again. Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing notifier test**

Create `apps/core/src/notify/push.test.ts`. The `send` function is injected, so nothing reaches the network. Cover:

1. `publicKey()` returns `undefined` when no VAPID keys are configured, and `notify` sends nothing — a core with no keys is quietly without push, never broken.
2. `subscribe` stores one row; subscribing the same endpoint twice leaves one row (`ON CONFLICT (endpoint) DO UPDATE`).
3. `notify` sends one message per stored subscription, with `pushFor`'s payload as the JSON body.
4. `notify` sends nothing at all for an event `pushFor` ignores — not an empty send, no send.
5. A `send` that resolves `{ statusCode: 410 }` deletes that subscription; the next `notify` skips it.
6. A `send` that resolves `{ statusCode: 500 }` keeps the subscription — a push service having a bad day is not a dead browser.
7. A `send` that rejects is logged and does not prevent the remaining subscriptions from being sent.

- [ ] **Step 6: Write `push.ts`**

`createNotifier` holds the injected `send` and the db. `notify(events)` maps each event through `pushFor`, skips the `undefined`s, and for each remaining payload sends to every stored subscription, pruning on 404/410. The real `send` in `main.ts` is `webpush.sendNotification` with `webpush.setVapidDetails(subject, publicKey, privateKey)` called once at startup.

Add to `apps/core/src/config/server.ts`: `vapid: { publicKey: string; privateKey: string; subject: string } | undefined`. All three variables must be present together or all absent — one or two set is a misconfiguration and throws `ConfigurationError`, because a core that silently has no push is indistinguishable from one whose keys were typo'd. Add a config test for each of those three cases.

Run: `npx vitest run apps/core/src/notify` → PASS, 7 tests.

- [ ] **Step 7: Route the three push endpoints in `http.ts`**

- `GET /push/key` → `{ publicKey }` or `404 push_unavailable` when no keys are configured.
- `POST /push/subscribe` → body parsed by a strict Zod schema `{ endpoint: string().url(), keys: { p256dh: string(), auth: string() } }`, stored against the **session id** the `authorize` result carries. A bearer-authenticated caller has no session; answer `400 session_required`, because a subscription that outlives every session can never be cleaned up.
- `POST /push/unsubscribe` → `{ endpoint }`, deletes that row.

- [ ] **Step 8: Subscribe the notifier to the broker in `main.ts`**

```ts
const notifier = createNotifier({ …, send: sendWithWebPush, vapid: config.vapid });

// After commit, never inside it: the broker already publishes only committed
// events, so a push can never describe state a rollback erased.
kernel.broker.subscribe((events) => {
  void notifier.notify(events).catch((error: unknown) => {
    kernel.logger.log("warn", "push delivery failed", { error: String(error) });
  });
});
```

- [ ] **Step 9: Write the service worker**

Create `apps/web/public/sw.js` — plain JavaScript, no build step, served from the web root so its scope is the whole app:

```js
// Slice 2, decision 0.25. The core sends JSON; this turns it into a
// notification and makes tapping it land on the page that needs a person.
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? "Noctis", {
      body: payload.body ?? "",
      tag: payload.tag,
      // A replaced notification should still be seen: without this, a silent
      // re-tag updates the text and the phone never lights up.
      renotify: Boolean(payload.tag),
      data: { url: payload.url ?? "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = event.notification.data?.url ?? "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus the tab that is already open rather than opening a second one.
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }

      return self.clients.openWindow(target);
    }),
  );
});
```

- [ ] **Step 10: Write `subscribe.ts` and the Settings card**

`subscribe.ts` exports `enablePush(transport: CoreTransport): Promise<"enabled" | "denied" | "unsupported">`: it registers `/sw.js`, fetches `GET /push/key`, calls `Notification.requestPermission()`, subscribes with `userVisibleOnly: true` and the key converted from base64url to a `Uint8Array`, then POSTs the subscription. Every step that can fail returns one of the three strings rather than throwing.

Test it with a stubbed `navigator.serviceWorker` and `Notification` for: unsupported browser, denied permission, and the happy path posting the right body.

The Settings card is one button and one status line, matching the existing cards in `Settings.tsx`. It says plainly what is on: "Notifications are on for this device", "Notifications are blocked in browser settings", or "This browser does not support notifications".

- [ ] **Step 11: Document the keys in the runbook**

Append to `docs/operations/work-pc-core.md`:

```powershell
# One-time, on the work PC. The private key is a credential: it goes in a
# user-scoped environment variable, never in the repo, never in SQLite.
npx web-push generate-vapid-keys
[Environment]::SetEnvironmentVariable('NOCTIS_VAPID_PUBLIC_KEY',  '<public>',  'User')
[Environment]::SetEnvironmentVariable('NOCTIS_VAPID_PRIVATE_KEY', '<private>', 'User')
[Environment]::SetEnvironmentVariable('NOCTIS_VAPID_SUBJECT',     'mailto:mushaf.zarrar@travelvogue.co.uk', 'User')
```

Note in the same section that a new terminal does not inherit a just-set user variable on Windows — restart the editor, as the existing runbook already records.

- [ ] **Step 12: Full gate and commit**

```bash
npm run test:boundary
npm run format:check && npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build
git add apps/core apps/web docs
git commit -m "feat(core): the phone hears about an approval, a failure, and a block"
```

---

## Task 6: The phone gate — prove it on real hardware

Slice 1's lesson was that fixtures prove the shape and hardware proves the thing: six real defects surfaced only on a live run. This task is the live run for the front door, and it is the gate for this plan.

Nothing here is code. It is a procedure the owner runs, and an honest record of what it showed.

**Files:**

- Modify: `docs/operations/work-pc-core.md` — the phone procedure
- Modify: `docs/operations/runtime-live-evidence.md` — the evidence
- Modify: `docs/acceptance/IMPLEMENTATION-STATUS.md` — fixture proof and live proof, labelled separately

- [ ] **Step 1: Deploy to the work PC**

On the work PC over AnyDesk: `git pull`, `npm ci`, `npm run build`, set the three VAPID variables, restart the core, confirm `tailscale serve status` still points at 7717, and confirm `/ready` answers over the tailnet from the personal PC.

- [ ] **Step 2: Hand the owner the phone procedure**

Write it into `work-pc-core.md` as numbered steps he can follow without reading any code, then hand him the same list in chat. It must cover:

1. Open the Tailscale Serve HTTPS URL on the iPhone. Expect the login screen, not a blank page or a token prompt.
2. Paste the core token once. Expect the workbench, and a tab bar rather than a rail.
3. Send a prompt from Command. Expect the answer to stream token by token, not to appear all at once when it finishes.
4. Turn on notifications in Settings. Expect the permission prompt, then "Notifications are on for this device".
5. Lock the phone. From the desk, run a turn that asks for something consequential. Expect a notification on the lock screen naming what is being asked.
6. Tap it. Expect the Noctis tab to focus on the approvals view with that ask visible, not a fresh page at the root.
7. Confirm the ask from the phone. Expect the turn to continue and finish.
8. Force-quit Safari, reopen the URL. Expect **no** second login — the cookie outlives the tab.
9. Put the phone in aeroplane mode for thirty seconds, then off. Expect the stream to resume and no missed event: the page's cursor is in the SSE URL, so replay is the browser's own reconnect.

- [ ] **Step 3: Record what actually happened**

In `runtime-live-evidence.md`, one section per numbered step: what was run, what was observed, and screenshots. Record the iOS version and Safari build, the tailnet hostname used, and the core's commit. **Record failures as failures.** Slice 1's value came from writing down six defects rather than six successes.

- [ ] **Step 4: Fix what the phone found, then re-run**

Expect defects — the phone is the first genuinely hostile client this code has met. Each fix is its own `fix(area): …` commit with a test that fails without it. Re-run the affected steps and update the evidence.

Likely candidates, named here so they are recognised rather than debugged from scratch:

- Safari refuses a `Secure` cookie if the page was reached over plain HTTP — it must be the `https://…ts.net` URL, not an IP.
- iOS only permits web push from a page **added to the Home Screen**; in a plain Safari tab `Notification.requestPermission` may be unavailable. If so, the procedure gains "Add to Home Screen" before step 4, and `subscribe.ts` must report `"unsupported"` cleanly rather than throwing.
- A `manifest.webmanifest` with `display: "standalone"` is required for the Home Screen install to behave as an app. If step 4 needs it, add it — that is a real requirement the phone found, not scope creep.
- Tailscale Serve may buffer the SSE stream despite `x-accel-buffering`. If the stream only flushes on close, that is a proxy configuration finding for the runbook.

- [ ] **Step 5: Update the status document and commit**

In `docs/acceptance/IMPLEMENTATION-STATUS.md`, add the front-door section with fixture proof and live proof labelled separately, and state plainly what is _not_ proven yet (attachments, live Vault, recovery, the core-side approval surfaces — all of them the second half of Slice 2).

```bash
git add docs
git commit -m "docs: the front door, proven from the phone"
```

**Gate:** from the iPhone over Tailscale — log in once, send a prompt, watch it stream, receive a push while locked, tap it into the approval, confirm it, and see the turn finish. Recorded with screenshots, versions, and every defect found.

---

## Self-review against the spec

**Spec coverage.** Master-plan task 2.1 (session realm, ADR-0028) → Tasks 1, 2, 3. Task 2.2 (phone shell) → Task 4. Task 2.3 (web push, decision 0.25) → Task 5. The front-door half of task 2.8 (desk session) → Task 6. Master-plan tasks 2.4, 2.5, 2.6, 2.7 and the two Slice 1 gaps are **deliberately absent** and named in "Why this is Part 1 of two" with the reason; Slice 2's gate is not met until Part 2 ships.

**Interfaces that cross task boundaries**, each defined once and consumed later:

| Name                                                                                       | Defined                                  | Consumed                                                          |
| ------------------------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------- |
| `hashSecret`, `SessionDeps`, `VerifiedSession`, `SESSION_COOKIE`                           | Task 1, `session.ts`                     | Task 1 `auth.ts` and `http.ts`; Task 5 (`session_id` foreign key) |
| `authorize`, `AuthorizeResult`                                                             | Task 1, `auth.ts`                        | Task 1 `http.ts`; Task 5 (a subscription needs the session id)    |
| `FrameSource`, `deps.frames`                                                               | Task 2, `sse.ts` and `runtime-frames.ts` | Task 2 `http.ts` and `ws.ts`                                      |
| `login()` integration helper                                                               | Task 1, step 18                          | Task 2, step 7                                                    |
| `resolveCoreTransport(csrf?)`, `needsLogin()`, `coreBaseUrl()`, `CoreTransportUnavailable` | Task 3, `core-client.ts`                 | Task 3 `App.tsx`; Task 4                                          |
| `Workbench` component split                                                                | Task 3, step 11                          | Task 4, step 9                                                    |
| `TAB_ITEMS`, `tabsFor`, `TabBar`                                                           | Task 4                                   | Task 4 `App.tsx`; Task 6 procedure                                |
| `useIsMobile`                                                                              | Task 4                                   | Task 4 `App.tsx`                                                  |
| `PushPayload`, `pushFor`, `createNotifier`                                                 | Task 5                                   | Task 5 `http.ts` and `main.ts`                                    |

**Three names are stand-ins, and say so at the point of use**, because the right value is in code the executor must read rather than in this plan: `readEventsAfter` (Task 2, step 6 — the existing ledger pager), `objective.create` and its body (Tasks 1–2 integration tests — whatever command the suite already exercises), and the exact payload field names in `triggers.test.ts` (Task 5, step 3 — `packages/contracts/src/events.ts` is authoritative).

**Two risks worth stating before execution rather than discovering at the gate:**

1. **iOS web push requires the page to be added to the Home Screen.** If Safari in a plain tab has no `Notification` API, Task 5's `enablePush` must return `"unsupported"` cleanly and Task 6's procedure gains an install step plus a `manifest.webmanifest`. This is anticipated in Task 6, step 4 — it is a finding to expect, not a plan defect.
2. **Tailscale Serve may buffer SSE** despite `x-accel-buffering: no`. If the stream flushes only on close, the fallback is not to abandon SSE but to record the proxy finding and, if it proves unfixable, keep `BrowserTransport`'s poll as the phone's event path while `runtime_delta` frames stay desktop-only. Task 6, step 4 names this.

**Cost check.** One new runtime dependency (`web-push`, Task 5), justified in place: VAPID JWT signing plus ECDH plus AES128GCM is not a few lines of `node:crypto`. Everything else is stdlib (`node:crypto`, `node:sqlite`) or already in the repo. No new frontend dependency: the donor's Tailwind, `react-router`, `lucide-react`, and `i18next` are all declined in Task 4's ledger row, and the "More" sheet uses a native `<dialog>` rather than a modal library.

---

## Execution

Part 1 is six tasks. Tasks 1–3 are the security spine and are strictly sequential; 4 and 5 can run in parallel; 6 is the owner's live gate on the iPhone and cannot be run by an agent.

Part 2 is written after Task 6's evidence exists, for the same reason the master plan holds later slices at task level: the phone is the first hostile client this code meets, and what it finds should shape what is planned next.
