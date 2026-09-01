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
