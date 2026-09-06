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
