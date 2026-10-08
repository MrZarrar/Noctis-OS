# Implementation status

## Phase 0 — bootstrap and project truth

Status: accepted (2026-08-23)

| Check                              | State                    | Evidence                                                         |
| ---------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| Independent sibling Git repository | implemented              | repository root; merged to `main` at `bf6660c`                   |
| Donor boundary guard               | red-green implemented    | `npm run test:boundary`                                          |
| Exact JavaScript dependency lock   | implemented              | `package-lock.json`; install audit reports zero vulnerabilities  |
| Source and mockup manifest         | implemented              | `MOCKUP-MANIFEST.md`                                             |
| Donor baseline                     | implemented              | `DONOR-BASELINE.json`; reconfirmed unchanged post-merge          |
| Rust 1.98.0 toolchain              | implemented              | `rustc`, `cargo`, `rustfmt`, and Clippy verified locally         |
| Minimal Tauri 2 desktop scaffold   | implemented              | GitHub Actions `verify` run 32664703461: rust + javascript green |
| Production deployment/activation   | deliberately not started | requires later explicit approval                                 |

## Phase 1 — foundation

Status: accepted (2026-09-01)

| Check                                                                 | State                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations idempotent on an empty database and a toy populated schema | implemented              | `apps/core/src/db/migrate.test.ts` — "applies a migration to an empty database"; "is idempotent when re-run against a populated database" re-runs the ledger against a toy single-table schema, proving the ledger itself is idempotent, not a re-run of the real 25-table foundation migration                                                                                                    |
| Malformed model/worker/API data rejected                              | implemented              | `packages/contracts/src/contracts.malformed.test.ts` — 196 hostile-input cases (28 schemas × 7 hostile inputs) plus a `.strict()` unknown-field matrix over all 28 schemas, including a nested-object case for `CompositionPlan`'s slots; `packages/contracts/src/events.test.ts` — "rejects an unregistered name", "rejects an unknown version of a registered name"                              |
| All transition matrices pass                                          | implemented              | the five domain matrix files, each enumerating its full state cross-product with `it.each`: `mission-status.test.ts`, `node-job-status.test.ts`, `noir-case-status.test.ts`, `objective-status.test.ts`, `surface-lifecycle.test.ts` (all under `packages/domain/src/state/`)                                                                                                                      |
| Rollback leaves no partial rows or events                             | implemented              | `apps/core/src/db/transactions.test.ts` — three tests marked THE GATE: "THE GATE: a refusal writes neither state nor event", "THE GATE: a refusal after mutate self-committed throws instead of hiding the write", "THE GATE: a thrown failure between the writes leaves both tables empty"                                                                                                        |
| SQLite driver seam, no flag required on pinned Node                   | implemented              | `apps/core/src/db/connection.ts` wraps `node:sqlite`; Node 22.23.2 runs it unflagged, confirmed empirically in CI run `33453626520`; no `NODE_OPTIONS` is set anywhere                                                                                                                                                                                                                             |
| CI verifies migrations on the pinned runtime                          | implemented              | `apps/core/src/db` is covered by `npm run test:unit`, which the `javascript` job in `.github/workflows/verify.yml` runs on the pinned Node runtime; the separate `npm run test:migrations` CI step was removed as a strict subset of `test:unit` (the script itself is kept for local use) — GitHub Actions `verify` run `33505602165` predates that removal and evidences the prior two-step form |
| Donor repository unchanged                                            | implemented              | HEAD, branch, and untracked-file status reconfirmed against `DONOR-BASELINE.json`                                                                                                                                                                                                                                                                                                                  |
| Production deployment/activation                                      | deliberately not started | requires later explicit approval                                                                                                                                                                                                                                                                                                                                                                   |

Notes on the gate table above: the foundation migration file declares 25 tables; `migrate()` creates the
`schema_migrations` ledger table itself as part of applying it, so a freshly migrated database has 26
tables in total (`apps/core/src/db/migrate.test.ts` — "applies the real foundation migration and creates
all 26 tables"). The rollback gate (row 4) was validated by sabotage, not merely by reading the code:
replacing each `ROLLBACK` in `apps/core/src/db/transactions.ts` with `COMMIT` was tried locally during
development and made the corresponding THE GATE test fail on the `objectives` row count — i.e. the tests
exercise the actual rollback mechanism, not an incidental assertion that happens to pass.

The five domain state machines enumerated above are the complete set named in ADR-0006 and covered by
`packages/domain/src/state/*.test.ts`. That directory also contains `transition.test.ts`, which is not
one of the five: it tests the generic `defineTransition` helper against a two-state toy machine (`red`
-> `green`) and is not a domain transition matrix, so it is deliberately excluded from this gate's
evidence list.

## Verification log

Fresh final command evidence is appended at the end of each implementation batch. Historical success
is not treated as current evidence.

### 2026-08-23 bootstrap and first contract slice

| Command                    | Result                                                              |
| -------------------------- | ------------------------------------------------------------------- |
| `npm ci --offline`         | exit 0; 139 packages installed; 147 audited; 0 vulnerabilities      |
| `npm run format:check`     | exit 0; all matched files formatted                                 |
| `npm run lint`             | exit 0; 0 errors                                                    |
| `npm run typecheck`        | exit 0                                                              |
| `npm run test:unit`        | exit 0; 3 files and 30 tests passed                                 |
| `npm run test:boundary`    | exit 0; 6 tests passed, including dirty donor snapshot preservation |
| `npm run test:integration` | exit 0; no integration tests exist yet                              |
| `npm run test:e2e`         | exit 0; no E2E tests exist yet                                      |
| `npm run test:security`    | exit 0; no dedicated security tests exist yet                       |
| `npm run test:performance` | exit 0; no performance tests exist yet                              |
| `npm run build`            | exit 0                                                              |
| `rustc --version`          | exit 0; Rust 1.98.0                                                 |
| `cargo --version`          | exit 0; Cargo 1.98.0                                                |
| `rustfmt --version`        | exit 0; rustfmt component available                                 |
| `cargo clippy --version`   | exit 0; Clippy component available                                  |

Implemented behavior: Objective status/record schemas, fail-closed unknown fields, deterministic
Objective status transitions, Noctis/Jarvis environment namespace isolation, and read-only donor
boundary/snapshot utilities.

The pinned Rust 1.98.0 toolchain is now verified locally. Empty integration, E2E, security, and
performance scripts are scaffolding, not evidence of scenario coverage.

### 2026-08-23 Tauri 2 bootstrap

| Command                             | Result                                                                |
| ----------------------------------- | --------------------------------------------------------------------- |
| `cargo metadata --locked --no-deps` | exit 0; pinned desktop crate and targets resolve                      |
| `npm run tauri -- info`             | Rust, Cargo, MSVC, WebView2, Node, and npm detected                   |
| `npm run test:desktop-bootstrap`    | local compile blocked by enforced Smart App Control, events 3077/3033 |

The compile test first failed because the desktop manifest was absent, proving the red condition. It
then reached dependency compilation after the scaffold and locks were added, where Windows blocked
Cargo's unsigned generated `serde_json` build-script executable with OS error 4551. No App Control
setting was changed. The Windows GitHub Actions Rust job now owns compile, Clippy, test, and unbundled
Tauri-build verification; that evidence remains pending until this commit is pushed.

### 2026-08-23 icon fix, CI evidence, and Phase 0 acceptance

| Command                                               | Result                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `git push` (commit `bf6660c`, `icons/icon.ico` added) | added the Windows exe icon resource `tauri-build` requires unconditionally                                                 |
| GitHub Actions `verify` run `32664703461`             | exit 0; `rust` job green (fmt, clippy, cargo test, unbundled Tauri build); `javascript` job green                          |
| `npm run test:boundary`                               | exit 0; 6 tests passed                                                                                                     |
| `npm run format:check`                                | exit 0                                                                                                                     |
| `npm run lint`                                        | exit 0                                                                                                                     |
| `npm run typecheck`                                   | exit 0                                                                                                                     |
| `npm run test:unit`                                   | exit 0; 3 files and 30 tests passed                                                                                        |
| `npm run build`                                       | exit 0                                                                                                                     |
| Donor repository reconfirmation                       | HEAD `ee7b4527`, branch `dev/personal-pc`, and the single untracked v5 spec file all match `DONOR-BASELINE.json` unchanged |
| `git merge feat/bootstrap-foundation` into `main`     | fast-forward `2ce90b8..bf6660c`; merged-tree checks re-run and green; pushed to `origin/main`                              |

`test:desktop-bootstrap` and `rust:test` were not re-run locally on this machine because no local Rust
toolchain is installed here; the GitHub Actions `rust` job is the authoritative check for those and it
passed.

Phase 0 is accepted. All checks above are implemented and evidenced; production deployment/activation
remains deliberately not started pending later explicit approval.

### 2026-09-01 Phase 1 gate verification and acceptance

| Command                                      | Result                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`                       | exit 0; all matched files use Prettier code style                                                                          |
| `npm run lint`                               | exit 0; 0 errors                                                                                                           |
| `npm run typecheck`                          | exit 0                                                                                                                     |
| `npm run test:boundary`                      | exit 0; 6 tests passed                                                                                                     |
| `npm run test:unit`                          | exit 0; 23 files, 380 tests passed                                                                                         |
| `npm run test:migrations`                    | exit 0; 5 files, 24 tests passed (a subset of the 380 above)                                                               |
| `npm run build`                              | exit 0                                                                                                                     |
| Donor repository reconfirmation              | HEAD `ee7b4527`, branch `dev/personal-pc`, and the single untracked v5 spec file all match `DONOR-BASELINE.json` unchanged |
| `git push` (commit `fb2081a`, CI step added) | pushed 22 commits accumulated since the last push, including all of Tasks 1–14                                             |
| GitHub Actions `verify` run `33505602165`    | `javascript` job green (1m14s, job `99848778274`); `rust` job green (17m58s, job `99848778081`)                            |

`test:desktop-bootstrap` and the Rust checks (`rust:fmt:check`, `rust:clippy`, `rust:test`,
`build:desktop`) were not run locally on this machine — no local Rust toolchain is installed here, as
was already true for every prior batch in this project. The GitHub Actions `rust` job is the
authoritative check for those, and it passed on run `33505602165`. The only CI annotation on that run
is GitHub's own deprecation notice about `actions/checkout@v4`/`actions/setup-node@v4` predating Node
20 removal; it is infrastructure noise, not a Phase 1 defect, and was left unaddressed.

The Node 22 `--experimental-sqlite` question is closed: Node 22.23.2 has `node:sqlite` unflagged, first
confirmed empirically in CI run `33453626520` (Task 1) and re-confirmed by this run, which passed
`test:migrations` — a suite that exercises `node:sqlite` directly — without `NODE_OPTIONS` set anywhere
in `.github/workflows/verify.yml` or the local shell.

Gate-to-test mapping was checked against actual test names rather than transcribed from the plan; two
corrections were needed. First, the malformed-event gate cited `events.test.ts` — "unknown name and
version" in the plan, which does not match any test name; the actual tests are "rejects an unregistered
name" and "rejects an unknown version of a registered name". Second, the rollback gate was written as
"the two tests marked THE GATE" in the plan; `apps/core/src/db/transactions.test.ts` now has three,
the third added while closing a boundary gap where a mutation could self-commit and then refuse — all
three are named above.

Phase 1 is accepted. All checklist items in the design spec's Phase 1 verification checklist are met:
local suite green, CI green on both jobs on pinned Node 22.23.2, the `node:sqlite` flag question is
answered with evidence rather than left open, and the donor repository is confirmed byte-for-byte
unchanged. Production deployment/activation remains deliberately not started pending later explicit
approval.

### 2026-09-01 final fix wave before merge

Nine review findings fixed prior to proposing Phase 1 for merge: the global `UNIQUE (idempotency_key)`
constraints on `approvals` and `node_jobs` were removed in favour of `idempotency_keys` (scoped by
`PRIMARY KEY (scope, key)`) as the sole enforcement point; `objective-status.test.ts` was rewritten to
the same full state cross-product shape as the other four machines; `apps/core/src/db/events.test.ts`
was added, asserting the payload round-trip and the `isTransaction` guard; the malformed-input and
`.strict()` matrices in `contracts.malformed.test.ts` were extended from 9 to all 28 object/union
schemas in `packages/contracts/src`, including a nested-slot case for `CompositionPlan`; WebSocket frame
and payload-required coverage was added; the `isTransaction` driver-specific name was centralised behind
a new `inTransaction()` helper in `connection.ts` at its six call sites; the `no-restricted-imports`
guard on `node:sqlite` was extended to `packages/**`; the redundant `test:migrations` CI step was
removed (the npm script itself is kept); and ADR-0006 plus this document were corrected to match.

| Command                | Result                                            |
| ---------------------- | ------------------------------------------------- |
| `npm run format`       | exit 0                                            |
| `npm run format:check` | exit 0; all matched files use Prettier code style |
| `npm run lint`         | exit 0; 0 errors                                  |
| `npm run typecheck`    | exit 0                                            |
| `npm run test:unit`    | exit 0; 24 files, 573 tests passed                |
| `npm run build`        | exit 0                                            |

A scratch script (not retained) opened an in-memory database, applied `0001_foundation.sql` alone, and
counted 25 tables excluding SQLite's own `sqlite_sequence`; running `migrate()` against the same
migrations directory brings the total to 26 with `schema_migrations` added, matching
`apps/core/src/db/migrate.test.ts` — "applies the real foundation migration and creates all 26 tables".
Table and test counts throughout the gate table above and the malformed-input row were updated to match
this run.

### 2026-09-01 Phase 2 kernel implementation

Implemented: fail-closed core configuration (`config/server.ts`), redacting structured logger
(`logging.ts`), the `runCommand` transaction/idempotency/publish seam (`kernel.ts`), the in-process
event broker (`events/broker.ts`), event replay reads (`db/events.ts`), Objective and Mission command
services, the pure baseline authority policy (`packages/domain/src/authority/evaluate.ts`) and its
append-only recorder (`authority/service.ts`), the provider registry that refuses metered classes, the
REST command realm and `/ws/clients` with sequence resume (`api/`), and the process entry point
(`main.ts`).

| Command                    | Result                                                         |
| -------------------------- | -------------------------------------------------------------- |
| `npm run format:check`     | exit 0; all matched files use Prettier code style              |
| `npm run lint`             | exit 0; 0 errors                                               |
| `npm run typecheck`        | exit 0                                                         |
| `npm run test:unit`        | exit 0; 31 files, 704 tests passed (573 at Phase 1 acceptance) |
| `npm run test:integration` | exit 0; 42 tests passed in `api/headless.integration.test.ts`  |
| `npm run test:migrations`  | exit 0; 26 tests passed (a subset of the 704 above)            |
| `npm run test:boundary`    | exit 0; 6 tests passed; donor unchanged                        |
| `npm run build`            | exit 0                                                         |

The built artefact was smoke-run, not only tested: `node apps/core/dist/main.js` bound 127.0.0.1:7719,
answered `/health` unauthenticated, refused `/ready` with 401, accepted `objective.create`, and returned
the resulting `objective.created.v1` event at sequence 1 from `/events`. This exercises the
`MIGRATIONS_DIRECTORY` resolution from `dist/`, which no unit test covers.

Gate evidence, each verified by sabotage rather than by a passing run alone. Every sabotage below was
applied locally, observed to fail the named tests, and reverted:

| Gate clause                                    | Sabotage applied                                         | Tests that failed |
| ---------------------------------------------- | -------------------------------------------------------- | ----------------- |
| Complete headless loop and sequence resume     | `startStream` ignores `afterSequence` and replays from 0 | 2                 |
| Hostile token fixtures fail                    | REST bearer check short-circuited to pass                | 5                 |
| Hostile token fixtures fail (socket realm)     | `/ws/clients` upgrade skips the bearer check             | 1                 |
| Hostile origin fixtures fail                   | REST origin check short-circuited to pass                | 1                 |
| Hostile frame fixtures fail                    | `ClientFrameSchema` result ignored                       | 4                 |
| Idempotent retry returns the original result   | replay branch in `defineCommand` disabled                | 1                 |
| Writes cannot bypass the idempotency claim     | one `tx.prepare` write moved to `kernel.db.prepare`      | 1                 |
| Events publish only after a durable commit     | `COMMIT` replaced with `ROLLBACK` in `transactions.ts`   | 3                 |
| Standing permission cannot cover spend et al.  | `"spend"` removed from `PERMISSION_INELIGIBLE`           | 1                 |
| Consequence classes require typed confirmation | `destructive` softened to `require_confirmation`         | 2                 |

`metered fallback is impossible` is enforced at registration, not at routing:
`apps/core/src/providers/registry.ts` throws on `providerClass: "metered_api"`, and
`registry.test.ts` pins `ProviderClassSchema.options` so a future class cannot become registrable by
omission. The registry is empty in Phase 2 — no provider adapter is registered yet.

No donor code was ported in this batch, so `DONOR-PORT-LEDGER.md` is unchanged. `sources/` and
`artifacts/` were deliberately not created (ADR-0010), as was request rate limiting.

The socket tests were run three consecutive times with no flakiness. `estimated_cost_gbp` remains a
SQLite `REAL`, now carrying a `ponytail:` comment in `authority/service.ts` naming the conversion point.

### 2026-09-02 Phase 3 distributed nodes and deterministic local execution

Implemented: derived node credentials with a two-generation rotation window
(`nodes/credentials.ts`), one-time pairing codes and the node registry
(`nodes/registry.ts`), the pure host router with explicit reason codes (`nodes/router.ts`), job
enqueue/lease/result/expire/cancel (`nodes/jobs.ts`), the connection map, lease sweep, and signed job
dispatch (`nodes/dispatch.ts`), the `/ws/nodes` realm (`nodes/ws.ts`), migration `0002_nodes.sql`, and
the outbound node agent with its three deterministic adapters (`apps/node-agent/src/`).

| Command                         | Result                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm run format:check`          | exit 0; all matched files use Prettier code style                                                     |
| `npm run lint`                  | exit 0; 0 errors                                                                                      |
| `npm run typecheck`             | exit 0                                                                                                |
| `npm run test:unit`             | exit 0; 40 files, 901 tests passed (704 at Phase 2 acceptance)                                        |
| `npm run test:integration`      | exit 0; 94 tests across three integration suites                                                      |
| `npm run test:migrations`       | exit 0; a subset of the 901 above                                                                     |
| `npm run test:boundary`         | exit 0; 6 tests passed                                                                                |
| `npm run build`                 | exit 0                                                                                                |
| Donor repository reconfirmation | HEAD `ee7b4527`, branch `dev/personal-pc`, single untracked v5 spec — all match `DONOR-BASELINE.json` |

No new dependency. `ws` 8.21.3, added in Phase 2, is the node agent's only runtime dependency besides
the workspace contracts package.

Gate evidence, each clause verified by sabotage rather than by a passing run alone. Every sabotage was
applied locally, observed to fail the named tests, and reverted:

| Gate clause                                  | Sabotage applied                                               | Tests that failed |
| -------------------------------------------- | -------------------------------------------------------------- | ----------------- |
| Revoked node is refused                      | revoked check removed from the `/ws/nodes` upgrade             | 1                 |
| Revoked node loses what it was allowed to do | grant revocation removed from `revokeNode`                     | 1                 |
| Node/client realms are not interchangeable   | node credential verification short-circuited to pass           | 2                 |
| Credential rotation is real                  | `connectNode` stopped incrementing the generation              | 2                 |
| Rotation window is exactly two generations   | window widened to three                                        | 1                 |
| Rotation window does not lock an agent out   | previous-generation acceptance removed                         | 1                 |
| A browser cannot become a worker             | Origin refusal removed from the `/ws/nodes` upgrade            | 1                 |
| Malicious payloads fail closed               | `NodeFrameSchema` result ignored                               | 4                 |
| Bounded progress                             | per-job progress budget removed                                | 1                 |
| Wrong host                                   | named-host filter removed from the router                      | 4                 |
| Wrong host (offline node starvation)         | router scored every candidate as connected                     | 1 and 2           |
| Expired lease refuses a late result          | lease-expiry check removed from `completeJob`                  | 1                 |
| Expired lease requeues, then gives up        | attempt ceiling removed from the sweep                         | 1                 |
| Duplicate job                                | node-ownership check removed from `completeJob`                | 1                 |
| Evidence is verified against its capability  | evidence parse replaced with a passthrough                     | 1                 |
| Enqueue validates the payload                | capability payload parse replaced with a passthrough           | 1                 |
| A grant cannot understate its consequence    | derived operation class replaced with a caller-supplied one    | 1                 |
| Pairing code is single-use                   | `consumed_at` check removed                                    | 1                 |
| Pairing code expires                         | expiry check removed                                           | 1                 |
| Job assignments are signed                   | `signAssignment` replaced with a constant (core and agent)     | 1 and 5           |
| The agent verifies the signature             | agent-side signature verification skipped                      | 2                 |
| Writes cannot bypass the idempotency claim   | one `tx.prepare` write in `nodes/jobs.ts` moved to `kernel.db` | 1                 |
| Symlink escape                               | reparse-point skip removed from `file.search`                  | 0 — see below     |

Three sabotages initially survived, and each one was a finding rather than a formality:

1. **A circular signature assertion.** The first version of the end-to-end test verified the job
   signature with the core's own `verifyAssignment`, so replacing `signAssignment` with a constant
   satisfied it — the function merely agreed with itself. The assertion now recomputes the HMAC with
   `node:crypto` and pins the domain separator, and the sabotage fails it. The agent-side check is
   independent by construction: the agent computes its own HMAC, and the same sabotage fails five of its
   tests once the core is rebuilt.
2. **A missing test, not a missing guard.** Nothing exercised a _known_ node presenting a _wrong_
   credential — the unknown-node case is refused before any credential is derived, so the credential
   comparison itself had no test. Two were added ("refuses a paired node presenting a credential it
   never held", "refuses a credential that is two generations stale"), and both catch the sabotage.
3. **An unreachable guard.** Removing the `isSymbolicLink()` skip in `file.search` changes no test,
   because `readdir(..., { withFileTypes: true })` uses lstat and a reparse point already reports as
   neither file nor directory, so the walk never queues it. The line is kept and its comment now says
   so plainly rather than implying it is what holds. The guard that does hold for a symlinked _file_ is
   the `realpath` containment check, and it has direct unit tests — Windows refuses to create a file
   symlink without Developer Mode, so it cannot be exercised end to end on this machine. The
   filesystem-level escape test uses a junction and asserts that nothing outside the root is reported.

Two things found by probing rather than by a failing test:

- `readdir(root, { recursive: true })` **traverses a junction on Windows** even though the `Dirent`
  reports `isDirectory() === false` and `isSymbolicLink() === true`. A junction pointing at its own
  ancestor makes the walk repeat indefinitely. `file.search` therefore does an explicit bounded walk
  (20,000 entries, 12 levels) instead of using recursive `readdir`.
- A node socket closing during core shutdown wrote its offline transition against an already-closed
  database. `dispatcher.stop()` now records those transitions itself, while the database is open, and
  the socket close handlers skip when `isStopping()` is true.

Method note for future batches: `@noctis/core`, `@noctis/contracts`, and `@noctis/domain` resolve to
`dist/`, so a cross-package test does not see a source-only edit. Sabotaging core source and running an
`apps/node-agent` test proves nothing without `npm run build` in between — the first attempt at the
signature sabotage reported a false pass for exactly this reason.

Deliberately not built, with reasons recorded in ADR-0014: request rate limiting (still deferred to
Phase 4 with the Tailscale Serve path), and `better-sqlite3` qualification (the repository uses
`node:sqlite` behind the Phase 1 driver seam, and the node agent has no database at all). No grant-level
revocation command exists; revoking the node revokes its grants, and a grant may carry an `expiresAt`.

The port-scan clause of the gate is asserted as a property of the shipped source rather than of one
machine: `apps/node-agent/src/no-listener.test.ts` scans every non-test file in the agent for server,
listener, datagram, and child-process constructs, requires that `ws` is imported only as a client, and
fails if the scan finds fewer than three files to read. No donor code was ported in this batch, so
`DONOR-PORT-LEDGER.md` is unchanged.

The built artefacts were smoke-run as real processes, not only tested. `node apps/core/dist/main.js`
bound 127.0.0.1:7719; `node apps/node-agent/dist/main.js pair --core ... --code ... --host smoke-host`
redeemed a code and wrote a credential file; the agent connected; a `file.search` job over a granted
root returned `{"matches":[{"relativePath":"quarterly-findings.md","sizeBytes":9}],"truncated":false}`
against a real directory. The observed event sequence was `node.paired.v1`,
`node.capability_granted.v1`, `node.connected.v1`, `node.job_queued.v1`, `node.job_leased.v1`,
`node.job_result.v1`. The credential file's generation moved 0 -> 1 on connect, and the `nodes` table's
columns are `id, host_id, status, fingerprint, agent_version, last_seen_at, revoked_at, created_at,
updated_at, credential_generation` — no secret column, which is the point of ADR-0011. Three hostile
requests against the running processes answered 401 (the client bearer token upgrading `/ws/nodes`), 401
(`/ready` with no bearer), and 404 (a reused pairing code presented by a different fingerprint).

### 2026-09-06 Phase 4 Tauri 2 shell and secure transport

Implemented: the typed core transport and its two implementations
(`apps/web/src/transport/{CoreTransport,BrowserTransport,TauriTransport}.ts`), the Rust request proxy
and its path guard (`proxy.rs`), the shell-held `/ws/clients` client with resume and backoff
(`stream.rs`), core configuration with a redacting `Debug` (`config.rs`), monitor-driven window
placement restore (`placement.rs`), the fail-closed `noctis://` reader (`deeplink.rs`), and the shell
itself — single instance, tray, global shortcut, deep links, notifications, and crash-safe placement
persistence (`lib.rs`). The Phase 4 canary page (`apps/web/{public,src/shell.ts}`) is served from
`apps/web/dist`, built by `tsc` with no bundler, and is the first thing the desktop actually loads.

| Command                         | Result                                                           |
| ------------------------------- | ---------------------------------------------------------------- |
| `npm run format:check`          | exit 0; all matched files use Prettier code style                |
| `npm run lint`                  | exit 0; 0 errors                                                 |
| `npm run typecheck`             | exit 0                                                           |
| `npm run test:unit`             | exit 0; 40 files, 927 tests passed (901 at Phase 3 acceptance)   |
| `npm run test:integration`      | exit 0; 94 tests, unchanged                                      |
| `npm run test:boundary`         | exit 0; 6 tests passed                                           |
| `npm run test:desktop`          | exit 0; 6 tests (the pinned crate compiles, plus the shell gate) |
| `npm run rust:fmt:check`        | exit 0                                                           |
| `npm run rust:clippy`           | exit 0; 0 warnings with `-D warnings`                            |
| `npm run rust:test`             | exit 0; 37 tests passed                                          |
| `npm run build`                 | exit 0                                                           |
| `npm run build:desktop`         | exit 0; unbundled release binary produced                        |
| Donor repository reconfirmation | HEAD, branch, and untracked file all match `DONOR-BASELINE.json` |

Nine new Rust dependencies, all pinned exactly: the four Tauri plugins this phase names
(`single-instance`, `deep-link`, `global-shortcut`, `notification`), `reqwest` and
`tokio-tungstenite` as the two core clients, and `tokio`, `futures-util`, and `url` beneath them.
Both clients are built with `default-features = false` and therefore have no TLS backend at all,
which is deliberate: the core is a loopback HTTP listener, so a base URL that is not plain HTTP fails
to connect rather than quietly carrying the bearer token somewhere over the internet. No new
JavaScript dependency: the page is plain ES modules and does not import `@tauri-apps/api`.

The first CI run of this branch failed, and the local Rust results above were a false pass until it
did. `tauri::generate_context!` reads the frontend assets at compile time and `apps/web/dist` is
built rather than committed, so every cargo command on the desktop crate fails on a clean checkout
with "The `frontendDist` configuration is set to `"../../web/dist"` but this path doesn't exist".
It passed here only because the directory was already present from an earlier build. The `rust` job
now runs `npm run build:web` before the cargo steps, and the failure was reproduced locally by
moving `apps/web/dist` aside — red, then green once it was rebuilt.

Gate evidence. Every sabotage below was applied locally, observed to fail the named test, and
reverted.

| Gate clause                                  | Sabotage applied                                  | Caught by |
| -------------------------------------------- | ------------------------------------------------- | --------- |
| The WebView cannot reach another host        | both host guards removed from `core_url` together | 1         |
| A proxied request is signed                  | the `authorization` header replaced               | 1         |
| The proxy serves only what the core serves   | the method allowlist removed                      | 1         |
| The token is not a printable field           | the redacting `Debug` replaced with the token     | 1         |
| A short token is not a credential            | the length check disabled                         | 1         |
| The core URL is an origin                    | the path check removed                            | 1         |
| The socket realm is authenticated            | the client socket dialled with a wrong bearer     | 1         |
| A reconnect resumes                          | resubscribed from zero instead of the cursor      | 1         |
| A replay cannot rewind the cursor            | the monotonic filter removed                      | 1         |
| A gap rewinds the cursor to the ledger       | the gap branch ignored                            | 1         |
| A refused handshake is reported              | the connect error swallowed                       | 1         |
| A secure core implies a secure socket        | `wss` left as `https`                             | 1         |
| Restore honours the monitors that exist      | the saved position returned unclamped             | 4         |
| Restore picks the right monitor              | the first monitor always chosen                   | 1         |
| Negative coordinates are valid               | the position clamped to non-negative              | 1         |
| Nothing restores below the minimum size      | the minimum removed                               | 1         |
| Deep links are `noctis://` only              | the scheme check removed                          | 1         |
| Deep link routes are an allowlist            | the route check removed                           | 1         |
| A deep link target is an identifier          | the identifier rule removed                       | 1         |
| The transport refuses a host-naming path     | the authority-relative check removed (TypeScript) | 1         |
| A failed poll does not advance the cursor    | the cursor advanced on a refusal                  | 1         |
| A closed subscription stops polling          | the stop flag ignored                             | 1         |
| The listener exists before the stream starts | subscribed before listening                       | 1         |
| A replayed frame is not redelivered          | the delivered-sequence check removed              | 1         |
| An unreadable frame is reported              | the malformed-frame branch silenced               | 1         |
| The WebView cannot invoke ungranted plugins  | `fs:default` added to the capability file         | 1         |

Three sabotages passed on the first attempt and should not have. Each was a test that held for the
wrong reason, and each is recorded here rather than quietly repaired:

- Removing the scheme check from `deeplink::parse` failed nothing, because every case in
  `refuses_another_scheme` was also refused by the route allowlist. The test now includes
  `https://objective/<identifier>` — valid in every respect but its scheme.
- Removing the route allowlist failed nothing, because `noctis://shell/cmd.exe` was refused by the
  target rule instead. The test now includes `noctis://shell` and `noctis://shell/<identifier>`,
  which differ from an accepted link only in the route.
- Removing the identifier rule did not apply cleanly and was re-run; it is caught.

Two things survive sabotage by design, and neither is claimed as tested:

- `core_url`'s authority-relative check and its origin comparison are mutually redundant. Removing
  either alone fails nothing, because whichever remains catches every input; removing both fails
  `refuses_a_path_that_names_another_host`, which is the row in the table above. Both stay — the
  comparison is the general truth, the prefix check is the one that reads as the rule — and the
  comment in the source says exactly this rather than implying two independent guards.
- `placement::save` writes through a temporary file and renames. Replacing that with a direct write
  fails nothing, because the round-trip test cannot observe a crash mid-write. The rename stays for
  the reason the comment gives; it is untested.

Sabotage also deleted code rather than only defending it. `placement::restore` had a separate branch
centring a window whose monitor was gone. No test could tell that branch from ordinary clamping —
because clamping a position that is nowhere near a monitor already slides the window fully onto it —
so the branch was removed, not given a test to justify it.

Two bugs found by probing rather than by a failing test. The window placement was saved from
`outer_size` and restored with `set_size`, which sets the _inner_ size, so the window grew by the
width of its own frame on every restart; it now saves `inner_size`. And a deep link arriving on a
second launch was delivered to the page twice, because `tauri-plugin-single-instance`'s `deep-link`
feature already forwards the URL to the deep-link plugin while the single-instance callback was
parsing `argv` as well; the callback now only focuses the window, and `deeplink::from_args` was
deleted as the dead half of that pair. A third gap was found the same way: `on_open_url` does not
fire for the instance that was launched _with_ a link on Windows, so a cold start dropped it
silently; `get_current()` now covers that path.

The shell was smoke-run as a real process against a real core, not only tested. `node
apps/core/dist/main.js` bound 127.0.0.1:7717; the built shell launched with only `NOCTIS_CORE_TOKEN`
in its environment and logged `proxied GET /ready -> 200`, and the core logged `client stream
started` with `connectedClients: 1` — so the page reached the core through the Rust proxy and Rust
opened the authenticated client socket on its behalf. An objective created over the REST API moved
`latestSequence` to 1 with the socket still open. Neither the page sources nor the built
`apps/web/dist` contains the token or names its variable.

Duplicate launch: with one instance running, a second launch carrying
`noctis://objective/<identifier>` exited with code 0 after 75 ms, left exactly one process, and the
running instance logged one forwarded deep link. A cold start carrying `noctis://mission/<identifier>`
forwarded it once. `noctis://shell/cmd.exe` was refused and logged as refused.

Restart: `%APPDATA%\uk.co.noctis.os\window.json` was set to 1000×700 at (300,200) and the shell
launched twice in succession. The file read back identically both times, where a shell that ignored it
would have overwritten it with the 1280×800 default — and identically the second time, which is what
proves the inner/outer size fix, since the earlier code grew the window on every restart.

Deliberately not built, with reasons recorded in ADR-0017: autostart, the update channel and
signature verification, a display-inventory command for the page (Phase 9 is what would consume it),
and OS-protected token storage (ADR-0016 — the token comes from the environment, is never in the
WebView or the page bundle, and is not in Windows Credential Manager). `noctis://` registration writes
to `HKCU\Software\Classes` and is off unless `NOCTIS_REGISTER_SCHEME=true`. No donor code was ported
in this batch, so `DONOR-PORT-LEDGER.md` is unchanged.

The donor Electron/browser system is unaffected by construction rather than by inspection: this shell
uses the identifier `uk.co.noctis.os`, port 7717, `%APPDATA%\uk.co.noctis.os` for its configuration,
and the `noctis` scheme, and `apps/desktop/tests/shell-boundary.test.mjs` fails if the word "jarvis"
appears in either the Tauri configuration or the crate manifest.

### 2026-09-06 Phase 5 design system, Presence, and identity runtime (partial)

Implemented: the Section 5.2 design tokens (`packages/ui/src/tokens/*`), the permanent eight-item
rail (`packages/ui/src/primitives/Rail.tsx`), the identity-activation command and its persisted,
per-identity thread (`apps/core/src/identities/service.ts`, wired into `api/http.ts` as
`identity.activate` and `GET /identities`), and the Presence page (`apps/web/src/pages/Presence.tsx`)
that switches between them. `apps/web` gained its first bundler: React 18.3.1 and Vite 8.2.2 replace
the Phase 4 plain-ES-modules build, which is what makes a permanent nav, JSX, and a design-tokens
package importable at all. The Phase 4 canary page (`shell.ts`, `public/index.html`) is retired —
Presence is now the page the shell serves — and `CoreTransport.readServerFrame` was upgraded from a
structural check to a real `ServerFrameSchema.safeParse`, exactly as its Phase 4 `ponytail:` comment
said to once a bundler existed.

Fidelity decision, made before writing any renderer code: the Section 6 "one optimized intelligence
renderer" is a real generative-art build (Three.js, canonical Vesper/Jester/NOIR profiles, idle-RAF
and reduced-motion budgets) large enough to be its own pass, and the visual direction is something to
react to rather than have guessed. `packages/ui/src/intelligence/IntelligenceRenderer.tsx` is a
placeholder behind the exact `identityId`/`protocolIds` props the real renderer will take — a CSS
radial-gradient blob per identity, with a NOIR overlay — so replacing its body later touches no
caller. Being CSS rather than a `requestAnimationFrame` loop, it has no per-frame budget to police and
nothing to leak on unmount; the idle-RAF budget in `tokens/motion.ts` (`rendererBudget`) is declared
for the real renderer to honour, not exercised by the placeholder.

NOIR activation is local React state in `Presence.tsx`, not a command — it never calls
`identity.activate` and never touches `identity_threads`. That is what makes "NOIR preserves the
active identity" true by construction rather than by a check: there is no code path from toggling it
to any identity mutation. Likewise "all authority fixtures produce identical decisions across
identities" holds because `packages/domain/src/authority/evaluate.ts` has no `identityId`-conditioned
branch at all — it decides on `actorId`, operation class, and scope, so Phase 5 added nothing to keep
identical here; it verified there was nothing to add.

| Command                         | Result                                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format`                | exit 0                                                                                                                                                                                                                              |
| `npm run format:check`          | exit 0; all matched files use Prettier code style                                                                                                                                                                                   |
| `npm run lint`                  | exit 0; 0 errors (globs extended to `.tsx`)                                                                                                                                                                                         |
| `npm run typecheck`             | exit 0; clean after a full `tsc -b` cache clear                                                                                                                                                                                     |
| `npm run test:unit`             | exit 0; 44 files, 963 tests passed (939 before this batch)                                                                                                                                                                          |
| `npm run test:boundary`         | exit 0; 6 tests passed                                                                                                                                                                                                              |
| `npm run test:desktop`          | exit 0; 6 tests — the pinned crate compiles against the new Vite `dist`                                                                                                                                                             |
| `npm run rust:fmt:check`        | exit 0                                                                                                                                                                                                                              |
| `npm run rust:clippy`           | exit 0; 0 warnings with `-D warnings`                                                                                                                                                                                               |
| `npm run rust:test`             | 37/37 library tests passed; the separate binary-target test could not run — Smart App Control blocked the freshly built test executable (os error 4551), the same intermittent condition Phase 4 recorded, not a Phase 5 regression |
| `npm run build`                 | exit 0                                                                                                                                                                                                                              |
| `npm run build:web`             | exit 0; Vite build, 129 modules, `dist/index.html` + one JS bundle                                                                                                                                                                  |
| `npm run build:desktop`         | exit 0; unbundled release binary, built through the real `beforeBuildCommand` (not a stale `dist/`)                                                                                                                                 |
| Donor repository reconfirmation | HEAD, branch, and untracked file all match `DONOR-BASELINE.json`                                                                                                                                                                    |

New dependencies, all pinned exactly: `react` and `react-dom` 18.3.1 (the master plan names React 18,
not the current 19.x, so the latest 18.x patch was chosen over latest-overall — the same reasoning as
ADR-0003's TypeScript pin), `vite` 8.2.2, `@vitejs/plugin-react` 6.1.1, and their `@types/*` packages.
`@noctis/contracts` moved from a devDependency to a runtime dependency of `@noctis/web`, since
`CoreTransport` now imports `ServerFrameSchema` for real. No new Rust dependency.

The built shell was smoke-run as a real process against a real core, not only tested. `node
apps/core/dist/main.js` bound 127.0.0.1:7717; three direct `identity.activate` calls (`vesper`,
`jester`, `vesper` again) returned distinct thread ids for `vesper` and `jester` and the _same_ thread
id on the repeated `vesper` call, and `GET /identities` listed both threads with `vesper` as
`activeIdentityId` — the "JESTER never mutates a Vesper thread" and "VESPER restores Vesper" gate
clauses, exercised against a live database rather than only asserted in-process. The built
`noctis-desktop.exe` was then launched against that core with only `NOCTIS_CORE_TOKEN` set, and its
log showed `proxied GET /identities -> 200` — proof that the real WebView loaded the real Presence
page, the page's identity-state effect fired on mount, and the request crossed the Rust proxy to the
running core, matching the core's own log of a `200` on `/commands/identity.activate` and the
`/identities` read. Both processes were stopped and their temporary directories removed afterward. An
unrelated orphaned `node apps/core/dist/main.js` process was found already holding port 7717 from an
earlier, unrelated run before this smoke test began; it was inspected (confirmed to be exactly that
command, no other arguments) and stopped so the smoke test could bind the port.

Deliberately not built this batch, carried forward rather than hidden: the canonical Three.js
renderer (placeholder documented above), visual snapshot tests at canonical desktop aspect ratios,
a full accessibility audit beyond native keyboard/focus affordances and `aria-label`/`aria-pressed`
(no contrast or screen-reader pass), and the seven rail destinations other than Command (Chat,
Missions, Artifacts, Vault, Nodes, Automations, Settings render an explicit "not built yet" placeholder
rather than fake content). Phase 5 is not yet proposed as accepted against the full gate in the master
plan pending that renderer and audit work; the identity-runtime and design-token slice above is
verified and safe to build on.

### 2026-09-06 Phase 6 Objective and Adaptive Surface vertical slice

Implemented: the deterministic compositor (`packages/domain/src/compositor/{compose,layouts}.ts`), the
Surface services and their five commands (`apps/core/src/objectives/surface-intents.ts`, wired into
`api/http.ts` as `surface.upsert_intent`, `surface.change_lifecycle`, `surface.set_override`,
`surface.release_override`, `surface.compose`, plus `GET /objectives/:id/surfaces`), the generic
Surface primitives and frame (`packages/ui/src/surfaces/*`), the registry and its renderer table
(`apps/web/src/surfaces/{registry.ts,renderers.tsx}`), the workbench (`apps/web/src/workbench/*`), and
the Command page (`apps/web/src/pages/Command.tsx`), which renders Presence when no Objective is
active and Active Canvas when one is — Objective is state, not a route.

Migration `0003_surfaces.sql` adds no tables. 0001 already declared all three; what was missing was the
uniqueness each relies on, which until now lived only in the service that happened to be the sole
writer. It adds three indexes: Surface identity (`objective_id, kind, source_ids_json`), one live
override per surface/client/display (partial, `WHERE released_at IS NULL`), and one snapshot per
objective/display.

| Gate clause                                              | State                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identical inputs yield identical composition, 1,000 runs | implemented              | `packages/domain/src/compositor/compose.test.ts` — "THE GATE: identical inputs yield identical compositions across 1,000 randomized runs". Each run composes twice **and** once more with the intent array reversed, so it also fails if the plan depended on input order rather than on the input set                                                                                                                                                                 |
| Invalid Surface payloads fall back safely                | implemented              | `compose.test.ts` — "THE GATE: invalid Surface payloads fall back safely"; `apps/web/src/surfaces/registry.test.ts` — "THE GATE: a malformed payload degrades to the fallback instead of throwing"; observed live in the smoke run below                                                                                                                                                                                                                               |
| No model field can set physical geometry                 | implemented              | Structural, not a check: `SurfaceIntentSchema` and `UpsertSurfaceIntentCommandSchema` are `.strict()` and contain no x/y/width/height/z/monitor/duration field, so a payload carrying one fails to parse rather than being stripped and honoured. Covered by `compose.test.ts`, `surfaces.integration.test.ts` (400), and the `.strict()` matrix                                                                                                                       |
| Restore Objective, composition, focus, pinned context    | implemented              | `apps/core/src/objectives/surfaces.integration.test.ts` — "THE GATE: restores the Objective, composition, and pinned context after a restart" closes the core and starts a second one on the same database file. The restored `plan.slots` match exactly while `plan.generatedAt` differs, proving the plan is recomputed rather than replayed                                                                                                                         |
| Keyboard-only activate, arrange, dismiss, restore        | implemented              | `apps/web/e2e/workbench.keyboard.test.mjs` — "THE GATE: activates, arranges, dismisses, and restores without a pointer" drives a real browser against a real core with `Tab`, typing, `Enter`, and `ArrowDown` only. `tabTo` is itself the accessibility assertion: it presses Tab until the focused element's accessible name matches and fails if it never does, so a control that cannot be reached by keyboard fails the gate rather than being clicked into focus |
| Suggested/draft/active transitions separated             | implemented              | Phase 1's `transitionObjectiveStatus` table is the only path and `InitialObjectiveStatusSchema` restricts birth to suggested/draft. `Command.tsx` offers Accept (suggested→draft) then Activate (draft→active) as distinct actions with no shortcut between them                                                                                                                                                                                                       |
| Registry, primitives, layouts, overflow, fallbacks       | partial                  | Five of the fifteen primitives Section 5.3 names are registered — the ones this slice composes. See the deferral list below                                                                                                                                                                                                                                                                                                                                            |
| Production deployment/activation                         | deliberately not started | requires later explicit approval                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Design decisions worth recording:

- **`compositionSignature` is the canonical serialization, not a digest.** Section 5.4 step 8 asks for
  a composition hash. Its only consumer asks one question — "is this the same composition as the one
  already committed" — and comparing the canonical form answers that exactly rather than probably,
  with no crypto primitive in a package that must also run in a browser bundle.
- **No attention-state column.** `LAYOUTS` is a total one-to-one map from attention state to layout id,
  so `attentionStateForLayout` reads the state back out of a persisted `layoutId`. Restore needs no
  schema change to know which of the four states it is restoring into.
- **The snapshot is corroboration, not the restore mechanism.** Because the compositor is pure, the
  `GET` recomputes the plan and a client restores identically without trusting a stored one;
  `composition_snapshots` earns its place as the audit record and as the change detector that gates
  `surface.composition_changed.v1`.
- **The restore point lives on `identity_threads.active_objective_id`**, a column 0001 declared and
  nothing had yet written. Per-identity by construction, so Jester cannot resume into Vesper's work.
- **`ensureThread` was extracted** because two callers could be the first to need a thread — activating
  an identity, and activating an Objective belonging to one — but only one could create it, which
  silently lost the restore pointer in the second case. One shared path fixes every caller.

Two event names were appended: `surface.override_released.v1` and `surface.lifecycle_changed.v1`.
Section 4.3 reserves names "such as" the list it gives, so that list is a floor; a release folded into
`override_set` would make every listener filtering for a set override act on its removal.

| Command                    | Result                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`     | exit 0; all matched files use Prettier code style                                                                                                       |
| `npm run lint`             | exit 0; 0 errors                                                                                                                                        |
| `npm run typecheck`        | exit 0                                                                                                                                                  |
| `npm run test:unit`        | exit 0; 48 files, 1021 tests passed (963 before this batch)                                                                                             |
| `npm run test:integration` | exit 0; 4 files, 108 tests passed                                                                                                                       |
| `npm run test:boundary`    | exit 0; 6 tests passed                                                                                                                                  |
| `npm run test:e2e`         | exit 0; 1 test passed in ~2.4s — the keyboard gate, run here against Edge (see the E2E note below)                                                      |
| `npm run test:security`    | exit 0; no dedicated security tests exist yet                                                                                                           |
| `npm run test:performance` | exit 0; no dedicated performance tests exist yet                                                                                                        |
| `npm run test:desktop`     | exit 0; 6 tests                                                                                                                                         |
| `npm run build`            | exit 0                                                                                                                                                  |
| `npm run build:web`        | exit 0; Vite build, `dist/index.html` plus one JS bundle                                                                                                |
| `npm run rust:fmt:check`   | exit 0                                                                                                                                                  |
| `npm run rust:clippy`      | exit 0; 0 warnings with `-D warnings`                                                                                                                   |
| `npm run rust:test`        | exit 0; 37/37 library tests passed and the binary target compiled and ran this time — the Smart App Control block Phases 4 and 5 recorded did not recur |

One new declared dependency and no new resolved package: `zod` 4.4.3 was added to `@noctis/web`, which
now imports it directly to validate core responses. It was already in the tree through
`@noctis/contracts`; the lock diff is two lines and adds no download.

**Smoke run — the slice driven keyboard-only in a real browser against a real core.** `node
apps/core/dist/main.js` on 127.0.0.1:8787 with a temporary database, the built Vite bundle served on
localhost:4173. Typing a title and pressing Enter created a `suggested` Objective; Tab to **Accept**
and Enter moved it to `draft`; Enter again on **Activate** moved it to `active` and composed three
Surfaces into `canvas.split` (`display.wide`) with Choices in `left`, Conversation in `centre`, and
Detail in `right`. Choosing "Control (bottom)" in Detail's **Place** select moved it and added
`override.honoured` and a **Release placement** control. A full page reload returned straight to the
active Objective with all three Surfaces in their arranged regions — no Presence screen, no
re-activation. Narrowing the window to 1000px produced `display.compact`, one placed Surface, and
"2 Surfaces did not fit" in the `<details>` overflow stack with `overflow.capacity`; widening restored
the override exactly, and the intermediate state also demonstrated per-display scoping, since the
narrower window reported a different `screen` and its fingerprint correctly put the override out of
scope. Focusing **Dismiss Choices** and pressing Enter removed it and added `lifecycle.excluded`.
Finally, upserting an intent of kind `native_application` — which nothing registers — rendered the
fallback in place ("no renderer is registered for this kind") while the other two Surfaces continued to
render, which is the "falls back safely" gate observed rather than asserted.

Two real defects were found by that smoke run and fixed, neither visible to the unit tests:

1. **The dev/preview proxy missed any path carrying a query string.** `apps/web/vite.config.ts` gained
   a proxy at all this batch, because Section 9.2's "CORS is not treated as CSRF protection" means the
   core deliberately emits no permissive CORS headers — so a cross-origin browser request cannot
   succeed, and `BrowserTransport`, which `core-client.ts` says exists for local iteration, was
   unusable without one. The first pattern anchored on `/` or end-of-string, so `/objectives?limit=25`
   fell through to the SPA and was answered with `index.html` and a 200.
2. **The workbench trusted the shape of a 200 response.** Reading `.objectives` off that HTML crashed
   the page. `Command.tsx` and `useComposition.ts` now parse every core read through the contract
   schemas, so a body that is not what it claims degrades to a stated error instead of a blank screen —
   the same fail-closed rule the core already applies to its own input.

Both servers were stopped and the temporary database removed afterward. No browser artifacts remain in
the repository.

Deliberately not built this batch, carried forward rather than hidden:

- **Ten of the fifteen Section 5.3 primitives.** Conversation, List/Choice, Detail, Evidence, and
  Attention are registered because this slice composes them. Approval belongs to Phase 8, Native
  Application to Phase 9, External Tool to Phase 10, and Vault Recall to Phase 7; registering empty
  components for them now would be scaffolding pretending to be a registry, and the fallback already
  renders an unregistered kind safely, as demonstrated above.
- **The registry's capability/authority requirements and source-refresh action.** Both are named in
  Section 5.3 and both are omitted until the phase that can enforce them: a `requires` array that
  nothing checks is false comfort, not a safety property. Adding them is additive.
- **Model-proposed Surfaces.** `Command.tsx` seeds three intents from the Objective record itself on
  activation — every field comes from the record and nothing is invented to fill a frame. Phase 8 gives
  the identities a provider and they propose through the same `surface.upsert_intent` command, at which
  point the seeding function goes away; the upsert is keyed by Surface identity, so proposing the same
  Surfaces twice updates rather than duplicates them.
- **Visual snapshots and a full accessibility audit.** Controls are native `<button>`, `<select>`,
  `<input>`, `<details>`, and `<form>` throughout, so focus, activation, and announcement come from the
  platform rather than from hand-rolled handlers, and the E2E suite now proves Tab-reachability for the
  controls the gate names. `typography.color` was added, paying down Phase 5's four hard-coded
  `#E7E6EE` call sites; both of its values clear 4.5:1 against every `depth` layer. No systematic
  contrast sweep, screen-reader pass, or canonical-aspect-ratio visual snapshot has been run.
- **The canonical Three.js intelligence renderer**, unchanged from Phase 5.

Phase 6 is not proposed as accepted against the full gate: the registry carries five of the fifteen
primitives Section 5.3 names. Every gate clause in the table above is implemented and evidenced, and
the compositor, Surface services, restore path, and workbench are safe to build on.

#### Browser E2E infrastructure

`playwright` 1.63.0 is now a pinned dev dependency and `test:e2e` runs a real browser. It is the
driver library, not `@playwright/test`: the `test:e2e` script already runs `node --test`, and a second
test runner alongside Vitest and `node:test` would have bought auto-waiting assertions the Playwright
`Locator` API already provides. Playwright installs no browser on `npm ci`, so the install stays fast;
CI gained an explicit `npx playwright install chromium` step between `npm run build` and
`npm run test:e2e`, and `build` must come first because the suite serves the built workspace packages
and runs the core from `apps/core/dist` (the suite asserts this with a named message rather than
failing opaquely).

The suite starts its own core on a temporary database and its own `vite` dev server, then stops both.
Dev rather than a preview of `dist`, because `VITE_CORE_URL` is inlined at build time and previewing
would mean building a bundle carrying a test token; dev serves the same source and leaves no such
artifact.

Two things this cost, both worth recording because neither was obvious:

- **`shell: true` orphans a server on Windows.** With a shell the direct child is `cmd.exe`, so
  `kill()` stopped the shell and left the core and Vite running with their stdio pipes still attached
  — and `node --test` then never exited, which looked like a hung test rather than a cleanup bug. The
  suite spawns both binaries directly through `process.execPath`.
- **The gate's first selector was wrong in a way that mattered.** `input[aria-label='New Objective']`
  matched nothing: the field is named by its wrapping `<label>`, not by an `aria-label`. `tabTo` now
  resolves the accessible name the way a screen reader would — `aria-label`, then `element.labels`,
  then text content — which is both what made the test pass and a better assertion than the attribute
  check would have been.

Red-green was verified by sabotage, not by assuming: replacing
`setActiveObjectiveId(thread?.activeObjectiveId)` with `undefined` in `useIdentityRuntime.ts` made the
suite fail on the restore leg with "the workbench did not restore the active Objective after a
reload", naming the canvas it actually saw. The sabotage was reverted and the suite re-run green.

Locally the run recorded above used `NOCTIS_E2E_BROWSER_CHANNEL=msedge` against the installed Edge 152,
because the bundled Chromium cannot launch on this machine. The cause is Smart App Control, the same
condition Phases 4 and 5 recorded against the Rust test executables (`os error 4551`), now identified
precisely: `HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState` is `1`,
and both `chromium-1243\chrome-win64\chrome.exe` and
`chromium_headless_shell-1243\...\chrome-headless-shell.exe` report `Get-AuthenticodeSignature`
`NotSigned`. Running either directly gives "An Application Control policy has blocked this file", and
Playwright surfaces it as `browserType.launch: spawn UNKNOWN`. Smart App Control admits no per-file
exception — it permits signed and reputable binaries only — so an unsigned browser build is refused
whatever else is configured. The installed Edge and Chrome are both `Valid`-signed and therefore run,
which is why the channel override works.

An earlier revision of this entry attributed the same symptom to
`playwright.download.prss.microsoft.com` being unreachable. That was wrong: `npx playwright install
chromium` later succeeded on the first attempt with the full 114.6 MiB transferred, DNS resolves, and
TCP 443 connects on both IPv4 and IPv6. The initial download failures were transient and unrelated to
the launch block that actually prevents the bundled browser from running here.

`NOCTIS_E2E_BROWSER_CHANNEL` is an explicit opt-in and never a silent fallback: with it unset, the
suite uses the Chromium this Playwright version pins, which is what CI does and therefore what the gate
is proven against there. GitHub's hosted runners do not enable Smart App Control, so the pinned browser
launches there.

Confirmed after the push: GitHub Actions `verify` run `34045341594`, `javascript` job green in 2m35s
on commit `80e4488`, with `npx playwright install chromium` and `npm run test:e2e` both passing. The
keyboard gate is proven against the pinned Chromium, not only against this machine's Edge. The same
run also covers Phase 7's unit suite on the pinned Node runtime.

### 2026-09-06 Phase 7 Vault port, stable sphere, and focused recall

Implemented: Markdown reading and the deterministic sphere layout
(`packages/domain/src/vault/{markdown,layout,view}.ts`), the Vault root guard,
indexer, recall, and atomic write primitives (`apps/core/src/vault/*`, wired into
`api/http.ts` as `vault.reindex` and `vault.recall` plus `GET /vault`,
`GET /vault/graph`, and `GET /vault/recall`), the recall Surface and the dedicated
sphere view (`packages/ui/src/vault/*`), the `vault_recall` registry kind, the Vault
page (`apps/web/src/pages/Vault.tsx`) with the Open-in-Vault and return handoff, and
the fixture Vault generator (`packages/test-kit/src/vault.ts`, run through
`scripts/fixtures/create-test-vault.mjs`).

Migration `0004_vault.sql` adds the six tables Section 4.1 lists and migration 0001
deliberately left for this phase: `vault_items`, `vault_entities`, `vault_edges`,
`vault_mentions`, `vault_layout`, `vault_recalls`. Everything in them is disposable —
Markdown in the configured root is the memory authority, and no note body is ever
stored, only a hash.

| Gate clause                                           | State                    | Evidence                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeated indexing is stable                           | implemented              | `apps/core/src/vault/vault.integration.test.ts` — "THE GATE: repeated indexing is stable" compares item rows, ids, layout coordinates, and every table count across two runs, not just the summary counts. Confirmed live: a second reindex reported `added 0, unchanged 7` with entity and edge counts unchanged                 |
| Changed notes invalidate only affected derivations    | implemented              | "THE GATE: a changed note invalidates only its own derivations" edits one note and asserts the untouched note's mention rows are identical _by id_, while the edited note gains its new edge. Unchanged notes are skipped on hash, so their derived rows are never dropped and rebuilt                                            |
| Provenance is navigable                               | implemented              | "returns provenance that points back at real prose" re-reads each cited note and asserts `contents.slice(span.start, span.end) === quote`. Every mention carries note, span, and the content hash at derivation time                                                                                                              |
| current/stale/unknown language is correct             | implemented              | Three separate tests: current, "THE GATE: calls evidence stale once the note behind it changes", and "THE GATE: calls evidence unavailable when the note is gone", plus "says unknown when nothing matched rather than claiming nothing exists". `unknown` and `unavailable` never stand in for each other                        |
| No live Vault path is touched                         | implemented              | `apps/core/src/vault/root.test.ts` — four THE GATE cases; the core refuses to start at all when the configured root looks live. Verified end to end against a decoy `.../OneDrive/MindVault`: refused by default, and only `NOCTIS_VAULT_ALLOW_LIVE=true` started it, logging `live: true`. The real Vault was never read         |
| Markdown parsed without changing prose                | implemented              | "THE GATE: indexes every note and leaves the prose byte-identical" reads all seven fixture notes before and after indexing. The module has no serializer at all — every function takes a string and returns data                                                                                                                  |
| Deterministic seeded coordinates, bounded settlement  | implemented              | `packages/domain/src/vault/layout.test.ts` — "THE GATE: never moves a node that is already placed" and "THE GATE: a settled graph is a fixed point, so nothing wanders at rest". Order-independence and the iteration ceiling are covered too                                                                                     |
| Pan, zoom, rotation, labels, relationships, focus     | implemented              | `packages/domain/src/vault/view.test.ts` — 16 tests over the camera and `focusSubgraph`, including "THE GATE: opens only the focused subgraph, not the whole Vault". The renderer reads those functions; it does not reimplement them                                                                                             |
| Focused recall Surface, Open in Vault, return context | implemented              | `vault_recall` is a registered Surface kind with its own payload schema and fallback. Activating an Objective runs one recall and proposes the Surface only when there is evidence; `App.tsx` holds the return destination so the jump is a round trip                                                                            |
| Atomic writes and conflict detection, writes disabled | implemented              | `writeNoteAtomically` is temp-file, fsync, rename with a pre-rename hash check. "THE GATE: are disabled by default" plus path-escape and conflict tests. `NOCTIS_VAULT_ALLOW_WRITES` is separate from `NOCTIS_VAULT_ALLOW_LIVE`: reading a real Vault and writing to one are different consequences and neither implies the other |
| Production deployment/activation                      | deliberately not started | requires later explicit approval                                                                                                                                                                                                                                                                                                  |

Design decisions worth recording:

- **Entities are derived deterministically, not by a model.** The donor's entity
  engine extracts named entities through a model router. Phase 7 derives an entity
  from note identity and wikilink targets instead, because "repeated indexing is
  stable" forbids a non-reproducible index. Model-proposed entities need Phase 8's
  provider work and are additive.
- **A note's type comes from its PARA folder**, exactly as the donor did it, so
  typing needs no inference either.
- **`keys_index` on `vault_entities`.** A wikilink written through an alias must
  reach the note it names, and giving each alias its own entity row would put two
  nodes in the graph for one note. Keys are stored pipe-wrapped and matched with
  `LIKE`; normalized keys can never contain a pipe, because the wikilink grammar
  treats it as the alias separator.
- **A link to an unwritten note is a real, unresolved edge.** The placeholder entity
  is adopted when the note finally appears, so the graph connects without anything
  being rewritten — verified by a test that writes the missing note and re-indexes.
- **The SVG sphere is an interim view, and it is here because of a mistake.** It was
  built on the claim that the donor's Three.js component is `REPLACE` in the Section
  13.1 matrix. That is wrong: line 765 reads `Existing Vault sphere interactions |
KEEP + REFACTOR | Preserve pan/zoom/rotation/labels/focus and visual familiarity`,
  and Phase 7 asks for the sphere interaction to be ported. The donor component is a
  finished, already-approved system, not a mockup. Porting it is folded into the
  Phase 7 acceptance work; `DONOR-PORT-LEDGER.md` records what the port involves and
  why the refactor is narrower than it looks. `packages/ui/src/vault/VaultSphere.tsx`
  and `packages/domain/src/vault/view.ts` should be deleted when the real one lands.

  What the mistake did not cost: `packages/domain/src/vault/layout.ts` is the exact
  refactor the matrix asks for. The donor has the renderer and no stable coordinates;
  this phase built stable, persisted coordinates and a lesser renderer. They are the
  two halves of one job, and only the renderer half needs redoing.

Donor ports are recorded in `docs/architecture/DONOR-PORT-LEDGER.md` with commit
`ee7b4527`, MIT licence and attribution in each ported file: `parseWikilinks` and
`normalizeKey` from `server/lib/vault.js`, and the Fibonacci type anchor `anchorFor`
from `client/src/components/VaultSphere.tsx`. The ledger also records what was
deliberately not ported and why. The donor repository was confirmed unchanged: HEAD
`ee7b4527`, branch `dev/personal-pc`, and the single untracked v5 spec, all matching
`DONOR-BASELINE.json`.

| Command                    | Result                                                                  |
| -------------------------- | ----------------------------------------------------------------------- |
| `npm run format:check`     | exit 0; all matched files use Prettier code style                       |
| `npm run lint`             | exit 0; 0 errors                                                        |
| `npm run typecheck`        | exit 0                                                                  |
| `npm run test:unit`        | exit 0; 53 files, 1098 tests passed (1021 before this batch)            |
| `npm run test:integration` | exit 0; 5 files, 128 tests passed                                       |
| `npm run test:e2e`         | exit 0; 1 test passed, run here against Edge (see the Phase 6 E2E note) |
| `npm run test:boundary`    | exit 0; 6 tests passed                                                  |
| `npm run test:desktop`     | exit 0; 6 tests passed                                                  |
| `npm run test:security`    | exit 0; no dedicated security tests exist yet                           |
| `npm run test:performance` | exit 0; no dedicated performance tests exist yet                        |
| `npm run build`            | exit 0                                                                  |
| `npm run build:web`        | exit 0                                                                  |
| `npm run rust:fmt:check`   | exit 0                                                                  |
| `npm run rust:clippy`      | exit 0; 0 warnings with `-D warnings`                                   |
| `npm run rust:test`        | exit 0; 37/37 library tests passed                                      |

CI evidence for this batch: GitHub Actions `verify` run 34045341594 on commit
`80e4488` — javascript green in 2m35s including `playwright install chromium` and
`test:e2e` on the pinned browser, rust green in 18m25s covering fmt, clippy, 37
tests, and the unbundled Tauri build against the Phase 6/7 web assets.

That run predates the sphere port. `80e4488` did not yet contain `5375e45`, which
is the commit that actually closed the Phase 7 gate, and GitHub fires `verify`
once at the pushed tip rather than once per commit, so `5375e45` never had a run
of its own. The evidence covering the ported sphere is run **34152451907** on
commit `a95fbe1` — both jobs green, rust in 18m27s. Cited here rather than only in
the Phase 8 entry, because it is this entry's gate that the later run proves.

Three existing assertions moved with the schema rather than being worked around:
the migration table count 27 to 33, the reported schema version 3 to 4, and
`events.test.ts`'s "rejects an unknown stream type", which had been using `"vault"` —
a name the enum now genuinely has, so the test needed a name it genuinely does not.

**Smoke run — the fixture Vault indexed by a real core.**
`node scripts/fixtures/create-test-vault.mjs` wrote seven notes; a core started with
`NOCTIS_VAULT_ROOT` pointed at them reported `configured: true, live: false,
writesEnabled: false`. The first `vault.reindex` returned
`scanned 7, added 7, entities 8, edges 8`, and the second returned
`scanned 7, added 0, unchanged 7` with identical entity and edge counts — the
stability gate observed rather than only asserted. The eight entities are the seven
notes plus one placeholder for `[[Future Retrospective]]`, which nothing has written;
the eight edges exclude the `[[Not A Real Link]]` inside `runbook.md`'s code fence.
`GET /vault/recall?query=Alex%20Kerr` returned evidence quoting `[[Alex]]` from
`people/sam-oyelaran.md` — an alias resolving to the Alex Kerr note in a live core —
with correct spans and `freshness: current`. `GET /vault/graph` returned persisted
coordinates rather than recomputed ones.

Two real defects were found while building this and fixed:

1. **`freshnessFor` compared two database rows.** It read the file and then ignored
   its contents, so a note edited outside Noctis could never be reported as stale —
   the exact case the word exists for. It now hashes the bytes on disk, because the
   note is the authority and the index is the thing that can be out of date.
2. **`fsync` on a read-only handle is `EPERM` on Windows.** The atomic write opened
   the temp file a second time to flush it; it now writes and flushes through one
   descriptor.

Deliberately not built this batch, carried forward rather than hidden:

- **Model-extracted entities.** Deterministic derivation is what makes repeated
  indexing stable; a model-proposed entity layer belongs with Phase 8's providers and
  would ride the same tables.
- **A file watcher.** Reindexing is an explicit command. Section 7 asks for a
  rebuildable index, not a live one, and a watcher is a behaviour worth designing
  once sources exist in Phase 8.
- **Full-text recall.** Matching is `LIKE` over entity keys and names — the same
  vocabulary a wikilink uses. FTS5 when a real corpus proves it too slow, not before.
- **The donor Three.js sphere port**, folded into the Phase 7 acceptance work rather
  than deferred to a later phase. This is not the Phase 5 intelligence-renderer
  deferral, which is a genuinely unbuilt design: the Vault sphere exists, is
  approved, and needs porting and refactoring, not inventing.
- **Any contact with the live Vault**, which is Phase 14's gated copy, hash
  verification, backup, rollback, and explicit approval.

Phase 7 is not proposed as accepted against the full gate. Three things remain,
and they are one batch of work: porting the donor sphere, giving it the keyboard
and screen-reader layer the donor never had, and the visual snapshots still
outstanding from Phases 5 and 6. `GET /vault/graph` also truncates silently at
`MAX_PAGE_SIZE` (500) — a defect rather than a trade-off, and one the ported
renderer makes newly relevant, since it can draw far more than 500 nodes.

Every gate clause in the table above is implemented and evidenced. The indexer,
provenance, freshness, stable layout, recall path, and the live-Vault guard are
verified and safe to build on; only the renderer is interim.

### 2026-09-06 Phase 7 acceptance — the donor sphere, ported

The three things the Phase 7 entry above left open are done: the donor's Three.js
sphere is ported, it has the keyboard and screen-reader layer the donor never
had, and `GET /vault/graph` no longer truncates in silence.

**The port.** `packages/ui/src/vault/VaultSphere.tsx` is now
`Jarvis-Sub-Agent-Dashboard@ee7b4527`'s `client/src/components/VaultSphere.tsx`,
MIT, attributed in the file and recorded in `DONOR-PORT-LEDGER.md`. The whole
visual system came across intact — the lat/long wireframe shell, the starfield,
the crystal core with its glow sprite and counter-rotating cage, the core rays,
per-node halo sprites through the same point shader, quadratic-bezier curved
edges with the bow-and-clamp, travelling pulses, degree sizing, the sparsest-
edges-first thinning, screen-space picking with its 14px hit radius, the
OrbitControls tuning, idle rotation that pauses on interaction, camera fly-to,
double-click neighbourhood focus, canvas label LOD, and the reduced-motion path.
`three@0.170.0` is pinned to the donor's line.

Three things differ, and the first is the one that matters:

- **`tickSim` is deleted, not parameterised.** The ledger expected the refactor
  to be `wander: false` plus seeding from `vault_layout`. That reading was
  wrong: the donor's simulation also applies repulsion, link springs, and
  containment, all of which move a node every frame regardless of the wander
  flag. Noctis's coordinates are already settled by
  `packages/domain/src/vault/layout.ts` and persisted, so a second solver in the
  renderer would walk every client's sphere off the coordinates they are all
  supposed to agree on. Positions are read, scaled into the donor's world units,
  and drawn. "No continuous wandering" is now structural rather than a flag.
- **`SphereFx` is gone** — the donor's scan/spark/birth flashes and hot edges are
  engine coupling with no Noctis event behind them.
- **An accessibility layer exists.** The donor component has no `tabIndex`,
  `role`, or `aria-*` at all, so every behaviour it had was pointer-only. Here
  the canvas is `aria-hidden` decoration and the list beneath it is the real
  control surface: one button per node carrying its name, type, link count, and
  whether the note has been written, with focus, isolation, and open on the
  keyboard.

`packages/domain/src/vault/view.ts` lost its camera — `project`, `clampCamera`,
and the perspective divide belonged to the interim SVG renderer, and
OrbitControls owns pan, zoom, and rotation now. `focusSubgraph` stayed: it is a
graph query, not a way to draw one, and the ported sphere calls it for
neighbourhood isolation.

The arithmetic lives in `packages/ui/src/vault/sphere.ts` with no `three` import,
so edge thinning, the bezier bow, the coordinate scale, and the label LOD rule
are tested without a WebGL context (`sphere.test.ts`, 13 tests).

**Two real defects were found and fixed.**

1. **`GET /vault/graph` truncated silently.** It shared `MAX_PAGE_SIZE` (500)
   with every collection read, so a Vault larger than 500 entities became an
   alphabetical slice of itself with nothing in the response saying so. The
   graph is a whole graph rather than a page of one, so it now has its own
   ceiling (`MAX_GRAPH_NODES`, 5000) and always returns `total` and `truncated`.
   The page renders that as a sentence. A second bug rode along: edges were read
   as `LIMIT limit * 4` independently of the nodes, so a truncated graph could
   hand the renderer edges pointing at nodes it was never sent. Edges are now
   filtered to the returned node set.
2. **The Vault page had never worked in a browser.** `vault` was missing from
   the dev proxy's `CORE_PATHS` allowlist in `apps/web/vite.config.ts`, so every
   Vault request was answered with the SPA's `index.html` at 200 — the exact
   failure mode the comment above that regex warns about. Nothing caught it
   because no browser test had ever opened the Vault page. The new E2E suite
   caught it on its first run.

| Gate clause                                       | State       | Evidence                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pan, zoom, rotation, labels, relationships, focus | implemented | OrbitControls with the donor's damping, rotate speed, and 7–460 distance range; canvas label LOD via `labelOpacity`; `focusSubgraph` for isolation. `apps/web/e2e/vault.keyboard.test.mjs` drives focus and isolation by keyboard         |
| No continuous force wandering                     | implemented | there is no simulation in the renderer at all. `sphere.test.ts` asserts `toWorld` is a pure scale, so a drawn position is the persisted one times a constant                                                                              |
| Sphere is operable without a pointer              | implemented | `vault.keyboard.test.mjs` — "THE GATE: indexes, focuses, and isolates a subgraph without a pointer" never touches the canvas, and asserts the canvas is `aria-hidden`                                                                     |
| Graph reads report their own limits               | implemented | `headless.integration.test.ts` — "THE GATE: says so when the graph is larger than the read" and "THE GATE: never returns an edge pointing at a node it did not return"                                                                    |
| Contrast sweep and accessibility pass             | implemented | `packages/ui/src/tokens/contrast.test.ts` — 80 cases: every text colour against the floor and all four depth layers at WCAG AA 4.5:1, every indicator colour at 3:1. All pass; the claim in `type.ts` is now checked rather than asserted |

**On visual snapshots.** They are still not built, and this is a decision rather
than a deferral. A pixel diff of a WebGL scene is not a gate that can hold: the
globe's output depends on the GPU, the driver, and the antialiasing the machine
happens to do, so a committed baseline would fail on CI, pass locally, and teach
everyone to regenerate it. What a snapshot was wanted for — "did the UI change
without anyone noticing" — is covered instead by the accessibility-tree
assertions in the two keyboard E2E suites, which are stable across machines and
fail for reasons that are readable. If a real visual regression appears that
these miss, the answer is a Percy-style hosted diff, not a PNG in the repository.

### 2026-09-06 Phase 8 full authority, sources, artifacts, and approval UI

Implemented: the AuthorityService's three acts (`apps/core/src/authority/service.ts`),
the typed-confirmation rule and constraint-aware evaluator
(`packages/domain/src/authority/{confirmation,evaluate}.ts`), source truth with
normalized freshness (`apps/core/src/sources/service.ts`), artifacts with lineage
(`apps/core/src/artifacts/service.ts`), the Approval, Artifact, and Source State
Surfaces (`packages/ui/src/surfaces/consequence.tsx`), the Settings permissions
screen and the Artifacts destination (`apps/web/src/pages/{Settings,Artifacts}.tsx`),
and node job dispatch routed through the evaluator (`apps/core/src/nodes/jobs.ts`).

Migration `0005_authority.sql` adds the columns the boundary needs rather than new
tables: `approvals` gains `confirmation_phrase`, `confirmed_at`, `confirmed_by`,
`executed_at`, and the execution evidence; `standing_permissions` gains
`granted_by` and `revoked_reason`; `sources` gains `unavailable_semantics`;
`artifacts` gains `derived_from_artifact_id` with a unique partial index that
makes a second import of one reference impossible at the storage layer.

| Gate clause                                                           | State                    | Evidence                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bypass from the UI fails                                              | implemented              | `headless.integration.test.ts` — "refuses to execute a decision nobody confirmed" (403, `not_confirmed`, and `executedAt` still absent afterwards). The Approval Surface has no Execute control at all until `confirmedAt` is set, so the UI cannot render the bypass either                                     |
| Bypass from the model fails                                           | implemented              | the same path: a model can only reach `authority.request`, and every consequence class returns `require_confirmation` or `require_typed_confirmation`. `evaluate.test.ts` — "allows only read_inspect without a scope or a permission" runs over the full operation-class enum                                   |
| Bypass from an adapter fails                                          | implemented              | `AUTHORITY_MANAGEMENT_CAPABILITIES` — "THE GATE: never lets a permission grant the power to grant permissions". A standing permission cannot cover `authority.grant_permission`, so no adapter can widen its own scope                                                                                           |
| Bypass from a replay fails                                            | implemented              | "answers a retry of the same submit with the same result" versus "THE GATE: a duplicate submit cannot repeat an external consequence". A replayed key returns the original result; a new key on an executed approval is refused                                                                                  |
| Bypass from a node fails                                              | implemented              | `enqueueJob` evaluates authority before the row exists, using `CAPABILITY_OPERATION_CLASS` rather than anything the caller sends, so a job cannot understate its own operation class. "THE GATE: a node cannot be a way around authority" covers both the allowed and the refused path                           |
| Duplicate submit cannot repeat an external consequence                | implemented              | `executed_at` is written by an `UPDATE ... WHERE executed_at IS NULL` inside the transaction that read it. The test asserts the second submit is refused **and** that the first submit's evidence is what survived                                                                                               |
| Status cannot claim published/complete until source/evidence verifies | implemented              | three tests: an external reference stays external until an import produces a host and a checksum; a source says `unknown` before anyone looked and never confuses that with `unavailable`; `executedAt` is the only thing the Approval Surface renders "executed" from, never the fact that a button was pressed |
| Every operation class and typed confirmation rule                     | implemented              | `confirmation.test.ts` and `evaluate.test.ts` — "gives every typed class a phrase and every other class none" iterates the whole enum. The phrase carries the amount for a spend and the exact target for a destructive operation                                                                                |
| Narrow standing permissions, expiry, visibility, revocation           | implemented              | "THE GATE: a standing permission is narrow and target-bound" — five cases covering another target, another type, another host, a host-bound grant against a host-less request, and authority management. Settings lists live and revoked grants with reasons                                                     |
| Prepare-versus-commit boundaries and idempotency                      | implemented              | ADR-0018. Three commands, one row, and a test for each edge                                                                                                                                                                                                                                                      |
| External references versus local artifacts and lineage                | implemented              | "keeps an external reference external until an import produces bytes" plus a unique index proving the second import cannot race the first                                                                                                                                                                        |
| Source freshness and remembered/current conflict display              | implemented              | "THE GATE: shows a remembered/current conflict rather than replacing one with the other", and "does not call two identical observations a conflict". `status` is computed on read against the clock, never trusted from the row                                                                                  |
| Production deployment/activation                                      | deliberately not started | requires later explicit approval                                                                                                                                                                                                                                                                                 |

Design decisions worth recording:

- **`unavailableSemantics` is a property of the source, not a guess by the
  reader.** A payment provider that cannot be reached must not read as "no
  charges", but a feed that cannot be reached may reasonably read as "nothing
  new". Section 12.1 asks a source to declare its unavailable semantics; without
  the column, every reader decided for itself, and the safe reading is the one
  nobody picks under time pressure.
- **An import writes a second row.** Changing the external reference's kind in
  place would be a shorter diff and would destroy exactly what Section 12.2 asks
  for: after the import, Noctis can still say which remote thing the local file
  came from.
- **Section 5.3's two missing registry fields now exist because both halves do.**
  `requires` names a capability and `resolveSurface` refuses to render a Surface
  whose capability the caller does not hold; `sourceRefresh` marks the Surfaces
  the workbench should offer a refresh action to. Phase 6 left both out on the
  grounds that a `requires` array nothing checked would be false comfort, which
  was right then and is no longer true.
- **The approval Surface is never `compact`.** A consequence boundary too small
  to show its target is one that gets approved without being read.

| Command                    | Result                                                                            |
| -------------------------- | --------------------------------------------------------------------------------- |
| `npm run format:check`     | exit 0; all matched files use Prettier code style                                 |
| `npm run lint`             | exit 0; 0 errors                                                                  |
| `npm run typecheck`        | exit 0                                                                            |
| `npm run test:unit`        | exit 0; 56 files, 1221 tests passed (1098 before this batch)                      |
| `npm run test:integration` | exit 0; 5 files, 150 tests passed (128 before)                                    |
| `npm run test:e2e`         | exit 0; 4 tests across 3 suites, run here against Edge (see the Phase 6 E2E note) |
| `npm run test:boundary`    | exit 0; 6 tests passed                                                            |
| `npm run test:desktop`     | exit 0; 6 tests passed                                                            |
| `npm run test:security`    | exit 0; no dedicated security tests exist yet                                     |
| `npm run test:performance` | exit 0; no dedicated performance tests exist yet                                  |
| `npm run build`            | exit 0                                                                            |
| `npm run build:web`        | exit 0; 801 kB bundle, 214 kB gzipped — `three` is 500 kB of that                 |
| `npm run rust:fmt:check`   | exit 0                                                                            |
| `npm run rust:clippy`      | exit 0; 0 warnings with `-D warnings`                                             |
| `npm run rust:test`        | exit 0; 37/37 library tests passed                                                |

Three existing assertions moved with the schema rather than being worked around:
the reported schema version 4 to 5, and the `ArtifactRecord`, `StandingPermission`,
and `SourceRecord` contract fixtures, each of which gained the field its schema now
requires. The `StandingPermission` fixture's `constraints: {}` is the clearest of
the three — an empty constraint object used to be a valid permission, and is now a
permission that matches nothing.

**The bundle grew by 500 kB.** `three` is the cost of the port, and it is paid on
a desktop shell loading from disk rather than a website loading over a network.
Worth revisiting only if the Tauri cold start becomes measurably slower; there is
no evidence it has.

Deliberately not built this batch, carried forward rather than hidden:

- **`provider_decisions`** and the provider routing that would write to it —
  Section 8, not Phase 8's task list. ADR-0019.
- **Real execution evidence.** The boundary is built and proven; the only caller
  today is the workbench, which records `{ confirmedInWorkbench: true }`. The
  adapters that reach a real external system arrive with Phases 10 and 11, and
  the Artifacts page does not pretend otherwise.
- **A grant form in Settings.** Revocation is the half that has to exist the
  moment permissions do, and it does. Granting standing authority through a form
  before any adapter needs one would be building the riskiest control first.
- **Visual snapshots**, for the reason recorded in the Phase 7 acceptance entry
  above.
- **Still deferred from earlier phases:** ten of the fifteen Surface primitives
  (three of them landed here), the Phase 5 intelligence renderer, and four of the
  six remaining rail destinations — Artifacts and Settings are built now, leaving
  Chat, Missions, Nodes, and Automations.

CI evidence for this batch: GitHub Actions `verify` run **34152451907** on commit
`a95fbe1` — `javascript` green in 2m41s including `playwright install chromium`
and `test:e2e` on the pinned browser, `rust` green in 18m27s covering fmt, clippy,
`rust:test`, and the unbundled Tauri build. This is also the first CI run whose
tree contains `5375e45`, so it doubles as the Phase 7 sphere port's evidence.

### 2026-09-07 Phase 9 (part 1) the decision layer for native window placement

**Phase 9 is not complete.** This batch builds the half that decides _whether and
where_ a window may be moved. Nothing here calls Win32 yet, and no window has
been moved by Noctis. The qualification matrix the gate names cannot be run until
the FFI layer exists, so the gate is open.

The repository gained a Cargo workspace. `apps/desktop/src-tauri` was a standalone
crate with its own lock; it and the new `crates/noctis-windows` are now members of
a root `Cargo.toml`, and `Cargo.lock` moved to the root. The lock diff is nine
lines — the new crate and nothing else — so no transitive dependency was
re-resolved by the move. The four `rust:*` scripts became `--workspace` and
`--all`, which is a smaller change than running each of them twice.

Implemented in `crates/noctis-windows`:

- `geometry.rs` — `WorkArea`, `Placement`, and `fit`, moved out of the desktop
  shell's `placement.rs` rather than copied. Placing another application's window
  into a named region and restoring Noctis's own window after a crash are the same
  rectangle problem, and the shell now calls the crate for it.
- `identity.rs` — `evaluate` over five signals, and `MatchEvidence::is_actionable`,
  which is `(launch_correlated || executable_matched) && class_matched`. Title is
  absent from that expression by construction.
- `guard.rs` — `is_protected` and `admit`, checked in that order.
- `monitor.rs` — display roles rather than indices, with a deterministic ordering.
- `region.rs` — named regions resolved through work area, DPI, minimum size, and a
  saved user override.

Implemented in TypeScript: `packages/contracts/src/window.ts` (the wire contract
and `WINDOW_CAPABILITY_OPERATION_CLASS`), and the window-placement authority
routing tests in `packages/domain/src/authority/evaluate.test.ts`.

| Gate clause                                            | State                    | Evidence                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System/security windows cannot be moved                | implemented              | `guard.rs` — "THE GATE: refuses a protected window even when a grant would have matched it". The test first asserts the over-broad grant genuinely matches, then that `admit` refuses anyway |
| Ungranted windows cannot be moved                      | implemented              | `refuses_an_application_nobody_granted`, and `refuses_a_copy_of_the_executable_outside_the_pinned_path` for the narrower case                                                                |
| Never act on a title match alone                       | implemented              | `identity.rs` — "THE GATE: refuses a window that only has the right title", plus the Electron-class and helper-window cases that cover the two ways a partial match looks convincing         |
| User overrides are respected                           | implemented              | `region.rs` — "THE GATE: lets a user override beat the named region", and its companion proving a stale override is still fitted to a display that exists                                    |
| DPI-aware named regions                                | implemented              | `scales_the_minimum_by_the_monitors_dpi`. Scale is applied to the minimum size only; work areas are already physical pixels                                                                  |
| Monitor removal and negative coordinates               | implemented              | `places_on_the_primary_and_says_so_when_the_second_display_is_gone`, `fits_a_rectangle_onto_a_monitor_at_negative_coordinates`                                                               |
| Placement routes through `AuthorityService`            | implemented              | `evaluate.test.ts` — "native window placement routes through the same authority", eight cases including the target-bound grant and the revocation                                            |
| Semantic requests, not model-provided coordinates      | implemented              | `window.test.ts` — "THE GATE: refuses a request that tries to carry coordinates". `RegionName` is a closed enum on both sides of the wire                                                    |
| `WINDOWPLACEMENT` preservation, `SetWindowPos`, launch | deliberately not started | the FFI layer. `WindowPlacementEvidenceSchema.previous` is the field it must fill                                                                                                            |
| Windows qualification matrix                           | not started              | needs the FFI layer. Fixtures are pinned to this machine's detected arrangement — 2560x1440 primary at the origin, 1920x1080 at `(2560, 252)` — by decision, rather than to guessed hardware |
| `NativeApplicationSurface`, node adapter, runbook      | not started              | next batch                                                                                                                                                                                   |

Two decisions worth recording:

- **Window placement is `local_reversible_edit`, not `external_write`.** It writes
  to no external system, and the previous `WINDOWPLACEMENT` is captured before the
  move. The consequence, which falls out of Section 9.1's existing scope clause
  rather than out of anything new: **an active Objective allows placement without
  a prompt**, and with no active Objective and no grant it asks. That is the
  behaviour focus mode wants, and it is now pinned by a test rather than left to be
  discovered.
- **A region is a pair of boundary fractions, not an offset and a width.**
  Computing `left_two_thirds` and `right_third` independently rounds 2560 to 1706
  and 853 and leaves a one-pixel stripe of desktop between the two windows.
  Sharing the boundary makes the seam arithmetically impossible, and
  `tiles_the_two_thirds_and_the_third_with_no_seam` fails if anyone changes it back.

| Command                    | Result                                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| `npm run format:check`     | exit 0                                                                 |
| `npm run lint`             | exit 0                                                                 |
| `npm run typecheck`        | exit 0                                                                 |
| `npm run test:unit`        | exit 0; 57 files, 1277 tests passed (1221 before this batch)           |
| `npm run test:integration` | exit 0                                                                 |
| `npm run test:migrations`  | exit 0                                                                 |
| `npm run test:e2e`         | exit 0; 4 tests across 3 suites, run here against Edge                 |
| `npm run test:boundary`    | exit 0                                                                 |
| `npm run test:desktop`     | exit 0                                                                 |
| `npm run rust:fmt:check`   | exit 0                                                                 |
| `npm run rust:clippy`      | exit 0; 0 warnings with `-D warnings`, across both crates              |
| `npm run rust:test`        | exit 0; 82 tests — 37 in the shell, unchanged, and 45 in the new crate |
| `npm run build`            | exit 0                                                                 |
| `npm run build:desktop`    | **blocked locally, see below**                                         |

**`npm run build:desktop` could not be run on this machine.** Smart App Control
refuses to execute freshly built release-profile Cargo build scripts: `An
Application Control policy has blocked this file. (os error 4551)`. Five
consecutive attempts were blocked. This is not the workspace move — building at
the previous target path fails identically, on `tauri-plugin-notification`, a
crate this batch does not touch — and debug-profile build scripts run fine, which
is why `cargo test --workspace` and `cargo clippy --workspace --all-targets` both
pass. Earlier batches did not hit it because their build scripts were already
built and already trusted; adding a dependency changes the fingerprint and forces
new ones. CI is the authority here, exactly as it is for the pinned Chromium in
the Phase 6 E2E note.

### 2026-09-07 Phase 9 (part 2) the Win32 layer, and what running it found

Adds `crates/noctis-windows/src/win32.rs` — display and window enumeration,
`WINDOWPLACEMENT` capture, `SetWindowPos` with verification, and restore — plus
`examples/qualify.rs`, the read-only instrument the qualification runbook uses.
Still nothing routed through authority, so no window moves in the product yet.

**The write path is proven against a real window.** `cargo test -p noctis-windows
-- --ignored` spawns Character Map, places it, and puts it back:

```
before:  x 15   y 65    491x437
applied: x 300  y 200   900x700   in 29ms
after:   x 15   y 65    491x437
```

Character Map is the subject because it is classic Win32, opens one window, and
does not hand off to a running instance the way the packaged applications do. The
test is `#[ignore]` by default: CI has no desk to qualify, and a suite that puts
a window in front of a developer is a suite people stop running.

Three things running the code found that reading the plan did not:

- **The process must be per-monitor DPI aware or every coordinate is a lie.**
  Windows _virtualizes_ `GetMonitorInfo` and `GetWindowRect` for a
  system-aware process, returning them scaled into the primary display's DPI
  space. Tauri's own manifest declares no awareness at all; `tao` calls
  `SetProcessDpiAwarenessContext` when it builds the event loop, with fallbacks
  through per-monitor v1 to system-aware. So `is_per_monitor_dpi_aware` checks
  rather than assumes, and the probe prints a warning when it is false — which it
  correctly does when run as a plain console application.
- **`SetWindowPos` positions the invisible resize border, not the visible frame.**
  Windows 10 and 11 put roughly seven pixels of invisible border outside the
  frame you can see. Placing two windows into regions that share a boundary
  therefore overlaps them by fourteen pixels and puts neither visible edge where
  the region said. `frame_inset` measures it from
  `DWMWA_EXTENDED_FRAME_BOUNDS` and `inflate` corrects for it. This is what makes
  the applied rectangle above land on 300,200 exactly rather than near it.
- **Identity does not answer "which window".** The probe found _two_ VS Code
  windows on the first machine it ran on — two workspaces open, both matching the
  target perfectly. `EnumWindows` promises no order, so taking the first match
  would make which editor gets moved depend on the order Windows returned them.
  `guard::select_window` therefore returns `Ambiguous` rather than guessing, and
  `Selection::narrow_by_title` narrows it with a hint from the Objective. That is
  not the title rule Section 11.2 forbids: authorization has already happened, and
  the hint only chooses among windows the grant list already admitted. The test
  `does_not_let_a_hint_reach_a_window_the_grant_list_refused` is the one that
  holds the distinction.

The probe's own output on the qualification machine, which is also the fixture the
region tests are written against:

```
displays
  \\.\DISPLAY1     work      0,0       2560x1440  scale 100%  primary
  \\.\DISPLAY2     work   2560,252     1920x1080  scale 100%

focus-mode layout, resolved (nothing is moved)
  vscode     \\.\DISPLAY1          0,0       1706x1440  []
  emulator   \\.\DISPLAY1       1706,0        854x1440  []
  noctis     \\.\DISPLAY2       2560,252     1920x1080  []
```

1706 + 854 is 2560 exactly: the seam-free tiling holds on the real display, not
only in the fixture. The probe also found the ChatGPT desktop application
reporting window class `Chrome_WidgetWin_1` — the same class as VS Code — and
correctly refusing to match, which is a live example of why the class corroborates
the executable rather than standing in for it.

| Command                                     | Result                                                  |
| ------------------------------------------- | ------------------------------------------------------- |
| `npm run format:check`                      | exit 0                                                  |
| `npm run lint`                              | exit 0                                                  |
| `npm run typecheck`                         | exit 0                                                  |
| `npm run test:unit`                         | exit 0; 1277 tests                                      |
| `npm run test:boundary`                     | exit 0                                                  |
| `npm run test:desktop`                      | exit 0                                                  |
| `npm run rust:fmt:check`                    | exit 0                                                  |
| `npm run rust:clippy`                       | exit 0; 0 warnings with `-D warnings`                   |
| `npm run rust:test`                         | exit 0; 106 tests — 37 in the shell, 69 in the crate    |
| `cargo test -p noctis-windows -- --ignored` | exit 0; 1 test, the real-window place and restore above |
| `npm run build:desktop`                     | still blocked by Smart App Control, see the part 1 note |

Carried forward, and the reason Phase 9's gate stays open: the Tauri command that
routes placement through `AuthorityService`, launch correlation for a process
Noctis starts, `NativeApplicationSurface`, the node native-window adapter, and the
qualification runbook document. `win32::apply` exists and has no authority-checked
caller, which is the correct order — the boundary is not something to add to a
capability that already works without it.

CI evidence for both parts:

| Run           | Commit    | Result                                                |
| ------------- | --------- | ----------------------------------------------------- |
| `34158162178` | `db3953e` | both jobs green, part 1                               |
| `34159032574` | `73fa2f4` | `rust` failed on `rust:fmt:check`; `javascript` green |
| `34159897052` | `4fcf09c` | both jobs green, parts 1 and 2 together               |

**`npm run build:desktop` passes in CI**, which settles the part 1 note above: the
Cargo workspace move and the root `target/` directory are sound, and the local
failure was Smart App Control refusing freshly built unsigned release build
scripts, nothing about the change. The local block stands as an environment
limitation on this machine, alongside the pinned Chromium.

`73fa2f4` failed for a reason worth writing down rather than quietly fixing. The
formatting was verified with `npm run format:check` after the last edit, which is
Prettier; rustfmt is `npm run rust:fmt:check`, a separate gate that had last run
before the ignored test was added. Two similarly named scripts covering different
languages is a trap the naming sets, and the habit that avoids it is running the
gates the CI job lists rather than the ones the change appears to touch.

### 2026-09-07 Phase 9 (part 3) placement routed through the consequence boundary

`win32::apply` now has an authority-checked caller. `window.place` reaches Win32
only through the AuthorityService, and the first real execution evidence Phase 8
deferred is now written by a real external action rather than by the workbench
recording `{ confirmedInWorkbench: true }`.

Three files in the shell, split the way the crate is:

- `window_authority.rs` — pure, and the security boundary. `authorises` decides
  whether one approval record permits placing one application's window.
- `windows_state.rs` — the grant list, per-application minimum sizes, the
  `PlaceIntent` the WebView sends, and what Noctis moved.
- `windows_commands.rs` — the three Tauri commands, thin, in the order the two
  above are asked in.

**The order is the design.** Every Section 11.2 rule is satisfied _before_ the
core is asked anything: a protected, ungranted, or ambiguous window never becomes
an authority request. The Approval Surface is therefore never shown a consequence
Noctis could not have carried out, which is the difference between a boundary and
a dialog box.

**Asking the core is not enough on its own.** The WebView chooses both which
approval id to present and which application to name, so the shell compares them:
`authorises` refuses an approval whose target is another application, another
target type, another capability, unconfirmed, denied, or already spent. Without
that comparison the core would answer "that approval is valid" and be telling the
truth about a different question. `refuses_an_approval_granted_for_a_different_application`
is the test that holds it.

Three decisions worth recording:

- **The move happens before the execution is recorded.** Phase 8's gate says a
  status may not claim completion until evidence verifies it, and the only
  evidence a window moved is the window having moved. The race this leaves — two
  authorised callers both moving — is harmless for this operation class,
  because the second writes the same rectangle. It would be the wrong order for a
  spend, and the comment in `window_place` says so.
- **Restore needs no approval of its own.** It can only reach a window already in
  the moved map, which means an approved placement put it there, and it can only
  put that window back. The approval that authorised the move declared
  `reversibility: "reversible"`, and reversing is what that word promised. A
  second consent for the undo would be consent theatre, and worse, it would make
  the undo the step most likely to be refused. Map membership is the
  authorisation, which is stronger than an optional check a caller can decline to
  pass — which is what the first draft had, and it was a bypass rather than a
  policy.
- **Placement refuses outright when the process is not per-monitor DPI aware.**
  Checked before Win32 and before the core. Approximate placement on a scaled
  display is worse than none, because it looks like a bug in Noctis rather than a
  missing declaration.

| Command                  | Result                                               |
| ------------------------ | ---------------------------------------------------- |
| `npm run test:boundary`  | exit 0                                               |
| `npm run format:check`   | exit 0                                               |
| `npm run lint`           | exit 0                                               |
| `npm run typecheck`      | exit 0                                               |
| `npm run test:unit`      | exit 0                                               |
| `npm run build`          | exit 0                                               |
| `npm run build:web`      | exit 0                                               |
| `npm run test:desktop`   | exit 0                                               |
| `npm run rust:fmt:check` | exit 0                                               |
| `npm run rust:clippy`    | exit 0; 0 warnings with `-D warnings`                |
| `npm run rust:test`      | exit 0; 131 tests — 62 in the shell, 69 in the crate |
| `npm run test:e2e`       | exit 0; 4 tests, run here against Edge               |
| `npm run build:desktop`  | not run here; Smart App Control, see part 1          |

Every gate the CI job lists was run this time, in the order the job lists them,
rather than the ones this change appeared to touch.

Still not done, and still the reason the gate is open: **no placement has been
performed through this path.** The commands compile, the boundary is tested, and
the Win32 layer is proven separately against a real window — but the three have
not yet run together, because that needs the shell and the core up at once with a
Surface to drive them from. `NativeApplicationSurface`, launch correlation for a
process Noctis starts (the map exists; nothing writes to it yet), the node
native-window adapter, and the qualification runbook document all remain.

### 2026-09-08 Phase 9 (part 4) the Surface, the bridge, and the runbook

Focus mode is now reachable. Activating an Objective surveys the native
applications Noctis may arrange and proposes a `native_application` Surface;
its actions reach the shell, which asks the core, and what the Surface then
shows is the outcome rather than the request.

Created: `packages/ui/src/surfaces/native.tsx`,
`apps/web/src/transport/NativeWindowBridge.ts`, the `native_application`
registry entry and renderer, `focusForObjective` in `Command.tsx`, and
`docs/operations/windows-qualification.md` — the last of Phase 9's named
deliverables.

Four things reading the existing code changed, each of which would have been a
bug:

- **A surface intent's identity is `(objectiveId, kind, sourceIds)`.** Two
  `native_application` intents with the same empty `sourceIds` are the same
  intent, so the loop that proposed one per application would have had the
  emulator's upsert silently overwrite the editor's, and focus mode would show
  one tool instead of two. The payload therefore carries _all_ the applications
  in one Surface, which is also the better reading: "the tools for this work" is
  one thing a person looks at.
- **`rename_all` renames serde variants, not struct-variant fields.** Without
  `rename_all_fields` the shell sends `monitor_id` while the contract expects
  `monitorId`, the payload fails its schema, and the Surface renders a fallback
  — no compile error, no runtime error, just a Surface that quietly stops
  working. `spells_every_field_the_way_the_surface_schema_reads_it` asserts the
  wire names and that the snake_case ones are absent.
- **`resolveSurface` was being called with no capabilities.** A `requires` entry
  would have made this Surface always fall back in the workbench. `requires` is
  now understood as a _client_ capability rather than an authority grant —
  authority is decided by the core on every placement regardless — so the
  workbench passes `window.place` exactly when a desktop shell is behind the
  page. In a browser it is not passed, and the fallback says so, which is why
  the E2E suite needed no shell to pretend at.
- **`window.discover` returning a raw window list was the wrong shape.** The
  grant list lives in the shell, so a page handed every window on the machine
  would need to know which executables count as the editor in order to say
  anything — and a grant list the page knows is one the page can disagree with.
  Replaced by `window_survey`, which reports per granted target.

The bridge parses every shell response through its contract schema, and that
caught a real omission immediately: the Rust `Placed` variant sends `previous`
and `requestId`, which the first draft of `NativeApplicationStateSchema` did not
declare. Both belong — `previous` is what makes "Put it back" name somewhere
real, and a placement that cannot state its own previous position is not
demonstrably reversible.

| Command                  | Result                                                |
| ------------------------ | ----------------------------------------------------- |
| `npm run test:boundary`  | exit 0                                                |
| `npm run format:check`   | exit 0                                                |
| `npm run lint`           | exit 0                                                |
| `npm run typecheck`      | exit 0                                                |
| `npm run test:unit`      | exit 0; 58 files, 1300 tests (1277 before this batch) |
| `npm run build`          | exit 0                                                |
| `npm run build:web`      | exit 0                                                |
| `npm run test:desktop`   | exit 0                                                |
| `npm run rust:fmt:check` | exit 0                                                |
| `npm run rust:clippy`    | exit 0; 0 warnings with `-D warnings`                 |
| `npm run rust:test`      | exit 0; 132 tests (131 before)                        |
| `npm run test:e2e`       | exit 0; 4 tests, run here against Edge                |
| `npm run build:desktop`  | not run here; Smart App Control, see part 1           |

`docs/operations/desktop.md` had gone stale: the shell binary moved to the
workspace `target/` in part 1 and the doc still named the old path.

**Phase 9's gate is still open, and the runbook says why.** Two task items are
unimplemented — a maximized window is not un-maximized before placement, and the
moved-window map is not persisted across a shell restart — and one _gate clause_
is unreachable: `region::resolve` honours a saved user override and has tests for
it, but nothing in the product writes one, because the shell passes no override.
So "user overrides are respected" is proven in the resolver and cannot be
exercised from the UI. Step 3 of the runbook also has not been run: driving a
GUI shell through a placement is a person's job, which is what the runbook is for.

### 2026-09-08 Phase 9 (part 5) the user always wins

The policy, stated by the owner and now implemented: if Noctis places a window
and a person later drags it, that position is theirs — on the next placement, and
after a restart.

**How the drag is noticed.** No hook and no polling. `geometry::moved_by_hand`
compares where the window is now against the position Noctis observed _after_
placing it, and `window_place` asks that question at the only moment the answer
changes anything — just before placing the same window again. A global window
hook to learn it sooner would be a permanent cost for a question asked
occasionally.

Comparing against the observed position rather than the requested one is what
makes the check trustworthy: an application settling on its own minimum width a
moment after being placed has not expressed a preference. `HAND_TOLERANCE` is
four pixels, wider than the placement tolerance, for the same reason — mistaking
an application's own adjustment for a person's would hand every window an
override nobody asked for, which is the failure that makes this feature
irritating rather than respectful.

**The override is written to disk**, in `window-overrides.json` beside the
shell's own window placement. "The user always wins until Noctis restarts" would
not be the user winning. `placement::{save,load}` became generic over serde
rather than gaining a second copy of the atomic write-and-rename.

**There is a way out.** `window_clear_override` forgets the position, and the
Surface offers **Use the intended region instead** — but only while an override
is actually being honoured, which it reads from the resolver's own
`honoured_user_override` note rather than tracking separately. Without this, one
drag would mean Noctis could never arrange that window again: a preference with no
undo is a trap. The action clears and re-places in one step, because clearing and
leaving the window where it is would look like a button that does nothing.

Clippy caught a real design smell rather than a lint: `window_place` had grown to
nine parameters. The three managed maps — moved windows, overrides, launch
correlations — all answer the same question, so they became one `NativeWindows`
state. Three managed states became one and the command lost two arguments.

| Command                  | Result                                      |
| ------------------------ | ------------------------------------------- |
| `npm run test:boundary`  | exit 0                                      |
| `npm run format:check`   | exit 0                                      |
| `npm run lint`           | exit 0                                      |
| `npm run typecheck`      | exit 0                                      |
| `npm run test:unit`      | exit 0; 58 files, 1301 tests                |
| `npm run build:web`      | exit 0                                      |
| `npm run test:desktop`   | exit 0                                      |
| `npm run rust:fmt:check` | exit 0                                      |
| `npm run rust:clippy`    | exit 0; 0 warnings with `-D warnings`       |
| `npm run rust:test`      | exit 0; 138 tests (132 before)              |
| `npm run test:e2e`       | exit 0; 4 tests, run here against Edge      |
| `npm run build:desktop`  | not run here; Smart App Control, see part 1 |

**Every clause of Phase 9's gate is now implemented.** System, security and
ungranted windows cannot be moved; user overrides are respected, persisted, and
reversible. What remains is running the qualification matrix, which is a person's
job at a desk — the runbook has the procedure, and it names the two task items
still open (a maximized window is not un-maximized before placement, and the
moved-window map is not persisted across a restart, so "put it back" does not
survive one). Neither is a gate clause.

### 2026-09-08 Phase 9 (part 6) the first qualification pass, and the four things it found

Focus mode was run end to end on the qualification machine for the first time:
core and shell up together, an Objective activated, and windows actually
arranged. Every one of the four defects below was found by a person clicking a
button, and none of them was reachable by any test that existed — which is the
argument for the runbook rather than a note about it.

**1. The shell never told the core which Objective a placement belonged to.**

`request_body` sent no `objectiveId`, and the core derives `objectiveIsActive`
by looking the Objective up (`objective?.status === "active"`). With no id it
resolves to false, so every placement fell to `require_confirmation`.

This is the sharper lesson of the pass. `evaluate.test.ts` contains a passing
test named "places without asking while an objective is active", written in part
2 and described there as the behaviour focus mode needs — and the product could
not reach that branch. A unit test on a pure function proves the function; it
says nothing about whether any caller passes real arguments.
`names_the_objective_so_the_core_can_see_it_is_active` now covers the request
body, which is where the gap was.

**2. `Option::None` serializes as `null`, and `.optional()` does not accept it.**

The first `needsApproval` the real shell produced put a raw zod error on screen:
`{ "expected": "string", "path": [ "confirmationPhrase" ] }`. The bridge test
that should have caught it omitted the field instead of sending null, so it
passed. `confirmationPhrase` is `.nullish()` now, and the suite sends null.

**3. Noctis covered the window it had just arranged.**

Reported precisely: with Noctis on the secondary display the arrangement was
right; with Noctis maximized on the primary it placed the editor into the left
two thirds of that same display and then sat on top of it. This is Section 11.2's
"compose Noctis with native windows without covering critical controls", which
part 2 recorded as not started.

`compose::make_room` decides where Noctis goes, and the rule is _move only when
actually covering_ — not "always relocate to the secondary". Somebody who has put
Noctis where they want it should not have it dragged around by a placement it was
never in the way of, which is the same courtesy the user override gets. Two
details in the Win32 half would each have been silent: `unmaximize` has to come
_before_ `set_position`, because a maximized window ignores a position; and the
comparison uses the _outer_ size, where the saved placement stores the inner one,
so using the saved shape would under-measure Noctis by its own frame.

A single display has nowhere to put Noctis that is not on top of the work, so
`make_room` returns "stay put" there rather than shuffling it somewhere equally
covered. There is a test pinning that.

**4. A Surface payload describing the outside world goes stale, and could not
look again.**

After a shell restart the Surface said `not running` for an editor that was
plainly open. Nothing was broken: `focusForObjective` only ran inside
`changeStatus(…, "active")`, and a shell restarted against an already-active
Objective activates nothing, so nothing ever looked. The canvas faithfully
rendered a snapshot from before.

Surface payloads persist by design — that is how a Surface survives a restart —
which is exactly why one holding observations of the world cannot be trusted
after one. The registry has had the concept since Phase 8: `sourceRefresh`,
"check the source now". A native window is a source like any other, and that had
simply not been noticed. Command now surveys once per active Objective including
on a fresh load, and the Surface offers **Look again** where staleness bites.

Two fixes outside Phase 9's scope came out of the same session:

- **`openDatabase` did not create its parent directory.** A first run pointing
  `NOCTIS_DATABASE_PATH` at a directory that does not exist yet is the ordinary
  case, and SQLite answers `unable to open database file` with an errcode —
  which reads like a permissions problem or a corrupt file rather than a missing
  folder, and sent the qualification run looking in the wrong place. Fixed in
  `openDatabase` because an ESLint rule makes it the only module allowed to
  construct the driver, so every path into SQLite passes the one guard.
- **`docs/operations/desktop.md` named the old shell binary path**, which moved
  to the workspace `target/` in part 1.

| Runbook step                                  | Result                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| Step 1, read-only probe                       | **pass**; work areas match the display settings, and 1706 + 854 = 2560 exactly |
| Step 2, write path on Character Map           | **pass**; applied 300,200 to the pixel, restored 15,65 exactly                 |
| Step 3, Surface renders with both rows        | **pass**                                                                       |
| Step 3, emulator not installed                | **pass**; `not running` with the open-only handoff                             |
| Step 3, more than one editor open             | **pass**; refused to guess, candidates listed and clickable                    |
| Step 3, arrange by choosing a candidate       | **pass**; editor to the left two thirds, no prompt, other window untouched     |
| Step 3, Noctis composed out of the way        | **pass**, after fix 3                                                          |
| Step 3, Noctis left alone when not in the way | **pass**                                                                       |
| Step 3, put it back                           | not run                                                                        |
| Step 3, drag by hand then arrange again       | not run                                                                        |
| Step 3, the same after a shell restart        | not run                                                                        |
| Step 3, use the intended region instead       | not run                                                                        |
| Step 3, unplug the second display             | not run                                                                        |
| Step 3, maximize the editor first             | not run; expected to fail, task item still open                                |
| Step 4, a scaled display                      | not run                                                                        |

| Command                    | Result                                      |
| -------------------------- | ------------------------------------------- |
| `npm run test:boundary`    | exit 0                                      |
| `npm run format:check`     | exit 0                                      |
| `npm run lint`             | exit 0                                      |
| `npm run typecheck`        | exit 0                                      |
| `npm run test:unit`        | exit 0; 58 files, 1307 tests (1301 before)  |
| `npm run test:migrations`  | exit 0                                      |
| `npm run test:integration` | exit 0                                      |
| `npm run test:desktop`     | exit 0                                      |
| `npm run rust:fmt:check`   | exit 0                                      |
| `npm run rust:clippy`      | exit 0; 0 warnings with `-D warnings`       |
| `npm run rust:test`        | exit 0; 147 tests (138 before)              |
| `npm run test:e2e`         | exit 0; 4 tests, run here against Edge      |
| `npm run build:desktop`    | not run here; Smart App Control, see part 1 |

A note on running the Rust suite locally: Smart App Control began refusing the
freshly built `noctis-desktop` test binary outright, and repeated attempts did
not clear it. Building into a different `CARGO_TARGET_DIR` does clear it, which
confirms the block is per binary path rather than per crate. CI is unaffected and
remains the authority.

**Phase 9's gate is not closed.** Seven runbook rows pass and eight have not been
run, including every row covering the user override — the clause the gate names.
Those need a person at the desk; the procedure is in
`docs/operations/windows-qualification.md`.

### 2026-09-10 Phase 9 (part 7) the second qualification pass

Three more defects, all found by clicking, and **all three were mine from
earlier in the same session** rather than gaps carried forward. Worth recording
in that shape, because the pattern is more useful than the fixes.

**1. The place action did not exist in the `placed` state.**

The Surface offered **Arrange this window** only for `discovered`, `restored`
and `refused`. Once a window was arranged the only action was **Put it back** —
and "arrange again after dragging it yourself" is the _sole_ gesture that
expresses a user override, so the gate clause could not be reached from the
interface at all.

Third defect of that exact shape in two sessions, after the missing
`objectiveId` and the unwired `onChooseWindow`: a mechanism built, tested in
isolation, and left with no path a person could take to it. The fix is a total
table — `PLACE_LABEL` has an entry for every one of the seven states, and
`native.test.ts` asserts its key set equals the state union. A chain of
`state.kind === "x" && …` conditions can silently cover no case; a total table
cannot, which is the same reason `CAPABILITY_OPERATION_CLASS` is a table.

**2. The un-maximize fix from part 6 broke the frame-inset measurement.**

Reported as "if I have vscode maximised on monitor 1 and I arrange it, it gets
larger and overflows". `GetWindowRect` was read _while maximized_, the window was
then un-maximized, and `DWMWA_EXTENDED_FRAME_BOUNDS` was read _restored_. The
difference between those two is not a border — it is hundreds of pixels — and
`inflate` grew the target by it. The persisted evidence was unambiguous:
`{"x":-8,"y":-147,"width":3014,"height":1789}` on a 2560×1440 display.

Fixed by re-reading the rectangle after un-maximizing, and then by making the
class of mistake harmless: `frame_inset` returns nothing when any edge is
negative or wider than 64 pixels, because an implausible inset is two
measurements of different things. Correcting by nothing is always safe;
correcting by a wrong number never is.

**3. Maximizing was recorded as a position preference.**

The second symptom of the same session, and it followed from the first: the
overflowed rectangle differed from where Noctis thought it had put the window,
so `moved_by_hand` recorded it as a standing preference, and every subsequent
placement faithfully honoured "fill the whole display". Reported as "no matter
how I press the buttons it never goes to the 2/3rds format".

Underneath it was a rule written backwards in part 5. The comment said "a change
in maximized state counts, because maximizing is unmistakably somebody's
decision" — true, and the wrong conclusion. Maximizing is a decision about
_state_; a maximized window's rectangle is the display's, not a place anybody
chose. `moved_by_hand` now takes no preference from a maximized window, while
un-maximizing to somewhere specific still counts. Somebody who maximizes a
window and then asks Noctis to arrange it is asking for the region; somebody who
wants it maximized does not ask.

The poisoned `window-overrides.json` and `window-moved.json` were backed up and
deleted, because no code change clears a preference already written to disk.

**Qualification result: passed, with reservations recorded rather than waived.**

| Runbook row                                  | Result                                                  |
| -------------------------------------------- | ------------------------------------------------------- |
| Step 1, read-only probe                      | pass                                                    |
| Step 2, write path on Character Map          | pass                                                    |
| Surface renders with both rows               | pass                                                    |
| Emulator not installed, open-only handoff    | pass                                                    |
| More than one editor, refuses to guess       | pass                                                    |
| Arrange by choosing a candidate              | pass                                                    |
| Arrange, no prompt under an active Objective | pass                                                    |
| Put it back                                  | pass                                                    |
| Put back, move, arrange, put back            | pass; "back" is where it was before _that_ arrange      |
| Noctis composed out of the way               | pass                                                    |
| Noctis left alone when not in the way        | pass                                                    |
| Maximize the editor first, then arrange      | **passed on the owner's judgement** after the two fixes |
| Drag by hand, then arrange again             | **not cleanly verified** — see below                    |
| The same after a shell restart               | not run                                                 |
| Use the intended region instead              | not run                                                 |
| Unplug the second display                    | not run                                                 |
| Step 4, a scaled display                     | does not apply; intended configuration is 100%          |

The override rows are recorded as unverified rather than passing, and the
distinction matters. The override _was_ seen being honoured, with the Surface
saying "you had placed this window yourself, so that was kept" — but the
preference it was honouring had come from the maximize bug, not from a hand
drag. A mechanism observed working on the wrong input has not been tested. The
sequence that would settle it is three clicks and is the first row of Step 3's
remaining work.

| Command                  | Result                                      |
| ------------------------ | ------------------------------------------- |
| `npm run test:boundary`  | exit 0                                      |
| `npm run format:check`   | exit 0                                      |
| `npm run lint`           | exit 0                                      |
| `npm run typecheck`      | exit 0                                      |
| `npm run test:unit`      | exit 0; 59 files, 1313 tests (1307 before)  |
| `npm run test:desktop`   | exit 0                                      |
| `npm run rust:fmt:check` | exit 0                                      |
| `npm run rust:clippy`    | exit 0; 0 warnings with `-D warnings`       |
| `npm run rust:test`      | exit 0; 153 tests (148 before)              |
| `npm run build:desktop`  | not run here; Smart App Control, see part 1 |

**Phase 9 is closed on the owner's judgement**, with two things written down
rather than glossed.

Every gate clause is implemented and the qualification passed at the desk. One
_task_ item is not fully built: "identity-safe discovery and process **launch
correlation**". Discovery is done and correlation is plumbed end to end —
`select_window` prefers a correlated window, the map is managed state — but
nothing writes to it, because nothing launches a process. So the phase outcome's
"Noctis **opens** or discovers VS Code" is half met: it discovers, and it has
never opened anything. Earlier entries in this batch claimed every task item was
implemented, which was wrong.

Nothing depends on it today: discovery plus the title hint resolves the editor,
and launching a process is a new external consequence that belongs with the tool
routing in Phase 10 rather than bolted on here.

On the scope of the gate, since this entry previously overstated it: the gate is
worded "the intended PC/display configurations", and the intended configuration —
chosen deliberately at the start of the phase, not defaulted into — is 100% on
both displays. Repeatedly listing a 150% display as the largest untested surface
was wrong. It is not an untested surface; it is a configuration this desk does
not have and is not going to. Step 4 of the runbook stays written down for
whoever changes a display later, and does not apply now.

Four rows remain genuinely unrun, all of the user override: drag-then-arrange,
the same after a restart, **Use the intended region instead**, and unplugging the
second display. The mechanism was observed being honoured, but on a preference
that came from the maximize defect rather than a hand drag, so it is recorded as
unverified rather than passing. Three clicks would settle it. The gate is closed
on the owner's judgement with that written down rather than waived.

### 2026-09-10 Phase 10 (part 1) the router, four routes, and tools as data

**Phase 10's gate is open.** Nothing in this batch has been run at a desk: no
process has been launched, no browser opened, and the qualification runbook has
not been walked. What exists is the decision layer, the boundary, the executors
for three of the four routes, and a Surface that can reach them.

**Tools are data, not adapters.** The starting question was which of Suno,
Vinted, VS Code and GitHub to build adapters for. The owner's answer changed the
shape: those names are how you test that routing works, not what routing is. So
Phase 10 builds one router and four generic routes, and a tool is a row —
`ToolDescriptor` in `tools.json`, overlaying a built-in set. Phase 11 should add
rows. If it has to add code, this batch failed.

Re-reading the plan afterwards, that split was already written: Phase 10's tasks
name four **routes** and Phase 11's name three **adapters**. The tools were never
supposed to appear here.

Created: `packages/contracts/src/tool.ts`, `packages/domain/src/tools/route.ts`,
`apps/desktop/src-tauri/src/{tool_registry,tool_authority,tools_commands}.rs`,
`packages/ui/src/surfaces/external_tool.tsx`,
`apps/web/src/transport/ExternalToolBridge.ts`, the `external_tool` registry
entry and renderer, `toolsForObjective` in `Command.tsx`, and
`docs/operations/tools-qualification.md`.

#### What routes, and what does not

| Route              | Capability                  | This batch                         |
| ------------------ | --------------------------- | ---------------------------------- |
| `official_cli`     | `tool.run_command`          | built — resolve, launch, or run    |
| `isolated_browser` | `browser.automate_isolated` | routed to, reports why, not built  |
| `visible_handoff`  | `browser.open_visible`      | built — opens the person's browser |
| `manual`           | `tool.inspect`              | built — the terminal fallback      |

`ROUTE_NAMES` is ordered strongest-first and `chooseRoute` walks it, taking the
first route the tool declares, the machine can reach, and a capability covers.
`manual` is last, needs no declaration, and cannot be unavailable — so the walk
always terminates on an answer. "Failure degrades safely" is a property of the
list rather than a branch somebody remembered to write, which is the distinction
that cost Phase 9 three defects.

Availability is consulted **before** authority, so a grant is never spent on a
route that cannot run.

#### Four decisions worth recording

- **Existing-profile control and isolated automation differ by operation class,
  not by a flag.** Section 12.3 wants them separately granted;
  `browser.control_profile` is `external_write` and `browser.automate_isolated`
  is `local_reversible_edit`, so an active Objective silently clears the second
  and never the first, and `covers` compares class as well as name so neither
  grant can cover the other. A flag would have needed a bespoke branch. The test
  that matters runs it through the real evaluator rather than reading the table.
- **A grant binds to a tool, not to a browser profile.** The tempting target for
  profile control is `{ type: "browser_profile", id: "default" }`, which is a
  grant over somebody's whole signed-in life. `{ type: "tool", id: "vinted" }`
  reads "drive my signed-in browser **on Vinted**", and the descriptor's origin
  allowlist is what makes that narrow reading true rather than nominal —
  `origin_allows` compares a parsed origin, so `www.vinted.co.uk.evil.example`
  and `evil.example/?https://www.vinted.co.uk` both fail where a `starts_with`
  would have accepted both.
- **Registering a descriptor is `credential_security`.** Writing one names an
  executable and an origin allowlist, so it widens what Noctis may reach.
  Choosing that class means `PERMISSION_INELIGIBLE` already puts it beyond every
  standing permission and beyond a model, with no new policy code.
- **A verb raises the operation class and can never lower it.** The capability is
  a floor, derived in the shell from its own descriptor rather than sent by the
  page. Reaching an external tool with a command is an external act even when the
  command reads, so `tool.run_command` floors at `external_write` and a verb that
  publishes raises it. Preparation stays cheap; the commit boundary does not.

#### The correlation Phase 9 left plumbed and empty

`tool_launch` writes `NativeWindows.correlations`, which nothing had ever
written. Two things had to change for that to mean anything: the map now carries
the process id beside the correlation id, and `stamp_launches` marks the windows
of processes Noctis started — because `win32::top_level_windows` always reports
`launch_correlation_id: None`, and until now nobody filled it in. So the
`select_window` preference for a correlated window, and the `evaluate` comparison
behind it, were both unreachable for the whole of Phase 9.

ponytail: a direct process-id match, no walk of the process tree. An application
whose launcher exits and hands off to a running instance simply does not
correlate and falls back to executable and class, which already works.

#### The defect the boundary parse caught, again

Phase 9's lesson was to parse every cross-process response through its contract
schema. It earned its keep immediately: `z.record` with an enum key is
**exhaustive** in zod — it demands an entry for all four routes — while
`tool_survey` reports availability only for the routes a tool declares. Every
real response would have been rejected inside `survey()`, the catch in
`toolsForObjective` would have swallowed it, and the Surface would simply never
have appeared. No test would have failed; it is a runtime-only mismatch between
two languages. `z.partialRecord` is the fix, and an unknown route name still
fails loudly.

The reason the test caught it is that the fixture is a real shell response — one
declared route — rather than a convenient one with all four filled in. Phase 9's
`.optional()`/`null` defect got through precisely because its test omitted the
field instead of sending `null`.

One smaller thing a test caught rather than a person: the unavailability reason
named the executable (`Code.exe is not installed here`) and that string reaches a
persisted Surface payload. It names the tool now, which is both narrower and
what somebody reading it actually wants.

#### Not built, deliberately

- **The isolated Playwright executor**, and therefore the gate clause "isolated
  sessions cannot access personal cookies" is satisfied by construction rather
  than demonstrated: no isolated session exists to inspect. The route is declared,
  routed to, and reports that it has no executor.
- **`browser.control_profile` has no command.** It is a capability name and an
  operation class and nothing else, which pins the decision so a later batch
  cannot quietly reclassify it.
- **`tool.register_descriptor` has no command either**, and this one was a
  deliberate reversal. Noctis proposing a descriptor is what would make "handles
  any use case" true rather than "handles any use case you configured" — but
  building the command without a Surface to reach it from would be exactly the
  shape that cost Phase 9 three defects: a mechanism built, tested in isolation,
  with no path a person could take to it. The capability and its class are
  recorded; the command belongs with the UI that reaches it.
- **MeshCentral-style screen access.** Phase 10 says a separate future flag and a
  security review, and not v1-critical. Nothing was added, not even a flag.

Adding a tool today means editing `tools.json`, which the shell reads on every
command so an edit takes effect without a restart. The runbook's Step 4 walks
that, because "a tool is a row" is a claim worth testing rather than asserting.

| Command                    | Result                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| `npm run test:boundary`    | exit 0                                                             |
| `npm run format:check`     | exit 0                                                             |
| `npm run lint`             | exit 0                                                             |
| `npm run typecheck`        | exit 0                                                             |
| `npm run test:unit`        | exit 0; 63 files, 1367 tests (1313 before)                         |
| `npm run test:integration` | exit 0; 150 tests                                                  |
| `npm run test:migrations`  | exit 0; 30 tests                                                   |
| `npm run build`            | exit 0                                                             |
| `npm run test:e2e`         | exit 0; 4 tests, run here against Edge                             |
| `npm run build:web`        | exit 0                                                             |
| `npm run test:desktop`     | exit 0                                                             |
| `npm run rust:fmt:check`   | exit 0                                                             |
| `npm run rust:clippy`      | exit 0; 0 warnings with `-D warnings`                              |
| `npm run rust:test`        | exit 0; 206 tests — 118 in the shell, 88 in the crate (153 before) |
| `npm run build:desktop`    | not run here; Smart App Control, see the Phase 9 part 1 note       |

Every gate the CI job lists was run, in the order the job lists them.

**What Phase 10 still needs**: the qualification runbook walked at a desk, which
is what would turn "three routes are implemented" into "three routes work". Four
rows of the Windows runbook's Step 3 remain unverified from Phase 9 and are
folded into the same session, because the shell has to be running for Step 2 here
anyway.

**And one thing that is a mechanism nothing can reach**, found by tracing the
`needsApproval` branch after this batch was already written, rather than by a
test. It is not new to Phase 10 — it is Phase 8 residue that Phase 9 shipped over
and this batch inherited — but it is a Phase 10 gate row, so it is recorded here
and not carried quietly:

**No human confirmation can be given anywhere in the product.** `ApprovalSurface`
exists, the `approval` registry entry exists, and `SurfaceContext` declares
`onConfirm`, `onExecute` and `onReviewApproval` — and nothing proposes an
`approval` surface intent, and `Command.tsx` supplies none of those three
handoffs. So `authority.confirm` has no caller from the page, and neither
`window_place` nor `tool_execute` is ever passed an `approval_id`, though both
accept one.

The consequence, stated plainly: under an active Objective every route this batch
built is `allow` and works. With no active Objective, a handoff returns
`needsApproval`, the Surface renders the consequence summary, and there is no
button in Noctis that can agree to it. That makes three runbook rows unrunnable
as written — "with no active Objective, the handoff asks first", "the approval
names the tool and says whose browser it will use", and "declining it opens
nothing" — and it means the gate clause "visible session use requires explicit
grant" can only be demonstrated for the active-Objective scope, not for the
asking case.

Phase 9 did not notice because placement under an active Objective never needs a
confirmation, which is exactly why this is the same lesson a fourth time: a
mechanism proven in isolation, with no path a person could take to it. The
difference is that this one was found by walking the branch rather than after a
qualification pass. Wiring it is the next batch, and it is Phase 8's shape rather
than Phase 10's — an approval intent proposed when a decision is pending, the
three handoffs supplied, and `approvalId` carried back into the retry.

### 2026-09-10 Phase 10 (part 3) somewhere to say yes

The confirmation path the previous entry recorded as unreachable now exists, and
finding it cost two more defects of the same shape — one of them mine from part
2, and one that had been sitting in `ApprovalSurface` since Phase 8.

**The gap, restated.** `authority.confirm` had no caller from the page. Nothing
proposed an `approval` surface intent, `Command.tsx` supplied none of
`onConfirm`, `onExecute` or `onReviewApproval`, and neither `window_place` nor
`tool_execute` was ever passed the `approval_id` both accept. Under an active
Objective every route is allowed outright, which is why three phases shipped over
it.

Four things were needed, and only the first is the obvious one:

- **`showApproval` proposes the decision as a Surface.** The whole approval
  record is fetched rather than assembled from the shell's four-field
  `needsApproval`, because the Surface renders the operation class, the target,
  the reversibility and the reason codes — a boundary screen built from a summary
  is a boundary screen that cannot show what is being agreed to. Role
  `attention`, priority 90: a consequence boundary that composed into overflow
  would be a boundary nobody was asked at.
- **Confirming carries out the act.** `authority.confirm` records that a person
  agreed; it cannot open a browser or move a window, because only the shell can.
  So the act is retried with the approval in hand and the shell re-checks that
  the approval covers it. The approval Surface is re-proposed _after_ the retry,
  so its payload carries the real `executedAt` — proposing it first would persist
  a Surface saying "confirmed, not executed" about something that had already
  happened, which is the Phase 9 stale-payload failure in the one place where a
  stale claim is a claim about somebody's consent.
- **The retry is derived, not remembered.** `RETRY_AFTER_CONFIRM` is a total
  table over both capability lists — `satisfies Record<WindowCapability |
ToolCapability, …>`, so a capability added to either without a decision here
  does not compile. A closure remembered when the request was made would have
  been shorter and wrong: a decision sits unanswered for as long as somebody
  takes to read it, and a reload in that window is the ordinary case. The route
  and verb come from the persisted Surface payload, the same place the button
  that started it read them from. A capability the page does not know retries
  nothing rather than guessing.
- **`authority.approve` is passed unconditionally.** The `approval` registry
  entry requires it and nobody ever passed it, so every proposed decision would
  have rendered as a fallback. Agreeing to a consequence needs no desktop shell,
  so it is not gated on one — unlike `window.place` and `tool.inspect`, which are.

`onExecute` is deliberately still not supplied. For these capabilities the shell
performs the act and records the execution itself, so a page-side execute button
would write evidence for something that may not have happened. The retry _is_ the
execution.

#### Two more defects of the one shape, and the one that generates them

**1. Phase 10 part 2's own handoffs never reached the renderer.**
`onActOnTool` and `onSurveyTools` were passed by `Command.tsx`, declared in
`SurfaceContext`, consumed by the renderer — and `Workbench` never forwarded
them, because it forwarded handoffs one prop at a time. A JSX spread of props a
component does not declare is not a type error, so it typechecked clean, and the
`external_tool` Surface rendered with no buttons at all. The claim in part 2 that
the Surface was reachable was wrong.

So the fix is not a seventh forwarding line. `Workbench` now takes one
`handoffs?: SurfaceContext` prop and passes it straight through, which deletes
the layer where a handoff could go missing: adding one needs no change to
`Workbench` at all. That is five instances of one defect shape in this codebase,
and the first four were each fixed individually.

**2. `ApprovalSurface` rendered its Confirm button with no handler.** Found by
the second half of the new test rather than by a person. `onExecute` had always
been guarded; `onConfirm` had not, so a context without it produced a button that
reads as consent and does nothing. It says so in words now instead, which is the
rule the rest of the Surfaces already follow.

#### The check that would have caught all five

`apps/web/src/workbench/handoffs.test.ts` renders each Surface that has an action
twice — once with its handoff, once without — and asserts the control appears
only in the first. The second half is what makes the first mean "because of the
handoff" rather than "always", and it is the half that found defect 2.

It renders through `renderToStaticMarkup` and `createElement` in a plain
`.test.ts`, because the vitest `include` is `*.test.ts` and `react-dom` was
already a dependency: no config change, no test-library added.

This is the class of bug a type-checker cannot see. A declared, optional,
never-passed handoff renders a Surface with no button, and a Surface with no
button is indistinguishable from one that is working.

| Command                    | Result                                                       |
| -------------------------- | ------------------------------------------------------------ |
| `npm run test:boundary`    | exit 0                                                       |
| `npm run format:check`     | exit 0                                                       |
| `npm run lint`             | exit 0                                                       |
| `npm run typecheck`        | exit 0                                                       |
| `npm run test:unit`        | exit 0; 64 files, 1374 tests (1367 before)                   |
| `npm run test:integration` | exit 0; 150 tests                                            |
| `npm run test:migrations`  | exit 0; 30 tests                                             |
| `npm run build`            | exit 0                                                       |
| `npm run test:e2e`         | exit 0; 4 tests, run here against Edge                       |
| `npm run build:web`        | exit 0                                                       |
| `npm run test:desktop`     | exit 0                                                       |
| `npm run rust:fmt:check`   | exit 0                                                       |
| `npm run rust:clippy`      | exit 0; 0 warnings with `-D warnings`                        |
| `npm run rust:test`        | exit 0; 206 tests, unchanged by this batch                   |
| `npm run build:desktop`    | not run here; Smart App Control, see the Phase 9 part 1 note |

**Phase 10's gate is still open**, and for the same reason as part 2: nothing has
been run at a desk. What changed is that six runbook rows which could not have
passed as written are now runnable — the whole of Step 3's asking case, plus
confirming after a page reload. The runbook has them.

### 2026-09-13 Intelligence Slice 1 — a prompt becomes a turn on the model you chose

Eleven tasks of the master plan
(`docs/superpowers/plans/2026-09-12-noctis-intelligence-master-plan.md`, revision 2) landed as
twelve commits, one per green task. For the first time a sentence typed into Noctis reaches a model:
`conversation.send` → `runtime.turn` job pinned to a node → Codex App Server or Claude Code spawned
on that machine inside granted roots → items, token deltas and asks streamed back over the existing
node socket → asks answered through the authority boundary → the reply and every item in the
thread's history.

**What is proven with fixtures (the fake runtime, a real core, a real node agent):**

- Contracts: `runtime.turn` is `read_inspect`; `ModelRef`, probes with models, roots with `mode`
  and `localOnly`, items (`agent_message`, `command`, `file_change`, `tool_call`, `proposal`,
  `sub_agent`), deltas, ask/answer, evidence; `stream`/`delta`/`ask` node frames, `answer` server
  frame, `runtime_delta` client frame; six events; four commands (`conversation.send`,
  `conversation.cancel`, `authority.decline`, `identity.set_default_model`).
- Migration 0006: message bodies, sessions per thread × provider × node, turns with the model
  chosen, `provider_decisions`, approvals linked to the job and the ask, job pinning, one free-chat
  thread per identity plus one per Objective (partial unique indexes), `nodes.providers_json`.
- Domain: `chooseProvider` (requested model, eligible auth mode, roots, local-only, session
  affinity, stable order) and `classifyAsk` (a pattern table; `// ponytail:` names the ceiling).
- Nodes: pinning, `pinned_node_unavailable`, lease renewal on every frame, per-capability frame
  budgets, leased → running on the first stream frame, `runtime.turn` never blind-retried,
  `RuntimeFrameHub` fan-out, `sendAnswer`, providers persisted on hello.
- Authority: `authority.decline`; a declined approval can be neither confirmed nor executed; the ask
  id is the request's idempotency key so a re-ask gets the recorded answer.
- Core: the conversation service — model resolution (override, then identity default, else
  `unavailable`), thread per Objective, candidate routing, an honest `failed` turn when no node
  offers the model, items → events and messages, proposals → `surface.upsert_intent` /
  `objective.create(status: suggested)` with `actorType: "identity"`, asks → approvals → answers,
  turn completion from the job result with the session stored, deltas → `LiveBroker` →
  `/ws/clients` and never the ledger. `GET /models`, `/threads`, `/threads/:id/{messages,turns}`.
- Node agent: `Runtime` interface, roots resolved through junctions, billing keys stripped from
  every child, probes that report a mode string and never a token, the donor's `codex.exe`
  resolver ported (ledger row first), a scripted fake runtime, concurrent turns, a heartbeat while
  an ask waits, the Codex App Server JSON-RPC client, the Claude Agent SDK client, and the
  proposal channel (a stdio MCP server for Codex, in-process SDK tools for Claude).
- Web: `useConversation`, the Chat page, the prompt form with a model selector in Presence and
  Chat, per-identity default models in Settings, Decline on the approval Surface, `onFrame` on the
  transports so the desktop shell's deltas reach the page; `chat.test.mjs` drives the fake runtime
  end to end.

**Three things the live machine taught before any turn ran.** codex-cli auto-updated to
0.154.0-alpha.6.2 during the work: `-c approval_policy="untrusted"` is refused on the command line
and must travel per request; the owner's Codex plugins and MCP servers start inside every spawned
thread unless disabled one by one (`codex.ts` does this — the Isolation constraint made concrete);
and the SDK bundles its own `claude` binary, so the Claude route needs nothing on PATH. Under an
inactive Objective the Codex sandbox is `readOnly` so every write asks; active → `workspaceWrite`
on the granted roots. `additionalDirectories` in the Claude SDK does not distinguish read from write,
so writes into a read-only root are caught by `canUseTool` + `classifyAsk`.

**What is deliberately not claimed.** No live turn has been run yet, on either provider, on either
PC. The procedure the owner runs is `docs/operations/runtime-live-evidence.md`; its evidence log is
empty. The core is still on the home PC; `docs/operations/work-pc-core.md` is the runbook for
moving it, and pairing the home PC as a worker is Task 1.12's manual steps. The browser transport
has no token deltas (Slice 2). Jester is unavailable by design (Slice 4).

**Gates.** Each task's subagent ran the targeted tests red-then-green and `npm run typecheck`; the
full gate set was last run green by the coordinator after Task 1.6 (73 unit files / 1499 tests, 6
integration files / 170 tests, build). The owner runs the complete set — including `npm run lint`,
`npm run format:check`, `npm run test:e2e` — before the live procedure; step 0 of the evidence
document lists them.

ADRs 0020–0027 are recorded. Revision 1's step text for Tasks 1.4–1.9 had been overwritten by
revision 2; those tasks were implemented from Part B's file table and the interfaces in Part C.

#### 2026-09-15 The first full gate sweep, and the two things it found

Every gate was run together for the first time since Task 1.6, because the last
four tasks were verified only against their own targeted tests. Eight of ten
passed untouched: 1555 unit tests across 79 files, 170 integration tests, 30
migration tests, both builds, the donor boundary, and formatting.

Two failed, and both were in the verification I had trimmed.

**`lint`: three errors.** Two mattered. The Codex item mapper called `String()`
on `item.tool`, which Codex's own shapes type loosely — so a `tool_call` item
whose tool name arrived as an object would have been recorded, persisted and
rendered in Chat as the literal text `[object Object]`. It now accepts a string
or nothing, because a tool name that is not a string is not a tool name. The
third was a test asserting on an unbound method reference.

**`test:e2e`: the gate test, and it was right to fail.** The fake runtime's
`ASK:` branch exists to prove that a consequential action parks and waits for a
person. It asked about `echo hi`. `echo` is a read-only head, so `classifyAsk`
returned `read_inspect`, the evaluator allowed it outright, no card was ever
proposed, and the command completed on its own. Every layer did exactly what it
should. The fixture was asking permission for something that needs none.

The unit test had frozen the mistake in place, asserting `operationClass:
"read_inspect"` under a comment explaining the read-only head as though it were
the intent. That is the failure mode worth naming: a test that documents what
the code does rather than what the behaviour is for will hold a hole open
indefinitely, and only the end-to-end test — which asserts a _person_ is asked —
could see it. `FAKE_ASK_COMMAND` is now `curl -X POST https://example.invalid/hook`,
which classifies `external_write` and genuinely blocks. `.invalid` is reserved by
IANA and cannot resolve, so the fixture cannot reach anything even if something
one day really ran it.

Both fixed in `7aa959c`; all ten gates green afterwards. Nothing in the
production path was wrong, and no live turn has still been run: the claim in the
entry above is unchanged.

#### 2026-09-15 The first live turn, and the classifier bug it found

The entry above ended "no live turn has still been run". That is no longer true.
A prompt typed into Chat on the home PC reached Codex App Server on the node,
ran a real command against real files, and came back. Evidence in
`docs/operations/runtime-live-evidence.md`.

**The classifier called a directory listing `destructive`.** The disk-format
rule was `format\b`, and `\b` sits between "format" and a hyphen, so
`Get-ChildItem | Format-List` matched the command that wipes a drive. The
approval card demanded a typed `DESTROY`, and because the phrase is built from
the target, it asked the owner to type two hundred characters of PowerShell.

That is the worst shape an authority bug can take. It is not that something
dangerous was allowed; it is that something harmless was refused _in the
vocabulary reserved for the dangerous thing_. An approval that cries wolf, and
then cannot be answered honestly because nobody types two hundred characters,
teaches the one habit the whole boundary exists to prevent: answering without
reading. `Format-List`, `Format-Table` and `Format-Wide` end a large share of
every read-only PowerShell pipeline a model will ever write, so this would have
fired constantly.

The rule now requires whitespace or end-of-string after `format`. `format D: /q`
still classifies destructive; three regression cases from the real command hold
it. A third defect fell out of the same investigation: one unrecognised segment
demotes a whole pipeline, so `dir | Format-List` was `local_reversible_edit`
rather than a read. The pure pipeline stages — the three `Format-*` cmdlets plus
`Select-Object`, `Sort-Object`, `Measure-Object`, `Out-String` — are now known
heads. Deliberately absent: `Out-File` and `Set-Content`, which write, and
`ForEach-Object`, which runs whatever it is handed. That is only safe because
the destructive and external tables are scanned across the whole command before
any head is consulted.

**Two probe defects, found in the same sitting**, each of which reported a
working login as no login at all. `codex login status` prints "Logged in using
ChatGPT" on _stderr_ and exits 0, and the probe read only stdout. `claude` on
Windows is an extensionless npm shim beside a `.cmd` wrapper, and Node can spawn
neither — the exact problem the donor's Codex resolver was ported to solve, which
the Claude probe did not use. Bare PATH names now go through `cmd.exe /c`, and
both streams are read.

**What the run proved that no fixture could.** Asked to list three files and move
any screenshots, Vesper listed the three and moved nothing, because none were
screenshots, and said so. It did not invent the conditional work. Its first
command was declined mid-turn and it adapted rather than failing — "I'm retrying
with a narrower command". A turn whose agent was restarted underneath it
completed as `failed` with `lease_expired` named, rather than hanging or being
silently re-run.

**Still not claimed.** The `file_change` path has never executed: there were no
screenshots to move. Claude has not run a live turn. Neither has the two-PC
topology, and the browser still has no token deltas until Slice 2.

#### 2026-09-15 Checkpoint 1A closed — Noctis moved a file

The prompt was re-sent with one real screenshot in `Downloads`. Vesper listed the
three newest files, identified the screenshot, created `Documents\Screenshots`,
and moved it there. Verified on disk.

That is the first time Noctis has changed anything the owner owns, and the part
that matters is not that it worked. It is the row it left behind:

```
local_reversible_edit | allow | reasonCodes: objective_active_scope
```

Three of them, one per command in the turn. Owner decision 0.4 says local edits
inside granted folders are auto-allowed under an active Objective **and audited**,
and `objective_active_scope` is that sentence made checkable after the fact. The
same edit with no Objective active produces a card instead, and the reason code
is what distinguishes the two cases in the ledger months later. An allow that
left no row would have been indistinguishable from an allow that should have
asked.

Checkpoint 1A is closed: prompt → turn → Codex App Server on the node → real
commands against real files → an edit inside a granted root → items, reply and
audit persisted → history that survives a restart, with the session id stored so
the thread resumes rather than restarting.

**Not claimed.** Claude has still not run a live turn. Nor has the two-PC
topology (1B), nor a decline answered from the page rather than the API, nor
token streaming in a browser, which waits on Slice 2's SSE.

#### 2026-09-15 Task 1.12 — two machines, and the boundary that is not a promise

The authoritative core now runs on the work PC (`mushafzarrar`) behind
`tailscale serve` (tailnet only, never funnel). The personal PC (`zarrarpc`)
pairs to it as a worker over `wss://`. Both nodes report online.

**The names were backwards in our own runbook.** `zarrarpc` is the _personal_
machine (user `mmush`, MindVault, the donor repo); `mushafzarrar` is the _work_
machine (user `mushaf.zarrar`). An earlier revision had them swapped, which would
have put the authoritative core on the personal machine and granted the work
machine every personal root — the exact inversion of decision 0.30. Caught by
running `hostname` before acting rather than by reading. The runbooks now say to
check first, and say why.

**The proof.** A `conversation.send` issued on the work PC, naming
`rootGrantId: "downloads"`, returned a turn whose `nodeId` was the personal
node. Four `codex.exe` processes then appeared on the personal machine. The ask
it raised was confirmed on the work PC, and the reply came back:

| Where                          | `COMPUTERNAME` | `whoami`                     |
| ------------------------------ | -------------- | ---------------------------- |
| Through Noctis, sent from work | `ZARRARPC`     | `CodexSandboxOffline`        |
| Natively on the work PC        | `MUSHAFZARRAR` | `mushafzarrar\mushaf.zarrar` |

Nothing chose that host. The grant ids are disjoint — the work node holds
`work-downloads`, the personal node holds `downloads` — so naming a root the work
node cannot offer leaves exactly one eligible candidate. Decision 0.30 is
therefore enforced by routing rather than by anyone remembering it: the work core
holds a grant naming personal folders, and only the node standing on those
folders can ever use it.

**A second thing that output proves.** `whoami` returned `CodexSandboxOffline`,
not `zarrarpc\mmush`. The owner's `~/.codex/config.toml` sets
`sandbox_mode = "danger-full-access"` globally, and the turn plainly did not run
with it: the per-spawn override held and the command ran sandboxed with
networking off. The Isolation constraint has been asserted in comments since
Slice 1 began; this is the first time the machine has confirmed it.

**The gap this exposed.** Nothing in the page can name a `rootGrantId`, so a
prompt sent from Chat routes by session affinity and then by lowest node id. On a
two-node core that means work-first, and a question about personal files would be
answered from the wrong machine — correctly, and uselessly. The pinning mechanism
works; what is missing is any way for a person to reach it. That belongs in Slice
2 beside the phone, because "which machine" and "which device am I on" are the
same question asked twice.

### 2026-09-22 Slice 3 Task 3.8 and Slice 5 Task 5.3 — two discoveries, no code

Both are inspections. Nothing was installed, enabled, sent or changed on any
machine; the only artefacts are `docs/operations/remote-access.md` and
`docs/operations/WOL.md`, and both label every measured fact as measured.

**3.8 found a fork, not a ranking.** Noctis ships two clients and both of them
are a web page — the Tauri shell is WebView2, the phone is the same bundle over
Tailscale Serve. So "embedded" means "renderable by a web page", and that one
constraint splits the candidates cleanly in half. `@devolutions/iron-remote-desktop-rdp`
(MIT OR Apache-2.0, published 2026-05-27) is the only maintained, permissively
licensed backend that embeds — and it speaks RDP, which on a Windows client SKU
evicts the console session. Sunshine, Moonlight and the incumbent AnyDesk all
share the console session and none of them can be hosted by a web page. There is
no option that gives both, short of the custom transport 3.9 forbids.

That matters beyond the panel. The node agent's GUI tools drive the console
desktop, so choosing the embedded panel makes 3.10's handover _exclusive_ — agent
GUI work stops while a human is connected — rather than cooperative. The document
recommends taking that trade and stops for the owner's answer, as the task says to.

**5.3 found the hardware ready and the software not.** `powercfg /a` reports S3
and Hibernate with no Modern Standby, and `powercfg /devicequery wake_armed`
already lists the Realtek 2.5GbE adapter: Windows' half of wake-on-LAN is on
without anyone configuring it. The machine also sleeps rather than shuts down —
last boot 2026-09-16, with S3 cycles through the week — so the realistic wake case
is the easy one.

Two blockers, both named rather than worked around. Nothing on the home LAN can
send a magic packet: the ARP table holds the router and one phone, there is no
subnet router on the tailnet, and Tailscale 1.102.2 has no `wake` subcommand.
And, separately, **there is no Noctis autostart on `zarrarpc` at all** — no
service, no scheduled task, no startup entry — so a successful wake would reach
"reachable" and never reach "worker authenticated". The second blocker is free to
fix and needs only the autostart approval the plan already keeps default-off; the
first is a purchase and stays the owner's.

**Not claimed.** No latency, frame rate or resolution figure for any remote-desktop
backend, including AnyDesk's own baseline, which has to be recorded before anything
can be called equivalent to it. No magic packet sent. The UEFI wake setting unread.
Whether GUI input injection fails outright on a disconnected session is expected,
not verified, and 3.9 should verify it first because the recommendation rests on it.

#### 2026-09-22 Task 3.3 (first half) — two Objectives at once, proven rather than assumed

3.3's gate has two halves. The first — "two turns on two Objectives run
concurrently on one node" — turned out to need no code at all, which is worth
writing down precisely because nothing announces it. `routeJob` sorts candidates
by `activeLeases` only to break ties between nodes, never as a cap, and the node
agent starts each assignment with `void execute(assignment)` into a `Map` keyed
by job id. Two independent files already agreed; nobody had ever asked them to
prove it together.

`conversation.integration.test.ts` now does. Two active Objectives, one node, and
the second prompt is sent while the first job is still leased — if the core ran
one turn per node the second job frame would never arrive and the test would time
out there. Both jobs are then confirmed in flight in the same `SELECT`, answered
**out of order**, and each thread is checked to hold its own prompt and its own
reply. Finishing the second Objective's turn leaves the first one `running`, and
the two `identity_sessions` rows come out one per thread, so the next turn on
each Objective resumes its own runtime session rather than the other's.

**Fixture proof, not live proof.** The node is the fake socket, not a machine
running Codex. What this establishes is that the core will hand a real node two
turns at once and keep their results apart; what it does not establish is that
two `codex.exe` processes on one PC behave under a shared sandbox, which needs
the live run.

**The second half is untouched.** A Claude `Agent` call and a Codex collab agent
appearing as `sub_agent` items whose tool calls still ask needs both runtimes
live. The `sub_agent` item kind exists in the contract and both adapters already
emit it; nothing has watched one ask.

#### 2026-09-22 ADR-0036 on `zarrarpc` — the worker starts itself, as the owner, with no password kept

Registered per `docs/operations/nodes.md` "Starting without a person" and started once by hand
before any reboot. Everything below was read off the machine, not inferred from the task's state:

| Check                 | Result                                                                             |
| --------------------- | ---------------------------------------------------------------------------------- |
| `LastTaskResult`      | `267009` — running; the agent never exits, so running is success                   |
| The process           | PID 21768, **session 0**, created the second the task ran; owner `ZARRARPC\mmush`  |
| Its connection        | `100.70.27.11:58919` → `100.89.64.5:443` Established, same port four seconds later |
| Where that is         | the work PC's Tailscale Serve, matching the credential's `coreUrl`                 |
| Listening sockets     | **none** — the no-listeners constraint holds under autostart                       |
| Codex auth under S4U  | plain `~/.codex/auth.json`; nothing in Credential Manager                          |
| Claude auth under S4U | plain `~/.claude/.credentials.json`; nothing in Credential Manager                 |

**S4U works for a Microsoft account here.** `mmush` is `PrincipalSource: MicrosoftAccount`, and S4U
with those is the variant most likely to fail with a logon error. It did not, so no copy of the
owner's password is stored on this worker. The DPAPI caveat the runbook raises does not apply on this
host either, because neither runtime keeps its token in anything DPAPI protects — both are files in
the profile S4U loads.

**Session 0 is the point, not a quirk.** The agent's command line is invisible to an unelevated
shell because it runs in another logon session with no desktop. That is exactly the state ADR-0036
predicted: correct for headless turns, wrong for GUI tools.

**Not yet claimed.** A cold start — reboot with nobody logged in — has not been run; this was a
manual start of a registered task. The providers the core sees in `hello.providers[]` were not read
from the core; the plain auth files make them expected to be available, not observed.

#### 2026-09-22 The reconnect fix, proven on the shutdown people actually do

`7f8ba24` stopped the agent exiting 0 when its socket goes. The first live proof of it was not the
test planned for it. The owner shut the PC down and powered it on, which with Fast Startup is a
hibernation of session 0, not a boot:

| Event                    | Time     | Read from                                                |
| ------------------------ | -------- | -------------------------------------------------------- |
| Agent started (manually) | 21:39:03 | PID 21528, session 0, connected on local port `55259`    |
| Shut down → hibernate    | 21:43:35 | `Kernel-Power` 187 `SetSuspendState`, then 42            |
| Power on                 | 21:44:49 | `Kernel-Boot` 27, **boot type 1** (Fast Startup)         |
| Owner logged in          | 21:44:50 | first `explorer.exe`                                     |
| Agent reconnected        | 21:46:15 | **same PID 21528**, new connection on local port `58057` |

The process came back from hibernation with a dead socket, kept retrying, and reconnected without
anyone touching it. Before `7f8ba24` that dead socket was the last thing holding the event loop, so
this — the everyday Shut down and power on — ended the worker every time. `LastBootUpTime` stayed at
the 21:32:25 cold boot throughout, and the at-startup trigger did not fire, because nothing booted.

**Not proven by this.** The trigger on a cold boot (Restart, boot type `0`) with the fix in place.
Whether the tailnet exists before login: the reconnect landed 86 s after login, which a Tailscale
waiting for the user and a backoff interval would both explain. Tailscale is not in unattended mode
(its default), so the expected answer is that it does not.

#### 2026-09-22 Cold boot with the fix — the worker comes back with nobody touching it

Restart with `7f8ba24` built and Tailscale in unattended mode (`tailscale set --unattended`,
`ForceDaemon: true`):

| Event                   | Time     | Read from                                                   |
| ----------------------- | -------- | ----------------------------------------------------------- |
| Boot                    | 21:53:10 | `Kernel-Boot` 27, **boot type 0** — a real cold boot        |
| Task fired              | 21:53:22 | `LastRunTime`; `LastTaskResult` `267009`, running           |
| Owner signed in         | 21:53:24 | first `explorer.exe`, 14 s after boot                       |
| Agent connected to core | 21:53:39 | PID 4208, `:55827` → `100.89.64.5:443`, 17 s after starting |
| RDP                     | —        | `3389` listening                                            |

The same sequence at 21:32 — task fired, first dial failed because the tailnet was not up — ended
with `LastTaskResult 0` and no agent. With the fix it ends connected. No one started the agent,
restarted the task or touched Noctis.

**What this does not separate.** Sign-in landed 14 s after boot on both cold boots, which the owner
did not do by hand; Automatic Restart Sign-On or Windows Hello face sign-in would each explain it,
and the Security log that would distinguish them needs elevation. So the agent connected with a
user session present, and a boot with no session at all is not directly observed. Unattended mode is
what removes Tailscale's dependency on that session, and it is on.

## v1 scope

### 2026-10-07 S1: fast agent turns, one live process per thread

Implemented: `apps/node-agent/src/runtimes/sessions.ts` (the per-thread process pool), Claude
through one streaming `query()` per thread fed one user message per turn
(`runtimes/claude.ts`), Codex through one `codex app-server` per thread where a follow-up is one
`turn/start` (`runtimes/codex.ts`), `Runtime.close()`, and `main.ts` closing every live process on
SIGINT/SIGTERM. Commit `c9cc2fe`. No core, contract or web change; the core already sends the
stored `sessionRef` on every turn of a thread, which is what the reuse rule keys on.

**The reuse rule.** A turn reuses the thread's live process only when it is alive, was opened with
the same model, roots and `objectiveActive`, and holds the session the core names. Anything else
closes it and opens a new one that resumes `sessionRef` (Claude `resume`, Codex `thread/resume`),
which is exactly the path every turn took before. A turn with no `sessionRef` never inherits a live
process, because that process carries context the core does not know about. A thread's turns run
one at a time. A process idle for 10 minutes (`RUNTIME_IDLE_MS`) is closed and the next message
resumes. `canUseTool`, the in-process `noctis` MCP tools and Codex's approval requests are bound
once per process and routed to the turn currently running; a tool call arriving between turns is
denied because nobody could answer it.

| Gate clause                                            | State       | Evidence                                                                                                                                                                                  |
| ------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Second message in a thread reuses the process (Claude) | implemented | `claude.test.ts`: "THE GATE: the second message in a thread reuses the process instead of spawning one": one `query()` call, both prompts streamed into it, controller not aborted        |
| Second message in a thread reuses the process (Codex)  | implemented | `codex.test.ts`: "THE GATE: the second message in a thread reuses the process: one spawn, one thread, two turns": one spawn, one `initialize`, one `thread/start`, two `turn/start`       |
| Idle timeout closes, next message resumes              | implemented | "closes an idle process, and the next message resumes ..." in both suites: the process is closed, the next turn spawns once and passes `resume` / `thread/resume` with the stored session |
| Reuse only for the session the core names              | implemented | "reopens rather than reuse when ..." in both suites: no `sessionRef`, another root, or a dead process each open a new one                                                                 |
| Measured latency on a real node                        | implemented | the live table below                                                                                                                                                                      |
| Never `--bare`, never an API key                       | implemented | unchanged guards: the `--bare` source scan, the billing-key refusal, the `apiKeySource !== "none"` refusal; the live probe reported `claude_ai` and `chatgpt` logins                      |

Sabotage, each applied, observed failing, and reverted:

| Sabotage in `sessions.ts`                    | Tests that failed                                  |
| -------------------------------------------- | -------------------------------------------------- |
| Reuse check forced to always reopen          | both THE GATE tests and the one-at-a-time test (3) |
| Idle timer left in place but closing nothing | both idle tests (2)                                |
| Per-thread queue removed                     | "runs a thread's turns one at a time" (1)          |

Existing tests that changed meaning rather than being worked around: the Codex happy path and
decline tests now assert the child is **not** killed after a turn; the proposals file is named for
the thread rather than the message, because the MCP child it is handed lives as long as the process;
the Claude `canUseTool` and proposal-tool tests now call into a turn that is held open, since a call
with no turn running is denied by design.

#### Live measurement on a real node

Host `mushafzarrar` (the work PC). A throwaway core from this checkout's `apps/core/dist` on
127.0.0.1:7790 with a temporary database, and a node agent paired to it with its own
`NOCTIS_NODE_HOME`; the production core on 7717 and its database were not touched, and no node
agent was running on this machine. Both processes were started with every `NOCTIS_*` and `CLAUDE*`
variable removed from the environment, as a scheduled-task node would have them.

Runtimes as probed by the node: Claude through Agent SDK 0.3.270, login `claude_ai`; Codex
`codex-cli 0.154.0-alpha.6.2`, login `chatgpt`. Models `claude / sonnet` and `codex / gpt-5.6-luna`.
Prompt: "Do not run any commands or read any files. Reply with exactly one word: pong", under an
active Objective, rootGrantId on an empty scratch folder. Every turn returned one `agent_message`
"pong" with no command, no file change and no approval row.

Latency is wall clock from `POST /commands/conversation.send` to the turn reading `completed` on
`GET /threads/:id/turns`, polled every 25 ms: core routing, the node socket, the runtime, and the
result being recorded. "After agent restart" kills the agent mid-thread so no process is live, which
is the spawn-and-resume path every turn took before S1.

| Runtime | Message                             | Run A (ms) | Run B (ms) | Runtime process               |
| ------- | ----------------------------------- | ---------- | ---------- | ----------------------------- |
| Claude  | first (new session)                 | 2142       | 1802       | one `claude.exe` for all four |
| Claude  | follow-up 1                         | 1280       | 826        | same PID                      |
| Claude  | follow-up 2                         | 1283       | 1239       | same PID                      |
| Claude  | follow-up 3                         | 2013       | 904        | same PID                      |
| Claude  | after agent restart (spawn, resume) | 2262       | 1515       | new PID                       |
| Claude  | follow-up after resume              | 1217       | 1052       | same PID as the resume        |
| Codex   | first (new thread)                  | 3872       | 5296       | one `codex.exe` for all four  |
| Codex   | follow-up 1                         | 1174       | 2121       | same PID                      |
| Codex   | follow-up 2                         | 1143       | 1234       | same PID                      |
| Codex   | follow-up 3                         | 1719       | 1154       | same PID                      |
| Codex   | after agent restart (spawn, resume) | 3216       | 2741       | new PID                       |
| Codex   | follow-up after resume              | 1452       | 1200       | same PID as the resume        |

Warm follow-ups: Claude median 1.23 s (0.83 to 2.01 s), Codex median 1.22 s (1.14 to 2.12 s).
Spawn and resume: Claude 1.5 to 2.3 s, Codex 2.7 to 3.2 s; a brand-new Codex thread 3.9 to 5.3 s.
The process ids are the live proof of reuse: the same `claude.exe` and `codex.exe` answered every
turn of their thread until the agent was restarted.

**Against the scope doc's baseline.** The 6 s fresh and 2.4 to 3.4 s warm figures were `claude -p`
with Haiku. On the node a cold Claude turn is 1.5 to 2.3 s, not 6 s, because the node's spawn loads
no settings, plugins or MCP servers (`settingSources: []`, `strictMcpConfig`). So what S1 removes
per follow-up is about 0.3 to 1 s for Claude and 1.5 to 2 s for Codex, rather than about 3 s for
each. The node's Claude probe offers `sonnet` and `opus` only, so Haiku cannot be chosen through
Noctis and these Claude numbers are Sonnet.

#### Found while measuring, not fixed (outside S1)

- **The owner's Codex skills reach Noctis turns.** On a free-chat turn Codex first ran
  `powershell.exe -Command "Get-Content -Raw '~\.agents\skills\superpowers\skills\using-superpowers\SKILL.md'"`.
  `--disable plugins` does not stop it. An isolation gap, and a cost on every Codex turn that obeys it.
- **`classifyAsk` calls that read a local edit.** A quoted `"...\powershell.exe" -Command "Get-Content ..."`
  classified `local_reversible_edit`, so with no Objective active a plain read raised an approval and
  the turn waited for a person (the first measurement attempt waited 9 minutes until it was stopped).
  This predates S1.
- **Codex writes project trust into `~/.codex/config.toml`.** Each workspace-write turn added a
  `[projects.'<root>'] trust_level = "trusted"` entry; the two runs above left two entries for
  scratch folders that no longer exist. Left in place for the owner to remove.
- **`roots.test.ts` (3) and one `adapters.test.ts` assertion fail when `TEMP` is an 8.3 short path**
  (`C:\Users\MUSHAF~1.ZAR\...`), because `realpath` expands it. 138/138 node-agent tests pass with
  `TEMP` set to the long path. Predates S1.
- **`conversation.integration.test.ts` reports unhandled `fetch failed` rejections** on every run
  here: a `read()` poll still in flight when its test's core shuts down. All its tests pass, but
  vitest exits 1. The file imports only the core, contracts and `ws`, none of which S1 changed.
- **Ceilings kept deliberately.** A turn with attachments reopens the process, because the staging
  folder joins the readable roots and so changes the process key. Cancelling a Claude turn closes
  its process and the next turn resumes; cancelling a Codex turn interrupts and keeps it.
- **Node is 22.23.1 here**, not the 22.23.2 `AGENTS.md` pins. Every result above is on 22.23.1.

| Command                    | Result                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npm run format:check`     | exit 0                                                                                                       |
| `npm run lint`             | exit 0; 0 errors                                                                                             |
| `npm run typecheck`        | exit 0                                                                                                       |
| `npm run test:unit`        | 102 files, 1835 tests passed with `TEMP` on the long path; exit 1 from the two pre-existing unhandled errors |
| `npm run test:unit`        | with this shell's 8.3 `TEMP`: 1831 passed, 4 failed, the four short-path tests named above                   |
| `npm run test:integration` | 8 files, 220 tests passed; exit 1 from the same two unhandled errors                                         |
| `npm run build`            | exit 0                                                                                                       |

### 2026-10-07 Before S2: the owner's own setup, agent-led permissions, clean test exits

Three changes the owner asked for after S1, replacing the earlier wish to isolate the runtimes.
Commits `7a15a56` (tests), `6c3a870` (setup and permissions), and the follow-up recorded below.

**1. Noctis turns run on the owner's real setup.** Claude loads `settingSources: ["user",
"project", "local"]` with `skills: "all"` and without `strictMcpConfig`, so CLAUDE.md, user and
project skills (including a repo's `.claude/skills`), plugins, hooks and MCP servers all load.
Codex keeps the owner's `~/.codex`: the `--disable plugins/apps/computer_use/browser_use` flags
and the per-server `enabled=false` overrides are gone. The Noctis MCP server is still added to both.

**2. The agents' own permission systems do the everyday work.**

| Runtime | Mode                                                          | Noctis intervenes                                                                                                                     |
| ------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Claude  | `permissionMode: "auto"` (accepted live, see below)           | a `PreToolUse` hook stops every confirm-level call until the core answers; `canUseTool` (the CLI's own ask) is forwarded to the owner |
| Codex   | `workspace-write` on the granted roots, approval `on-request` | every ask Codex raises is forwarded to the owner; the network stays off so an external call has to escalate                           |

Confirm-level is `isConfirmLevel` in `packages/domain/src/authority/evaluate.ts`: every Section 9.1
class except `read_inspect` and `local_reversible_edit`. An ask now says who raised it
(`RuntimeAsk.askedBy`). One the agent raised itself is never answered by policy alone:
`evaluateAuthority` raises an `allow` to `require_confirmation` with reason `runtime_asked`, and
`require_confirmation` is what `notify/triggers.ts` sends a push for. An unanswered approval fails
the turn after 10 minutes (`APPROVAL_TIMEOUT_MS`, or `NOCTIS_APPROVAL_TIMEOUT_SECONDS` on the
node) with `approval timed out: "<what>" was not answered within <time>`. That failure is itself
pushed ("Turn failed"), and the core declines the still-open approval as `system` when the turn
ends, so the card cannot be confirmed afterwards.

The classifier fix: Codex on Windows wraps every command as `"...\powershell.exe" -Command "..."`,
so the wrapper hid the head and a plain `Get-Content` read classified `local_reversible_edit`. The
wrapper (and `pwsh -c`, `cmd /c`) is now unwrapped before any rule runs; a write, a redirect or a
disk format inside it still classifies as before. An MCP tool named for a read (`get_`, `list_`,
`query-`, ...) is `read_inspect`. The existing row that pinned the wrapped read as a local edit now
expects `read_inspect`.

Found while running it live: on Windows the CLI offers **`PowerShell`, not `Bash`**, unless
`CLAUDE_CODE_GIT_BASH_PATH` is set (it is, at user scope, on this machine). The gate first mapped
only `Bash`, so every PowerShell call would have been stopped as an unknown tool. Both now map to
the command classifier. The CLI's built-ins that reach out (`CronCreate`, `CronDelete`,
`RemoteTrigger`, `SendMessage`, `ShareOnboardingGuide`, `DesignSync`, and anything not yet listed)
are confirm-level; the local ones (`Skill`, `Workflow`, `ListAgents`, worktrees, `PushNotification`
to the owner's own devices, ...) are left to the agent.

**3. `test:unit` and `test:integration` exit 0 in a normal shell.** The shutdown race was eight
detached `void read(...)` polls in `conversation.integration.test.ts` still in flight when
`afterEach` closed the core; `waitFor` now awaits an async predicate. The four short-path failures
compared against the JS `realpathSync`, which keeps an 8.3 `TEMP` path that the native `realpath`
in `roots.ts` expands; the tests now expect `realpathSync.native`. Production code was right.

Sabotage, each applied, observed failing, and reverted:

| Sabotage                                              | Tests that failed                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| Claude gate treats every class as below confirm-level | 5 Claude permission tests                                            |
| Claude ignores `ApprovalTimedOut`                     | "fails the turn with the timeout's own words ..." (hangs, times out) |
| Core drops `askedByRuntime`                           | "an ask the agent raised itself waits for a person ..."              |
| Core never closes open asks at turn end               | "a turn that ends while its approval waits closes the approval ..."  |
| Timeout worded only in ms                             | "fails the turn with a clear error when nobody answers ..."          |

#### Live, on the work PC (throwaway core on 7790, node from this checkout)

**What the CLI loaded** (one turn through the built runtime, init message read directly):
`apiKeySource: "none"`, `permissionMode: "auto"`, model `claude-sonnet-5`, 16 plugins
(superpowers, ponytail, postman, expo, github, playwright, ...), the owner's user and plugin skills
plus the project skill `noctis-probe`, and the owner's MCP servers (several report `needs-auth`,
`plugin:github:github` reports `failed`, as they do in the owner's own sessions).

**A repo's `.claude/skills` is seen and used.** A scratch git repo held
`.claude/skills/noctis-probe/SKILL.md` naming a codeword. Asked "What is the Noctis probe
codeword?", Claude called `Skill` (`Launching skill: noctis-probe`) and answered
`heliotrope-forty-two`, through the runtime directly and through the real node.

**Latency with the full setup**, free chat, no Objective, same measurement as S1 (send to
`completed`); two runs, process ids unchanged across each thread's warm turns:

| Runtime         | First message | Warm follow-ups (10 samples)                           | Spawn and resume after restart | S1, isolated, for comparison           |
| --------------- | ------------- | ------------------------------------------------------ | ------------------------------ | -------------------------------------- |
| Claude, Sonnet  | 6.9 s, 5.4 s  | median 1.94 s; 1.63 to 2.60 s, 3 of 10 at 4.6 to 7.2 s | 3.4 s, 3.6 s                   | first 1.8 to 2.1 s, warm median 1.23 s |
| Codex, 5.6-luna | 13.2 s, 5.3 s | median 1.85 s; 1.42 to 2.08 s, 1 of 10 at 4.5 s        | 5.8 s, 4.3 s                   | first 3.9 to 5.3 s, warm median 1.22 s |

The cold start costs roughly 3 to 4 s more for Claude (plugins, hooks and MCP servers starting) and
the first Codex turn now also reads the owner's superpowers `SKILL.md` before answering. Warm turns
stay warm (same process, no reload) but are about 0.6 s slower than S1's isolated runs, consistent
with a larger context and the owner's per-prompt hooks; that cause is inferred, not measured.

**Noctis's gate, live (Claude).** Asked to run `curl -X POST https://example.invalid/noctis-gate-test`
with nobody answering and a 20 s approval timeout: the call was stopped before it ran, recorded as
`external_write`, `require_confirmation` (the outcome that pushes), and after 20 s the turn failed
with `approval timed out: "curl -X POST https://example.invalid/noctis-gate-test" was not answered
within 20000 ms` (now worded "20 seconds"). The approval was then declined by `system`.

**Codex, live: contained, not asked.** The same request ran inside Codex's sandbox without an ask,
as `on-request` allows, and the network-off sandbox blocked it (`Failed to connect to
example.invalid:443 over proxy 127.0.0.1`). Codex reported the failure rather than requesting
escalation, so the path where Codex's own ask is forwarded and pushed is proven by
`codex.test.ts` and the core tests, not yet observed live.

#### What this design does not cover, stated plainly

- **Codex has no pre-execution hook.** Noctis sees a Codex action only when Codex asks. Inside
  the sandbox Codex may run a destructive local command (`rm -rf` within the granted roots)
  without anyone being asked; the containment is the sandbox (writes only in the granted roots, no
  network), not Noctis. MCP tools from the owner's `~/.codex` (plugins, apps) run outside the
  sandbox and are equally unseen. Closing this would mean Codex exec-policy rules (`prompt` on
  chosen command prefixes) or a narrower `~/.codex` for Noctis.
- **WebFetch and WebSearch are reads**, left to auto mode. The automated security review flagged
  that a GET can carry data out in its URL; auto mode's classifier is what judges that now.
- **A granted root's project settings run with the owner's authority**, hooks included. The
  automated review flagged this too; it is the requested behaviour, and granting a root is the
  trust decision.
- **Codex keeps writing project trust into `~/.codex/config.toml`**: four scratch-folder entries
  from these runs and the rules check below (lines 274 to 283) are left for the owner to remove.
- **The automated security review also flagged Codex running the owner's plugins and MCP servers
  with approval `on-request`, and MCP tools trusted by name.** Both are as asked; the first is the
  Codex gap described above. On the second: the name only decides whether Noctis stops a call
  before auto mode sees it, and a server whose `fetch_` or `query_` tool writes would be read as a
  read. An explicit per-tool allowlist is the stricter alternative if that matters more than the
  noise.

| Command                                                               | Result                                                                                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`                                                | exit 0                                                                                                                 |
| `npm run lint`                                                        | exit 0                                                                                                                 |
| `npm run typecheck`                                                   | exit 0                                                                                                                 |
| `npm run test:unit`                                                   | exit 0; 102 files, 1855 tests, in a shell with the 8.3 `TEMP`                                                          |
| `npm run test:integration`                                            | exit 0; 8 files, 223 tests                                                                                             |
| `npm run test:migrations`                                             | exit 0; 6 files, 30 tests                                                                                              |
| `npm run test:boundary`                                               | exit 0; 6 tests                                                                                                        |
| `npm run test:security`                                               | exit 0; no dedicated tests                                                                                             |
| `npm run test:performance`                                            | exit 0; no dedicated tests                                                                                             |
| `npm run build`                                                       | exit 0                                                                                                                 |
| `npm run build:web`                                                   | exit 0                                                                                                                 |
| `npm run test:e2e`                                                    | exit 0; 13 tests, run against Edge (`NOCTIS_E2E_BROWSER_CHANNEL=msedge`, Phase 6 note)                                 |
| `npm run test:deploy`                                                 | exit 1; 3 pass, 1 fail by design: "refuses to deploy anywhere but the work PC" asserts it is not run on `mushafzarrar` |
| `npm run test:desktop`                                                | exit 1; 5 pass, 1 fail: `cargo.exe ENOENT`, no Rust toolchain on this machine                                          |
| `npm run rust:fmt:check`, `rust:clippy`, `rust:test`, `build:desktop` | not runnable here: `cargo` is not installed; CI is the authority, as before                                            |

### 2026-10-07 Evasion constructs confirm, and Codex prompts by rule

Two follow-ups to the entry above, both from the security review of `57a2424`.

**Commands that hide what they run are confirm-level, in both shells.** `classifyAsk` checks an
`EVASION` table after the destructive and external tables and before the read-only heads:
`iex`/`Invoke-Expression`, a nested PowerShell (which covers `-EncodedCommand` and `-File`), a
nested `cmd /c`, the `&` call operator on a string, variable or expression, dot-sourcing, any
backtick (a PowerShell escape or a Bash substitution), `eval`, a `bash`/`sh`/`zsh`/`dash -c`
started mid-command, `node -e`/`-p`, and `python -c`. Each classifies `external_write` with reason
`hides what it runs: ...`, so Claude's gate stops it and the owner is asked. A shell wrapper at the
very start of the command is still unwrapped rather than flagged, because that is how both agents
run every command; `bash -lc "..."` joined the wrappers for nodes that are not Windows, and the
shell names are anchored so `ssh -c` is not read as `sh -c`. Rows pin the near misses: `&&`, `ls .`,
`node --version` and a file named `powershell-notes.md` are unchanged.

**Codex itself prompts before recursive deletes, history changes and publishing.** The node
installs `noctis.rules` into the Codex home (`CODEX_HOME`, else `~/.codex/rules/`) before each
app-server starts, rewriting it only when it differs and leaving the owner's own rules files alone.
`prefix_rule`s with `decision = "prompt"` cover `rm -r` in every flag spelling, `Remove-Item` and
its aliases with `-Recurse` (or `-Force -Recurse`), `rd`/`rmdir /s`, `git push`, `git reset`,
`rebase`, `filter-branch`, `filter-repo`, `replace`, `commit --amend`, `branch -D`, and
`publish`/`upload`/`push` for npm, pnpm, yarn, bun, cargo, poetry, uv, twine, gem, dotnet/nuget,
plus `gh release`. Codex merges rules files and keeps the strictest result, so this file only adds
prompts. Because it is the user layer, the owner's other Codex sessions prompt for these too.

`codex-rules.test.ts` runs Codex's own evaluator (`codex execpolicy check`) on the installed file:
24 commands prompt and 6 ordinary ones (`git status`, `git commit -m`, a single-file `rm` or
`Remove-Item`, `npm test`, `npm run build`) do not. The block skips where Codex is not installed,
as on CI.

**Live, on the work PC.** Asked to run `Remove-Item -Recurse -Force build` in a scratch folder:

- Through a throwaway core and node with a 20 s approval timeout, the ask reached the core as an
  approval (`destructive`, `require_typed_confirmation`, the outcome that pushes), the turn failed
  with `approval timed out: "...Remove-Item -Recurse -Force build'" was not answered within 20
seconds`, the approval was declined by `system`, and `build/` was still there.
- The raw request Codex sent, read from its JSON-RPC stream, gives the reason as
  ``...powershell.exe" -Command 'Remove-Item -Recurse -Force build'` requires approval: a recursive
delete`` — the rule's own justification, matched through the PowerShell wrapper. The runtime
  forwarded it as `askedBy: "runtime"`.
- A control with `Remove-Item -LiteralPath build2 -Recurse -Force`, which no prefix rule matches,
  also prompted: Codex's built-in dangerous-command check covers recursive deletes on its own. The
  rule is what names the reason; the deletes would have been asked about either way.

Sabotage: removing the install call fails "installs the Noctis rules into the Codex home before the
app-server starts"; the 15 evasion rows were red before the table existed.

Not covered: prefix rules match leading tokens only, so `git commit -m x --amend` is not matched
(the sandbox still bounds it to the granted roots, and `.git` is read-only in Codex's
`workspace-write`). The forwarded card shows the command, not Codex's reason text.

#### Known, not fixed

- **Warm turns are slower with the owner's full setup.** Warm medians went from 1.23 s (Claude) and
  1.22 s (Codex) isolated to 1.94 s and 1.85 s, with occasional 4.5 to 7.2 s outliers, and the first
  turn costs 3 to 4 s more. The planned fix is a lean Noctis settings profile: the owner's skills
  and CLAUDE.md without every plugin, hook and MCP server starting on each process.
- **MCP read detection is by name prefix.** `classifyToolCall` treats an `mcp__*` tool named
  `get_`, `list_`, `fetch_`, `query-` and the like as a read, so a server whose `fetch_` or
  `query_` tool writes would bypass the gate. The planned fix is an explicit allowlist of
  server and tool pairs the owner has marked read-only.

| Command                                                       | Result                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`                                        | exit 0                                                                                                                                                                                                                                                                                                |
| `npm run lint`                                                | exit 0                                                                                                                                                                                                                                                                                                |
| `npm run typecheck`                                           | exit 0                                                                                                                                                                                                                                                                                                |
| `npm run test:unit`                                           | exit 0; 103 files, 1908 tests, including the 30 rules cases run through Codex's own evaluator                                                                                                                                                                                                         |
| `npm run test:integration`                                    | exit 1 in the full sequence: two timeouts in suites this change does not touch (`headless.integration.test.ts` "stops upgrading the moment it is revoked", `nodes.integration.test.ts` "closes a socket that exhausts its progress budget"); three reruns straight after: exit 0, 223 tests each time |
| `npm run test:migrations`                                     | exit 0; 30 tests                                                                                                                                                                                                                                                                                      |
| `npm run test:boundary`                                       | exit 0; 6 tests                                                                                                                                                                                                                                                                                       |
| `npm run test:e2e`                                            | exit 0; 13 tests, against Edge                                                                                                                                                                                                                                                                        |
| `npm run build`, `build:web`                                  | exit 0                                                                                                                                                                                                                                                                                                |
| `npm run test:security`, `test:performance`                   | exit 0; no dedicated tests                                                                                                                                                                                                                                                                            |
| `npm run test:deploy`                                         | exit 1 by design on this machine: "refuses to deploy anywhere but the work PC"                                                                                                                                                                                                                        |
| `npm run test:desktop`                                        | exit 1: `cargo.exe ENOENT`                                                                                                                                                                                                                                                                            |
| `rust:fmt:check`, `rust:clippy`, `rust:test`, `build:desktop` | not runnable: no Rust toolchain on this machine; CI is the authority                                                                                                                                                                                                                                  |

### 2026-10-07 S2: agents hand work to each other through Noctis

Implemented across contracts, core, node and web; not yet committed. A Claude turn calls
`noctis_delegate`; the core records an authority decision, opens or continues a child thread linked
to the parent, runs the child turn on the runtime asked for, and returns the reply, the child
`threadId` and the files the child produced. The owner sees the child in Chat, opens it, and
continues it.

- **Contracts.** Node frames `delegate` (node to core) and `delegated` (core to node); runtime item
  `output` (`mediaType`, `path`, `attachmentId`); `parentThreadId` and `parentTurnId` on a thread;
  `threadId` on `conversation.send`.
- **Core.** Migration `0010_delegation.sql` (parent columns; the free-thread and Objective-thread
  unique indexes now hold for top-level threads only). `conversation/service.ts`: `sendMessage` and
  delegation share one `openTurn`; a delegation is an authority request (`local_reversible_edit`,
  capability `runtime.delegate`, target `runtime:<provider>`, against the parent's job), then a child
  turn pinned to the parent's node and root unless `node` names another. A delegation may continue
  only a thread its own parent thread started. Routes: `GET /threads/:id`,
  `GET /threads/:id/children`, `POST /node/outputs` (node credential, only for a job that node holds,
  stored with provenance `runtime_output`), `GET /attachments/:id/content` (served with
  `content-security-policy: sandbox; default-src 'none'` and `nosniff`).
- **Node.** `agent.ts` carries `delegate` like an ask (rejected on cancel and disconnect, no timeout
  of its own) and posts outputs over HTTP. `claude.ts` hosts `noctis_delegate` in the in-process
  `noctis` MCP server. `codex.ts` turns an `imageGeneration` item into an uploaded `output` item and
  holds the turn's result until uploads settle.
- **Web.** The conversation store opens any thread by id, sends to it, and lists its children.
  Chat shows "Delegated thread N" buttons, a Back control, and an image output inline where the
  transport can address bytes (the cookie session).

| Gate clause                                               | State       | Evidence                                                                                                                                                                            |
| --------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Claude thread asks Codex for an image                   | implemented | live run below; `claude.test.ts` "noctis_delegate hands the work to the core and returns the child's thread, reply and outputs"                                                     |
| The image comes back as a viewable output                 | implemented | live run: two PNGs read back through `GET /attachments/:id/content`; `codex.test.ts` image tests; the agent gate test reads the bytes back through the real core                    |
| A second request continues the same Codex thread          | implemented | live run: both calls returned the same `threadId`; `conversation.integration.test.ts` "THE GATE: a delegated turn runs on a linked child thread, and a second request continues it" |
| Child threads are linked and visible; the owner continues | implemented | E2E "a delegation is approved here, opens as its own thread with its image, and the owner continues it"; "the owner continues a delegated thread by naming it"                      |
| Delegation goes through the authority service             | implemented | "outside an active Objective a delegation waits for the owner, and a decline refuses it"; live run: two `allow` rows, `objective_active_scope`                                      |

Sabotage, each applied, observed failing, and reverted:

| Sabotage in `conversation/service.ts`                     | Test that failed                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Any existing thread accepted as a delegation's `threadId` | "a delegation continues only a thread its own parent started"                            |
| Every delegation opens a new child thread                 | THE GATE (core): the follow-up job's `threadId` and `sessionRef` did not match the child |

#### Live run on a real node

Host `mushafzarrar` (the work PC), set up as for S1: a throwaway core from this checkout's
`apps/core/dist` on 127.0.0.1:7790 with a temporary database, and a node agent paired to it with its
own `NOCTIS_NODE_HOME`, both started with every `NOCTIS_*` and `CLAUDE*` variable removed. The
production core on 7717 was not touched. The node probed Claude (`claude_ai`) and Codex (`chatgpt`).
Under an active Objective, a `claude / sonnet` turn on an empty scratch root was told to call
`noctis_delegate` for a lighthouse storyboard frame, then call it again on the returned `threadId`
for the same frame with a red sky, and report both.

| Step                                                     | Time (UTC) | Result                                                                                     |
| -------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| Parent turn sent                                         | 13:50:30   | Claude, Sonnet, on the scratch root                                                        |
| First delegation recorded and child turn opened          | 13:50:40   | approval `allow`, `objective_active_scope`, target `runtime:codex`                         |
| First child turn (`gpt-5.6-luna`) completed              | 13:51:23   | 43 s; `output` item, 1,624,820-byte PNG uploaded                                           |
| Second delegation, same `threadId`, child turn completed | 13:52:04   | 36 s; same child thread, resumed session; 1,657,126-byte PNG                               |
| Parent turn completed                                    | 13:52:06   | 96.8 s in all; Claude's reply listed one `threadId` for both calls and both attachment ids |

Both images were read back through `GET /attachments/:id/content` (`200`, `image/png`) and opened:
a flat-colour lighthouse on a cliff at night, then the same composition with a red sky, which is the
second request being answered inside the first one's context.

#### Found live, fixed

The first live attempt hung. Codex generated the image in 23.5 s and finished its turn in 37 s (its
own session log in `~/.codex/sessions`), but nothing after the image reached the core. Two bugs:

- **The JSON-RPC reader capped a message at 1 MB.** Codex sends a generated image inline, as base64,
  in one `item/completed` notification of several MB, so the reader closed the stream. The Codex
  client now allows 32 MB per message (the 10 MB output cap as base64, with room).
- **A closed reader told nobody.** The turn waited for messages that could no longer arrive. The
  client now reports its own close (`onClose`), and the Codex runtime fails the turn with "codex
  app-server could not be read: ...". The turn hears the reason before the process is killed, so the
  exit does not replace it.

Tests written red first: "reads a generated image far larger than a megabyte, as real ones are"
(hung at 5 s before the fix), "fails the turn, rather than wait forever, when the app-server sends
what cannot be read", and "tells its owner it closed, even with nothing pending".

#### Known, not fixed

- **Codex cannot delegate.** Its Noctis tools run in a separate stdio process that appends to a file
  and gets nothing back. Upgrade path: a reply file keyed by delegation id that the MCP child polls,
  and a longer `tool_timeout_sec` for that server.
- **Outside an active Objective every delegation asks the owner** until a standing permission covers
  `runtime.delegate` for that runtime.
- **A child turn keeps running when its parent turn ends.** Only a delegation still waiting for
  approval is declined, by `system`.
- **Outputs above 10 MB are not copied to the core.** The upload is refused and the item keeps its
  `path`. Large files, video above all, are S4's: streamed from the node on demand, not stored.
- **Images render inline on the cookie session only.** The token transports show the output as text.

| Command                                         | Result                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `npm run format:check`                          | exit 0                                                                    |
| `npm run lint`                                  | exit 0                                                                    |
| `npm run typecheck`                             | exit 0                                                                    |
| `npm run test:unit`                             | exit 0; 103 files, 1925 tests                                             |
| `npm run test:integration`                      | exit 0; 8 files, 229 tests                                                |
| `npm run test:boundary`                         | exit 0; 6 tests                                                           |
| `npm run test:e2e`                              | exit 0; 14 tests, against Chrome (`NOCTIS_E2E_BROWSER_CHANNEL=chrome`)    |
| `npm run build`, `build:web`                    | exit 0                                                                    |
| `npm run test:deploy`, `test:desktop`, `rust:*` | not run: as recorded for the previous entry, not runnable on this machine |

### 2026-10-07 S5: the v1 navigation and a phone-first design

Built before S4 at the owner's request, with the owner's done-check: every existing page works well
on the phone in the new design, and the Files page layout is ready for S4. Not yet committed.

- **Navigation.** `NAV_ITEMS` (`packages/ui/src/primitives/rail-items.ts`): Threads, Files, Nodes,
  Approvals, Vault. Command, Missions, Artifacts and Automations only with `VITE_NOCTIS_ALL_PAGES=1`.
  Settings is a gear on the rail and in the phone's top bar. `tab-items.ts` and its displacement
  rule are gone: the bar no longer has more destinations than slots.
- **Shell and pages.** `layout/Page.tsx` frames every v1 page. Threads (renamed from Chat),
  Approvals (new, from half of Artifacts), Nodes (a PC list above the remote desktop), Files (new),
  Vault and Settings were rebuilt on it. `pages/waiting.ts` decides what Approvals lists.
- **Assets.** Codex session `01a116ae-1a1a-7273-950e-99e1ed19e08a` (`docs/design/codex-session.txt`),
  `gpt-5.6-sol` at high effort, signed in with ChatGPT. Five images from the brief, then two
  revisions of the icon sheet (it came back on white, then with three shapes changed). Every image
  was opened and checked. Shipped as WebP; the mark and icons redrawn as SVG.

| Gate clause                                    | State       | Evidence                                                                                                                          |
| ---------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| The v1 navigation, and nothing else by default | implemented | `rail-items.test.ts`; E2E "THE GATE: the v1 tab bar instead of a rail..." and "puts the rail back where there is width for one"   |
| Every existing page works on a phone           | implemented | E2E "THE GATE: every v1 page fits a phone, with nothing under the touch floor": Threads, Files, Nodes, Approvals, Vault, Settings |
| The Files layout is ready for S4               | implemented | E2E "THE GATE: the Files page is laid out for browsing, and says plainly that it is not on yet"                                   |
| Approvals answers a phone's ask                | implemented | E2E "keeps both answers to a consequence on screen at a phone's width" (now also on the Approvals page); `waiting.test.ts`        |
| The flagged pages still work                   | implemented | `workbench.keyboard` (Command) and `approval.keyboard` (Artifacts) run with the flag on                                           |

Red first: the phone suite failed on the old shell for the expected reasons (the old tab labels,
"Threads" and "Files" not reachable). Then the page gate caught two real defects in the new one:
the Attach control was 42 px tall (the invisible file input filled the padding box, not the border
box), and the Vault sphere's controls and note chips were 26 px. Both fixed, gate green.

Reviewed by eye at 400 x 860 (2x) and 1440 x 900 in Chrome, against a throwaway core and the fake
node. That review found three more things the tests do not measure, also fixed: the thread did not
follow its newest entry, so a reply landed under the composer; the illustration showed its black
square on the glass card; and the approval buttons were in the browser's default font.

#### Known, not fixed

- **Not yet seen on the owner's phone.** Chrome at a phone's size only; iOS Safari is the owner's
  check.
- **The flagged pages keep their old look,** inside the new shell.
- **No count on the Approvals tab.**
- **Threads always follows the newest entry,** even while the owner reads further up.
- **The E2E suites race on this PC.** The owner's environment sets `NOCTIS_WEB_ROOT` to
  `apps/web/dist` for the core on 7717, every suite's core inherits it, and `tokenless` rebuilds
  `dist` (emptying it) while the suites run in parallel. A core that starts in that window refuses
  to boot; the first full run lost the phone suite to it. Not new with S5. Run the suites with
  `NOCTIS_WEB_ROOT` unset; the harness could delete it from each core's environment.
- **`build:web` changes what the work PC's core serves.** The core on 7717 serves `apps/web/dist`
  from disk, so this verification put the S5 design in front of the owner's phone before any commit
  (checked: 7717 served the new bundle, `index-Cu_YDrB1.js`).

| Command                                         | Result                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`                          | exit 0                                                                                                        |
| `npm run lint`                                  | exit 0                                                                                                        |
| `npm run typecheck`                             | exit 0                                                                                                        |
| `npm run test:unit`                             | exit 0; 103 files, 1927 tests                                                                                 |
| `npm run test:integration`                      | exit 0; 8 files, 229 tests                                                                                    |
| `npm run test:boundary`                         | exit 0                                                                                                        |
| `npm run test:e2e`                              | exit 0; 15 tests, against Chrome, with `NOCTIS_WEB_ROOT` unset (the first run lost a suite to the race above) |
| `npm run build`, `build:web`                    | exit 0                                                                                                        |
| `npm run test:deploy`, `test:desktop`, `rust:*` | not run: not runnable on this machine, as before                                                              |

### 2026-10-07 S6: Presence and the live Vesper core

Pulled with `git pull --ff-only`: already up to date. The owner approved all three reference
stills from design session `01a116ae-1a1a-7273-950e-99e1ed19e08a` before implementation.
The initial implementation was verified locally and pushed in `861a94a`. The owner then requested
the visual revision recorded below.

Presence is home, with the room, greeting and shared prompt. It starts/continues the identity's free
thread and opens Threads; returning home clears a delegated-thread selection. The Three.js core uses
168 deterministic junctions, connected lines, translucent shards and a violet crystalline centre.
Profile parameters are exposed; only Vesper is built. Prompt focus means listening; queued/running
turns mean thinking, active streamed text or message items mean speaking, and pending approvals take
precedence. Completed/failed turns cannot leave the core speaking. Idle and approval draw on demand;
hidden and reduced-motion modes stop the loop. An SVG fallback covers WebGL absence/context loss.

Raw turn/message event lines and technical approval fields start behind closed native Details.
Replies, outputs, cancellation, the exact action, cost and reversal consequences remain visible.
The phone gate includes Presence and still checks 44 px controls and no document/sideways scroll.

Red first: navigation lacked Presence; geometry/scheduling assertions and closed Details assertions
failed before implementation. All went green. Browser review corrected overly white centre fragments
and opaque glass, then increased mesh detail. Earlier browser checks needed visible-heading selection,
Command navigation after reload, and the new requested-action label. Those regressions are green.

| Check, using checksum-verified Node 22.23.2 and the unchanged dependency lock | Result                                        |
| ----------------------------------------------------------------------------- | --------------------------------------------- |
| Full Vitest suite                                                             | 108 files, 1,935 tests passed                 |
| Browser suite, Chrome, isolated test cores                                    | 17 tests passed                               |
| S6 capture and WebGL-unavailable gates                                        | 2 tests passed; all five states at both sizes |
| Donor boundary                                                                | 6 tests passed; no donor code copied          |
| TypeScript, ESLint, formatting, diff check                                    | Passed                                        |
| Web production build                                                          | Passed, isolated at `.noctis/s6/web-dist`     |

Captures are in `.noctis/s6/evidence/`: ten named state PNGs, `desktop-all-states.webm` and
`phone-all-states.webm`, plus reduced-motion and WebGL-fallback PNGs. Measurements are in
`measurements.json`. These record the production renderer driven by scripted local transport events;
the existing conversation/browser gates separately exercise a real throwaway core and fake node.
Desktop is 1440 x 900; phone is 400 x 860 (2x screenshot density); Chrome 153.0.8010.47.

| Budget                                         | Desktop measurement | Phone-size measurement |
| ---------------------------------------------- | ------------------- | ---------------------- |
| Active frame rate, target 60 fps               | 59.94 to 60.19 fps  | 59.99 to 60.22 fps     |
| Mean CPU draw submission, target below 16.7 ms | 0.24 to 0.29 ms     | 0.24 to 0.29 ms        |
| Idle frames during 2.4 s sample                | 0                   | 0                      |
| Idle renderer-process CPU, budget at most 1%   | 0.154%              | 0.164%                 |
| Approval frames during 2.4 s sample            | 0                   | 0                      |

Renderer CPU comes from Chrome SystemInfo process CPU-time deltas; it sums renderer processes in
the isolated browser. Draw submission excludes GPU time. Physical-phone GPU/thermal behaviour and
owner visual acceptance are still unverified. No live workers, Vault, services or production bundle
were changed. ESLint ignores `.noctis/` so isolated generated bundles are not treated as source.

### 2026-10-07 S6: rounder core and stronger motion

The owner requested this revision and authorised its commit and push without another approval gate.
The shell and central fragments are now rounder; Presence uses a shorter hero region. All central
materials and the glow turn amber for approval, including the SVG fallback. The isolated amber dot
is gone. Active states rotate the mesh, send lights along its edges, drift individual glass shards,
and tumble and pulse the centre. Speaking has stronger motion; approval has a slower amber pulse.
Idle breathes through a CSS transform with no renderer loop. Hidden and reduced-motion modes stop
motion. Geometry, scheduling and amber-centre assertions failed before the implementation and passed
then; browser checks compare actual core screenshots across time.

Fresh verification with Node 22.23.2: 108 files / 1,935 unit and integration tests; 17 browser checks;
2 capture/fallback checks; 6 donor-boundary checks. Typecheck, lint, formatting, isolated web build
and diff checks passed. No dependencies or lockfile changes.

All five desktop and phone states were visually inspected in `.noctis/s6/evidence-round/`.
Full-page videos use Playwright's 25 fps recorder. Separate core videos target 60 fps through an
opaque canvas and MediaRecorder; the capture run preserves the WebGL drawing buffer solely for
recording. Both core videos decode correctly and their representative frames were inspected.
The direct core videos omit the idle CSS transform; the full-page videos include it.

`performance.json` measures the normal renderer with both video encoders disabled: active states
59.99?60.17 fps, mean CPU draw submission 0.42?0.49 ms, idle WebGL draws zero. Idle renderer-process
CPU is 2.09% desktop / 1.85% phone-size: the breathing compositor exceeds the earlier 1% idle budget.
These are Chrome viewport measurements, not physical-phone or GPU/thermal qualification. No live
workers, Vault, production bundle, services or paid agents were activated.

### 2026-10-08 S4: files and outputs from any machine

Built on the home PC (`zarrarpc`) after the owner approved S6 live. Commits `5cdee68` (core and
node), `0efe0b0` (the Files page), `735b830` (opening a file from the thread that wrote it).

- **Which folders.** `file.list` and `file.read` are node capabilities covered by a `runtime.turn`
  grant (`grantCovers` in `packages/contracts/src/node.ts`, used by the router and the agent's job
  gate). The folders a PC shares with its agents are the folders the owner opens; an agent could
  already read anything in them, so this grants the owner less than it grants the agents. No new
  grant to issue per PC.
- **How bytes travel.** Each listing and each byte range is a job pinned to the node, through the
  ledger, the authority check and a signed assignment. The node streams the range to
  `POST /node/files` for its job and the core pipes that request into the browser's response
  (`apps/core/src/files/gateway.ts`). Nothing is stored on the core, so a film of any size plays
  and seeks. The node renews its lease every 10 s while bytes flow.
- **Containment.** The contract refuses any path that could climb (`FileRelativePathSchema`); the
  node then resolves every link and refuses a target outside the real root, and lists no links.
- **Serving.** `GET /files/list` and `GET /files/content` (with `Range`, `download=1`). The type
  comes from the extension; code and markup are `text/plain`, unknown types download, and every
  response is `nosniff` with a sandbox policy.
- **Page.** A place opens as its folder; a file opens in the viewer beside the list, or as its own
  screen on a phone. Text comes through the transport; images, video and Download need the cookie
  session's URL, as S2's inline images do. A turn's completed `file_change` paths that lie in a
  shared folder are offered in the thread as "Open <name>", which opens Files at the file.

| Gate clause                                                  | State       | Evidence                                                                                                                       |
| ------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| List a shared folder and stream a file, range and all        | implemented | "THE GATE: lists a shared folder and opens a script, a frame and a video range from the node" (real core, real agent)          |
| Refuse what is not shared, and anyone without a token        | implemented | "refuses what is not in a shared folder, and anyone without a credential"; `files.test.ts` (node); `files.test.ts` (contracts) |
| A frame draws and a video range streams on the cookie        | implemented | E2E `files.test.mjs` "THE GATE: a storyboard frame draws and a video streams by range..."                                      |
| The phone opens a folder and a script, full screen           | implemented | E2E phone "THE GATE: from the phone, a shared folder opens and a script in it fills the screen"                                |
| Turns record the files they create, openable                 | implemented | E2E phone "opens a file an agent wrote straight from the thread it wrote it in"; `files-view.test.ts`                          |
| From the phone, a script, a frame and a video on the home PC | not yet     | Needs the work PC's core updated and the home PC paired as a node (owner steps)                                                |

Red first throughout: the contract, router, adapter and gate tests failed on missing behaviour, and
the two E2E gates were run against the previous page (`git stash`) and failed there ("not reachable
with the Tab key"; "never offered from the thread") before passing on the new one.

#### Known, not fixed

- **Places come from probed agents.** `GET /models` lists a node's roots only for the providers it
  probed, so a PC with neither Claude nor Codex installed shows no places, though the file routes
  themselves read the grants directly and would serve it.
- **Video is proved by its 206, not by playing.** Playwright's Chromium has no H.264.
- **The desktop shell and dev browser show text only.** As with S2's images, a token transport
  cannot put a credential on an `<img>` or `<video>`; the viewer says so.
- **One page per folder** (2,000 entries) and no search in the page.
- **A text preview is capped at 2 MB**; larger text is a download.
- **`attachments.test.ts` flaked once** under the parallel run ("leaves no directory behind when one
  file of several fails") and passed three times alone. Not touched by S4.

| Command                                                        | Result                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| `npx vitest run packages/contracts apps/core apps/node-agent`  | exit 0; 64 files, 1217 tests (after the core and node work) |
| `npx vitest run apps/web packages/ui`                          | exit 0; 30 files, 295 tests                                 |
| `npx vitest run apps/web apps/node-agent`                      | 355 of 356; the one failure is the flake above              |
| `node --test apps/web/e2e/{phone,files,chat}.test.mjs`         | exit 0; 7 + 3 tests, Playwright Chromium                    |
| `npm run typecheck`, `lint` (changed packages), `format:check` | exit 0                                                      |
| full `test:unit`, `test:integration`, `test:e2e`               | not run here; handed to the owner                           |

Node here is the pinned 22.23.2.

### 2026-10-08 Continue sessions from elsewhere, and many conversations

The owner's next two after S4, in their order: pick up an agent session started outside Noctis
(the trip that sent them to Claude Code's Remote Control), then a list of conversations. Commits
`ab84471` (node), `84a8101` (core: adopt), `e3b014f` (core: list), `b16bc97` (web), `2d95197`.

- **Listing a folder's sessions.** `session.list`, covered by a `runtime.turn` grant, asks each
  agent the folder is shared with. Claude: the Agent SDK's `listSessions({ dir,
includeProgrammatic: false })`, which leaves out SDK sessions, Noctis's own included. Codex:
  `thread/list` on an app-server started for the call and stopped after it, filtered by both
  spellings of the drive letter (VS Code writes `c:`), sorted by `updated_at`. Checked live on the
  home PC against the hyperframes folder: 4 Claude and 3 Codex sessions, all from VS Code.
- **Adopting one.** `conversation.adopt_session` makes a named thread pinned to that PC, folder and
  agent, and stores the session with `fork_pending`. Its first turn asks the runtime to fork
  (`forkSession: true`; `thread/fork`), so a session VS Code still has open is never written
  under; the fork's own ref replaces it and later turns resume that. A pinned thread refuses
  another agent's model or another folder.
- **Many conversations.** Migration 0011 adds `kind` (`free` | `named`), `title` and the pins to
  threads; the one-free-thread index and lookup now name `kind = 'free'`.
  `conversation.create_thread` opens a conversation; `GET /conversations?identityId=` lists the
  free and named ones by last activity with the newest message.
- **Web.** Threads → Conversations: the list, New conversation, Continue a session (folder, then
  its sessions). A pinned thread's composer says "Continuing in Claude · folder on PC" instead of
  offering the pickers.

| Gate clause                                          | State       | Evidence                                                                                                     |
| ---------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| Adopt, fork on the first turn, resume the fork after | implemented | "THE GATE: is adopted as a pinned thread, forked on its first turn, and resumed after" (core integration)    |
| List a folder's sessions through its node            | implemented | "lists a shared folder's sessions through the node that holds it"; `files.test.ts` session.list cases        |
| Each runtime lists and forks                         | implemented | `claude.test.ts`, `codex.test.ts`; live listing on the home PC                                               |
| Conversations beside free chat, by last activity     | implemented | "THE GATE: the owner opens new conversations beside free chat..." (core integration)                         |
| From the phone: continue a session, open a new one   | implemented | E2E phone "THE GATE: continues a session started outside Noctis, from the phone", "opens a new conversation" |

Red first: each test above failed on the missing behaviour before passing; the two E2E tests failed
on "Conversations is not reachable with the Tab key".

Also fixed: `attachments.test.ts` counted the shared temp directory and raced other suites; it now
stages into a base of its own.

#### Known, not fixed

- **An adopted thread starts with no history on the page.** The agent has the whole session; Noctis
  shows only what is said from here on.
- **The fork does not show in VS Code's session picker.** It is an SDK (Claude) or app-server
  (Codex) session, which the IDE pickers hide. `claude --resume <id>` from a terminal reaches it.
- **No rename, archive or delete** for conversations; an untitled one is named by its newest line.
- **A real fork has not been run live.** Listing was checked live; forking a real session costs a
  subscription turn and was left for the owner.

| Command                                                      | Result                                         |
| ------------------------------------------------------------ | ---------------------------------------------- |
| `npx vitest run packages apps/core apps/node-agent apps/web` | exit 0; 113 files, 1983 tests (before the web) |
| `npx vitest run apps/web apps/node-agent packages`           | exit 0; 80 files, 1465 tests                   |
| `node --test apps/web/e2e/{phone,chat,files}.test.mjs`       | exit 0; 12 tests                               |
| `npm run typecheck`, lint (changed packages), `format:check` | exit 0                                         |

### 2026-10-08 History for adopted sessions, tidier conversations, and S3

The owner's list for the evening, in order, on the home PC (`zarrarpc`). Commits `99e5ed8`
(history), `3d62420` (rename and archive), `f14e39d` (local runtime), `57e84dd` (scrolling and the
Approvals count), `03c92dc` (fixes from a Codex review), `64938c6` (Hermes runtime).

- **History before Noctis.** Node capability `session.history`, covered by a `runtime.turn` grant.
  Claude: the Agent SDK's `getSessionMessages` in that folder's store, kept to the prompts the owner
  typed (not tool results, IDE notes, task notices or interruptions) and the reply each ended on.
  Codex: `thread/read` refuses a thread kept for another folder, then `thread/turns/list` in its
  `summary` view gives each turn's prompt and final reply without loading the thread. The last 10
  exchanges, clipped and trimmed to fit one 64 KiB result frame. Migration 0012 keeps the ref a
  thread adopted, because its first turn moves it onto a fork whose transcript also holds Noctis's
  own turns. `GET /threads/:id/history`; Threads shows the exchanges under "Before Noctis", dashed
  and apart from the thread's own messages. Checked on real sessions here: 2 Claude and 5 Codex
  exchanges read from the hyperframes folder.
- **Rename and archive.** `conversation.rename_thread` and `conversation.archive_thread`
  (`archived: true | false`, so restoring is the same command), named threads only; free chat is
  refused as not found. Migration 0013 adds `archived_at`; `GET /conversations?archived=1`. The
  list has Rename and Archive beside each named row, and Show archived with Restore.
- **S3.** See the scope doc's S3 result. LM Studio's daemon (`llmster` 0.0.25, SHA-512 checked;
  the binary is unsigned) and Qwen3.5-9B Q4_K_M; Hermes Agent 0.21.6 by its own installer, which
  pins a SHA-256 for every download. Smart App Control let both run. Neither added anything to
  startup (Run keys, Startup folder and scheduled tasks compared before and after). The server
  listens on 127.0.0.1 only.
- **Threads and Approvals.** Threads follows a growing conversation only if the owner was at its
  end as it stood at the previous update (within 80 px); sending or opening another thread follows
  again. The Approvals tab and rail item show how many wait, by the page's own rule, re-read on
  every authority event.
- **Codex review.** Codex read the day's diff and found six real issues, fixed in `03c92dc`. One
  more was not fixed: a 20,000-character reply of control characters escapes past the 64 KiB frame.
  That cap is shared with Claude and Codex and wants one shared fix. Codex's suggested backfill for
  migration 0012 was declined: 0011 and 0012 deploy together, so no database has a thread adopted
  before 0012. Codex's Windows sandbox could not start a shell (`helper_unknown_error`), so the diff
  was passed inline.

| Gate clause                                                   | State       | Evidence                                                                                                                            |
| ------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| An adopted thread shows its history, read from the original   | implemented | "THE GATE: shows what was said before Noctis, read from the adopted session even after the fork"                                    |
| Each runtime reads its own history, and only its folder's     | implemented | `claude.test.ts`, `codex.test.ts` (refuses another folder's thread), `files.test.ts` session.history                                |
| From the phone, an adopted session shows its earlier exchange | implemented | E2E phone "THE GATE: continues a session started outside Noctis, from the phone"                                                    |
| Rename, archive, restore; free chat refused                   | implemented | "renames a conversation, archives it off the list, and restores it"; E2E phone, same name                                           |
| A thread runs on the local model, costed local                | implemented | "THE GATE (S3): ... delegates to it and to Hermes"; `local.test.ts`                                                                 |
| Claude's turn delegates to `local` and to `hermes`            | implemented | the same gate                                                                                                                       |
| Hermes resumes, streams, asks, cancels                        | implemented | `hermes.test.ts`                                                                                                                    |
| Live: Hermes on Qwen3.5-9B, an ask declined                   | implemented | Home PC: first turn 31 s cold, resumed turn 3 s; a recursive delete arrived as a `destructive` ask, was declined, the folder stayed |
| From the phone, a thread on Hermes and a delegation           | not yet     | Needs the work PC's core redeployed and `-ShareWithLocal` run (owner steps)                                                         |
| Threads holds its place; the Approvals tab counts             | implemented | E2E phone "holds its place while the owner reads back...", "keeps both answers..." (badge)                                          |

Red first: every test above failed on the missing behaviour before passing. For the S3 core gate,
which passed on its first run because the contract change had already landed, red was shown by
stashing `local` out of `RUNTIME_PROVIDERS`: the send answered 500.

#### Known, not fixed

- **Hermes has no sandbox**, lists hosted models it finds credentials for, and needs LM Studio up
  before the node starts; the card is nearly full at 64K context (scope doc 8.4).
- **History is read each time an adopted thread opens.** Nothing is cached; a Codex read starts an
  app-server for the purpose (about 1 to 2 s).
- **An archived conversation stays archived when a message is sent to it** from the archive view.
- **An invalid grant answers 500**, not 400 (seen while showing the S3 gate red).

| Command                                                                      | Result                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| `npx vitest run` (every unit and integration suite)                          | exit 0; 116 files, 2016 tests                        |
| `node --test apps/web/e2e/phone.test.mjs` (run 3 times after the scroll fix) | exit 0; 10 tests each run                            |
| `node --test apps/web/e2e/{approval.keyboard,chat,files}.test.mjs`           | exit 0; 2 + 3 + 1 tests                              |
| `npm run typecheck`, `npx eslint .`, `npx prettier --check .`                | exit 0 (lint: `files.test.mjs` now imports `Buffer`) |
| full `test:e2e` and the remaining browser suites                             | not run here; handed to the owner                    |

### 2026-10-08 Jester on Hermes (ADR-0030)

On the home PC (`zarrarpc`), the same night as S3. Commits `2e3f8e6`, `c1ea808`, `8363c96`,
`6741461`, `59bcc7c`, `26efe08`, `66cb475`, `63d7e59`, `2f6cc24`, `73c7e49`. Nothing deployed.

- **The owner's picks** (from Codex's stills in `docs/design/assets/jester/`): core variant C,
  "hidden grin"; the cap glyph; a Vesper/Jester switch plus the typed commands; Jester on Hermes
  alone, chosen automatically.
- **ADR-0030 on the node.** Noctis's Hermes home turns off Hermes's memory and user profile, the
  background review that writes memories and skills, the skill nudge, and the `memory`,
  `session_search` and `cronjob` toolsets (ACP already left out `cronjob_manage`). Each Hermes
  session gets the node's `noctis` MCP server through ACP, with a proposals file per thread, as
  Codex has it. A Jester turn runs on its own home (`<node home>\hermes-jester`) whose `SOUL.md`
  says who Jester is; Hermes's ACP sessions ignore `display.personality`, so the soul is the
  route, and Vesper's Hermes stays plain. Every Hermes turn asks the local model server first and
  refuses at once ("LM Studio is not running...") when it is down; nothing else carries it.
- **Skills.** Hermes cannot switch off `skill_manage` alone. Read as "Noctis only reads Hermes's
  skills"; the self-nudge and review that would write them unasked are off. `GET /skills` is not
  built.
- **Core.** A Jester turn with no model takes the thread's last Hermes model, else a Hermes
  default, else the first Hermes model a connected node offers (`modelFor`). Naming any other
  agent, the plain `local` one included, is refused as `jester_runs_on_hermes`. `local_only`
  routing for Jester was already there and covers its delegated children.
- **Core look.** `core.ts` holds the profile (`JESTER_PROFILE`, `profileFor`), per-state `face`
  and `fault` levels, and deterministic marks: two fault lines along the cage's own edges, an
  11-point grin, the eyes, drips. Codex wrote the renderer to `docs/handoffs/jester-renderer.md`
  against tests written first; Claude reviewed it, moved the fault drips into the spinning
  network, and turned the faults, drips and grin into chains of point lights, because WebGL lines
  are one pixel wide and the first render was too faint to read. Vesper's core is unchanged.
- **Web.** The switch sits above the box on Presence and Threads; exactly `JESTER` or `VESPER`
  alone switches instead of sending; switching leaves a conversation that belongs to the other
  identity. Jester's picker offers Hermes alone, and says "Jester needs Hermes and LM Studio on a
  connected PC" when there is none. Presence shows `JESTER · ACTIVE` with the cap.
- **Codex.** Drew the stills (its home-PC design session `01a11d61...`), wrote the renderer, and
  reviewed the diff. Its sandbox still cannot read files here, so everything went in on stdin;
  the `codex` skill now says so.

| Gate clause                                                       | State       | Evidence                                                                                |
| ----------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| Hermes keeps no memory and schedules nothing                      | implemented | `hermes.test.ts` "keeps no memory and schedules nothing"                                |
| Hermes gets the Noctis MCP tools; their proposals come back       | implemented | `hermes.test.ts` "attaches the Noctis MCP tools..."                                     |
| Jester speaks as itself on its own home; Vesper's Hermes is plain | implemented | `hermes.test.ts` "speaks as Jester on Jester's own Hermes home..."                      |
| Unavailable, not cloud-backed, when LM Studio is down             | implemented | `hermes.test.ts` "refuses at once..." (no process spawned)                              |
| Jester runs on Hermes alone, chosen automatically                 | implemented | `conversation.integration.test.ts` "Jester runs on Hermes alone (ADR-0030)..."          |
| Jester's core: faults at rest, face thinking and speaking, amber  | implemented | `core.test.ts`, `renderer.test.ts`; screenshots `docs/design/assets/jester/live/`       |
| Switch from Presence, typed commands, Hermes-only picker          | implemented | E2E "THE GATE (Jester)..." (`apps/web/e2e/jester.test.mjs`), desktop and phone          |
| Live: a Jester thread on Hermes from the phone                    | not yet     | Needs the work PC's core redeployed and the home node restarted (owner steps, deferred) |

Red first: each node, core and unit test above failed on the missing behaviour; the E2E gate was
shown red by stashing the web wiring (no Jester button), then green.

| Command                                                                                                                                                          | Result                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `npx vitest run` on `hermes`, `runtimes/index`, `conversation.integration`, `headless`, `objectives`, `packages/ui/src/intelligence`, `profiles`, `apps/web/src` | exit 0                        |
| `node --test apps/web/e2e/{presence,chat,phone,jester}.test.mjs`                                                                                                 | exit 0 after the 44px fix     |
| `npm run typecheck`, `npx eslint` and `npx prettier --check` on the changed files                                                                                | exit 0                        |
| the full sweep (`npx vitest run`, `npm run test:e2e`, which now includes `jester.test.mjs`)                                                                      | not run here; owner, deferred |

#### Known, not fixed

- **The config race** noted in `hermes.ts` now also covers two Jester threads opening on
  different models at the same moment.
- **Jester's home prepares Hermes's dependencies on its first turn** (Hermes does this per data
  root), so the first Jester turn on a PC is slower than later ones.
- **Jester's voice is a SOUL.md.** Qwen3.5-9B may not hold it; judge it live.
- **A Jester default set to another agent before this change** is ignored rather than cleared.
