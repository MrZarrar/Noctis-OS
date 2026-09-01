# Noctis OS Phase 1 — authoritative foundation design

**Date:** 2026-09-01
**Phase:** 1 — contracts, state machines, migrations, and event envelope
**Depends on:** Phase 0 (accepted 2026-08-23)
**Plan reference:** [master implementation plan](../../architecture/2026-08-23-noctis-os-master-implementation-plan.md), Section 3, Section 4, and Phase 1

## 1. Outcome and gate

All later components compile against one validated contract language and one deterministic transition
model. No feature UI beyond diagnostics.

The phase is accepted when all four gate conditions hold:

1. Migrations are idempotent on empty and populated fixtures.
2. Malformed model, worker, and API data is rejected.
3. All transition matrices pass.
4. Rollback leaves no partial rows or events.

## 2. Locked decisions

These four decisions were taken during design and are binding for Phase 1 and after. The plan's
authority order places direct user decisions above the master plan, so where a decision below differs
from the plan text, the decision governs and the difference is stated explicitly.

### D1 — Scope is the named transition machines and their tables

Phase 1 implements every Phase 1 _mechanism_, the five transition machines the Phase 1 task list names
(Objective, Mission, Surface, node-job, NOIR), and the 26 tables those require (Section 6).

Deferred, with no Phase 1, 2, or 3 consumer and no transition machine to exercise them:

| Deferred                                                                                          | Target phase | Reason                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------ |
| `vault_items`, `vault_entities`, `vault_edges`, `vault_mentions`, `vault_layout`, `vault_recalls` | 7            | Vault port owns their shape; no Phase 1 consumer or transitions          |
| `provider_decisions`                                                                              | 2 / 8        | Provider routing is defined by the phase that registers provider classes |

This is a narrower reading than Section 4.1's full table list, and a deliberate one: freezing a schema
before its consumer exists invites a reshape in the phase that finally uses it. Every one of the four
gate conditions is provable without the deferred tables.

### D2 — `node:sqlite` now, better-sqlite3 qualified in Phase 3

`apps/core/src/db/connection.ts` wraps Node's built-in `node:sqlite`.

Rationale: `node:sqlite` ships inside the signed Node binary, so it introduces no native module, no
`node-gyp` compile, and no unsigned `.node` artifact. This matters concretely — the development machine
enforces Smart App Control, which already blocked an unsigned generated build-script executable during
Phase 0 (OS error 4551). A native SQLite binding is the same class of risk.

The plan names better-sqlite3 in Phase 3 and requires it to be _qualified on each supported Windows
environment_. That task is unchanged and stays in Phase 3. Because the driver sits behind
`connection.ts`, adopting better-sqlite3 later is a single-file change.

Verified against `node:sqlite` before this spec was written (throwaway probe, not retained):

| Mechanism                                        | Result                         |
| ------------------------------------------------ | ------------------------------ |
| `PRAGMA foreign_keys = ON` readable and enforced | pass                           |
| Atomic state + event commit                      | pass                           |
| Injected failure between state and event write   | 0 state rows, 0 event rows     |
| `AUTOINCREMENT` global sequence monotonic        | pass                           |
| Migration + ledger row in one transaction        | pass                           |
| Re-running an applied migration                  | applies nothing                |
| Edited migration (checksum mismatch)             | refused                        |
| Failed migration                                 | no ledger row, no leaked table |

### D3 — IDs are UUIDv7 from the `uuid` package

`uuid@14` provides RFC 9562 UUIDv7. Record IDs are UUIDv7 strings; they are lexically sortable and can
be generated offline on a Phase 3 node with no database access.

The plan requires an injected clock. `uuid`'s `v7()` accepts `{ msecs, seq, random }`, so the injected
clock drives it natively with no wrapper. Verified:

- `v7({ msecs, seq, random })` is byte-for-byte deterministic for identical inputs.
- Increasing `seq` within one millisecond produces strictly ascending IDs.
- An ID at `msecs` sorts before an ID at `msecs + 1`.

`packages/domain/src/ids.ts` exposes an `IdFactory` that takes a `Clock`, supplies `msecs` from it, and
maintains the intra-millisecond `seq` counter.

### D4 — Refusals are a `Result` union, not exceptions

Pure domain functions return a discriminated union rather than throwing.

```ts
export type Result<T> = { ok: true; value: T } | { ok: false; conflict: DomainConflict };

export type DomainConflict =
  | { kind: "forbidden_transition"; machine: string; from: string; to: string }
  | { kind: "revision_conflict"; expected: number; actual: number }
  | { kind: "idempotent_replay"; key: string; existingId: string };
```

Three Phase 1 requirements — forbidden transitions, revision conflicts, and idempotency replays — share
one shape: an expected refusal that must produce no event. One representation covers all three.

This matches the plan's wording that forbidden transitions "return a typed conflict and emit no event",
and it makes gate condition 4 structural: on a refusal the event-append call is unreachable, so no
partial write is possible by construction rather than by remembering to catch.

The existing `packages/domain/src/state/objective-status.ts` throws today and is rewritten to this
convention, along with its test. This happens now, before four further machines copy the old shape.

## 3. Contracts — `packages/contracts/src/`

Zod schemas are the runtime authority; TypeScript types are inferred from them. Every schema is
`.strict()` so unknown fields fail closed. API input, WebSocket frames, persisted JSON, model output,
worker messages, and adapter observations all parse through these same schemas.

| File            | Contents                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `primitives.ts` | `UtcTimestamp`, `Uuid`, `Revision`, `IdempotencyKey`, `SchemaVersion`                                  |
| `enums.ts`      | identity, protocol, attention state, all statuses, Surface role/persistence/lifecycle, operation class |
| `objective.ts`  | `ObjectiveRecord`, `ObjectiveStatus`, objective links (exists; refactored onto `primitives.ts`)        |
| `mission.ts`    | `MissionRecord`, `MissionStep`, `MissionEvidence`, `MissionStatus`                                     |
| `surface.ts`    | `SurfaceIntent`, `SurfaceOverride`, `CompositionPlan`, `SurfaceLifecycle`                              |
| `node.ts`       | `NodeDescriptor`, `CapabilityGrant`, `NodeJob`, node-job status                                        |
| `noir.ts`       | `NoirCase`, `Hypothesis`, `EvidenceItem`, `Falsifier`, `Uncertainty`                                   |
| `authority.ts`  | `AuthorityRequest`, `AuthorityDecision`, `StandingPermission`                                          |
| `identity.ts`   | `IdentityProfile`, `ConversationThread`, `IdentityMessage`                                             |
| `artifact.ts`   | `ArtifactRecord`                                                                                       |
| `source.ts`     | `SourceRecord`, `SourceObservation`                                                                    |
| `events.ts`     | `OrchestrationEvent` envelope and the versioned event-name registry                                    |
| `ws.ts`         | client and server WebSocket envelopes (schema only; no transport in this phase)                        |

Shared scalars move into `primitives.ts` so `objective.ts` stops declaring its timestamp and identifier
rules inline and every aggregate validates them identically.

### Event-name registry

Event names are a frozen union in `events.ts`, carrying the version suffix the plan reserves
(`objective.created.v1`, `mission.dispatched.v1`, `noir.evidence_linked.v1`, and so on). An unrecognised
name or version fails to parse. This satisfies the contract rule that unknown enum members and event
versions fail closed.

### Contract rules enforced in this phase

- IDs are UUIDv7 (D3).
- Timestamps are UTC ISO 8601; local time exists only at presentation boundaries.
- Every mutation uses an optimistic revision check or an idempotency key.
- Unknown enum members and event versions fail closed.
- Persisted JSON carries a schema version.
- Model-generated payloads are untrusted and are parsed before use.

## 4. Domain — `packages/domain/src/`

| File                         | Contents                                                            |
| ---------------------------- | ------------------------------------------------------------------- |
| `result.ts`                  | `Result<T>`, `DomainConflict`, and `ok` / `conflict` constructors   |
| `clock.ts`                   | `Clock` interface, `systemClock`, `fixedClock(ms)` for tests        |
| `ids.ts`                     | `IdFactory` — injected `Clock` plus intra-millisecond `seq` counter |
| `revision.ts`                | optimistic revision check returning `Result`                        |
| `state/transition.ts`        | `defineTransition(machine, table)`                                  |
| `state/objective-status.ts`  | Objective machine (rewritten to `Result`)                           |
| `state/mission-status.ts`    | Mission machine                                                     |
| `state/surface-lifecycle.ts` | Surface machine                                                     |
| `state/node-job-status.ts`   | node-job machine                                                    |
| `state/noir-case-status.ts`  | NOIR case machine                                                   |

`defineTransition` is roughly ten lines that turn an allowed-transition table into a function returning
`Result`. It is introduced with five real call sites, not speculatively: it removes the same lookup and
the same conflict construction repeated five times, and it makes every machine a declarative table that
tests can enumerate exhaustively.

Transition edges for all five machines, transcribed directly from `packages/domain/src/state/*.ts` so
this table and the code cannot drift. The node-job machine has no Section 4.2 sketch at all — Phase 1
defines it from the lease, cancellation, and expiry behaviour the plan requires of Phase 3 ("job leases,
cancellation, bounded progress", and tests for "expired lease, duplicate job, revoked node").

| Machine   | From              | Allowed to                            |
| --------- | ----------------- | ------------------------------------- |
| Objective | suggested         | draft, abandoned                      |
| Objective | draft             | active, abandoned                     |
| Objective | active            | paused, completed, abandoned          |
| Objective | paused            | active, completed, abandoned          |
| Objective | completed         | (terminal)                            |
| Objective | abandoned         | (terminal)                            |
| Mission   | draft             | awaiting_approval, cancelled          |
| Mission   | awaiting_approval | queued, cancelled                     |
| Mission   | queued            | running, cancelled                    |
| Mission   | running           | succeeded, failed, blocked, cancelled |
| Mission   | blocked           | running, cancelled                    |
| Mission   | succeeded         | (terminal)                            |
| Mission   | failed            | (terminal)                            |
| Mission   | cancelled         | (terminal)                            |
| Surface   | proposed          | entering, dismissed                   |
| Surface   | entering          | active, dismissed                     |
| Surface   | active            | background, exiting                   |
| Surface   | background        | active, exiting                       |
| Surface   | exiting           | dismissed                             |
| Surface   | dismissed         | (terminal)                            |
| node-job  | queued            | leased, cancelled                     |
| node-job  | leased            | running, expired, cancelled           |
| node-job  | running           | succeeded, failed, expired, cancelled |
| node-job  | expired           | queued, cancelled                     |
| node-job  | succeeded         | (terminal)                            |
| node-job  | failed            | (terminal)                            |
| node-job  | cancelled         | (terminal)                            |
| NOIR case | forming           | investigating, abandoned              |
| NOIR case | investigating     | synthesising, blocked, abandoned      |
| NOIR case | synthesising      | resolved, blocked, abandoned          |
| NOIR case | blocked           | investigating, abandoned              |
| NOIR case | resolved          | (terminal)                            |
| NOIR case | abandoned         | (terminal)                            |

These edge lists are authoritative for Phase 1 and supersede the sketch diagrams in the master
implementation plan's Section 4.2 for the purpose of implementation. Those diagrams are illustrative: the
NOIR sketch draws no outgoing edge from `blocked`, which would make it a permanent trap state, so they
cannot be read as exhaustive. Where an edge appears here but not in the sketch, it is deliberate and
listed below with its reason.

### Edges added beyond the Section 4.2 sketches

- Objective `active -> completed` — active work must be completable without first pausing.
- Surface `active -> exiting` — closing a focused surface is the normal path, not an exception.
- Mission `running -> cancelled` — in-flight work must be cancellable.
- Mission `blocked -> cancelled` — a stuck mission must be abandonable.
- node-job `running -> expired` — a lease is most often lost during execution; without this a job whose
  worker dies is stranded in `running` forever.
- NOIR `investigating -> blocked` — an investigation can block on missing evidence.
- NOIR `synthesising -> abandoned` — synthesis can be abandoned.
- NOIR `blocked -> abandoned` — without it a blocked case is near-trapped.

## 5. Persistence — `apps/core/src/db/`

### `connection.ts`

Opens a `DatabaseSync` handle and applies the pragmas the design depends on: `foreign_keys = ON`,
`journal_mode = WAL`, and a `busy_timeout`. This is the only file that names the driver, which is what
keeps D2 reversible.

### `migrate.ts`

Migrations are `apps/core/migrations/NNNN_name.sql`, read at startup and SHA-256 checksummed.

- Each unapplied version and its `schema_migrations` row commit inside **one** transaction.
- Re-running applies nothing.
- Startup refuses when the database records a version newer than any known migration file — the plan's
  requirement that the application refuse to start against an unknown newer schema.
- Startup refuses when a recorded checksum differs from the file's current checksum, which catches an
  edited migration that has already been applied.
- A migration that fails mid-way leaves no ledger row and no partially created objects.

### `transactions.ts`

The atomic state-plus-event mechanism, and the reason gate condition 4 holds:

```ts
db.exec("BEGIN IMMEDIATE");
try {
  const outcome = mutate(tx); // returns Result<T> plus events to append
  if (!outcome.ok) {
    db.exec("ROLLBACK");
    return outcome; // refusal: no state row, no event row
  }
  appendEvents(tx, outcome.events); // sequence assigned here, inside the transaction
  db.exec("COMMIT");
  return outcome;
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
```

Because a refusal is a `Result` rather than a thrown exception, the `appendEvents` call is unreachable
on the refusal path. Partial writes are prevented by control flow, not by convention.

### `events.ts`

Appends to `orchestration_events`, assigning the global sequence inside the write transaction, and
exposes the post-commit delivery seam. Committed events are returned to the caller, which publishes them
only after `COMMIT` returns. Phase 1 provides the seam; Phase 2 wires it to `/ws/clients`.

Sequences are monotonic. They are **not** promised to be gapless, and no consumer may assume contiguity.

Delivery is at-least-once and reducers must be idempotent. Exactly-once delivery is not offered.

### Idempotency

A single `idempotency_keys` table is consulted and written inside the same transaction as the mutation
it guards. A hit returns an `idempotent_replay` conflict carrying the existing record's ID so the
caller can return the original result rather than performing the work twice.

## 6. Tables

Twenty-six tables: the 25 Section 4.1 tables remaining in scope after D1's deferrals, plus
`idempotency_keys`, which Section 4.1 does not list but which the plan's requirement for "unique
idempotency constraints" needs.

`schema_migrations`, `objectives`, `objective_links`, `missions`, `mission_steps`, `mission_evidence`,
`approvals`, `standing_permissions`, `surface_intents`, `surface_overrides`, `composition_snapshots`,
`orchestration_events`, `identity_threads`, `identity_messages`, `nodes`, `node_capabilities`,
`node_jobs`, `artifacts`, `sources`, `source_observations`, `noir_cases`, `noir_hypotheses`,
`noir_evidence`, `noir_falsifiers`, `runtime_kv`, `idempotency_keys`.

All arrive in one migration, `0001_foundation.sql`.

Required constraints and indexes:

- Foreign keys between every child and its parent aggregate.
- A unique constraint on the idempotency key.
- Indexes on active objectives, pending approvals, node leases, the global event sequence, source
  freshness, and NOIR case membership.

Secrets are never stored in SQLite JSON. They live in the OS credential store or a machine-local
protected file reached only by the Rust shell or core process. Logs redact tokens, prompts marked
private, credential paths, and sensitive source payloads.

## 7. Testing

Table-driven tests, matching the existing `objective-status.test.ts` style.

| Area            | Tests                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transitions     | Every allowed and every forbidden pair for all five machines, asserting the refusal is a `forbidden_transition` conflict and no value is produced |
| Malformed input | Each schema rejects unknown fields, wrong types, invalid enum members, and non-ISO timestamps                                                     |
| Events          | Unknown event name and unknown version both fail to parse                                                                                         |
| IDs             | Monotonic within a millisecond and across the boundary; byte-deterministic under a fixed clock and fixed random                                   |
| Revisions       | Stale revision produces a `revision_conflict` and writes nothing                                                                                  |
| Idempotency     | A replayed key returns the original ID and performs no second write                                                                               |
| Migrations      | Idempotent on empty and on populated fixtures; unknown newer version refused; checksum mismatch refused; failed migration leaves no ledger row    |
| Atomicity       | An injected failure between the state write and the event append leaves zero rows in **both** tables                                              |

The atomicity and migration tests are the direct evidence for gate conditions 1 and 4 and are not
optional.

## 8. Open question to resolve first — RESOLVED

**Node 22.23.2 has `node:sqlite` unflagged; no flag is required.**

Confirmed in CI on the `javascript` job of run
[33453626520](https://github.com/MrZarrar/Noctis-OS/actions/runs/33453626520) (job
`99688791844`), running `node: v22.23.2`. `apps/core/src/db/sqlite-availability.test.ts` opened an
in-memory `DatabaseSync`, round-tripped a row, and passed; the only output was a
`(node:8) ExperimentalWarning: SQLite is an experimental feature and might change at any time`, not an
error. No `NODE_OPTIONS` / `--experimental-sqlite` flag is needed in CI, in local shells, or in any later
task's scripts.

A second, non-blocking observation: local Node 24.19.0 does not exercise the pinned 22.x runtime, so
local green results do not prove the pinned runtime. CI remains the authority for Node 22 behaviour.

## 9. Non-goals

Explicitly out of scope for Phase 1, each owned by a later phase:

- HTTP product services, REST commands, and WebSocket transport (Phase 2)
- Provider registration and model routing (Phase 2 / 8)
- Node pairing, leases, and the node agent runtime (Phase 3)
- Vault tables, indexing, and recall (Phase 7)
- Any user interface beyond diagnostics (Phase 5 onward)

## 10. Rollback

Revert the Phase 1 commits and recreate the disposable development database. No donor repository change
is involved, and no production data exists at this phase.
