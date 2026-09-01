# Architecture decisions

## ADR-0001: Independent sibling repository

**Decision:** Build Noctis in `Noctis-OS`, not in the Jarvis repository.

**Reason:** The product is a new system even though selected proven behaviour may be ported. This
keeps implementation, runtime data, releases, and cutover independently reversible.

## ADR-0002: Jarvis is a donor, not a parallel product

**Decision:** Preserve the repository as historical source, while retiring the Jarvis runtime after
Noctis production acceptance and the bounded rollback window.

## ADR-0003: Compatible TypeScript toolchain

**Decision:** Pin TypeScript 6.0.3 rather than 7.0.2 at bootstrap.

**Reason:** `typescript-eslint` 8.67.0 declares support for TypeScript versions below 6.1. Forcing
TypeScript 7 would create an unsupported dependency tree. Revisit after the lint toolchain officially
supports TypeScript 7.

## ADR-0004: Deterministic relational state plus audit events

**Decision:** Use relational operational state and transactionally appended audit events. Do not use
full event sourcing.

## ADR-0005: Consequential behavior is deterministic

**Decision:** Models may propose schema-validated semantic intent. Deterministic code controls
authority, layout, routing, lifecycle, restore, and physical window placement.

## ADR-0006: Transition edge lists are explicit, not diagram-derived

**Decision:** Phase 1 defines a complete, explicit edge list for each of the five transition machines in
the domain design spec. The master implementation plan's Section 4.2 ASCII diagrams are illustrative
only and are superseded by those edge lists for implementation purposes.

**Reason:** The Section 4.2 diagrams are sketches, not exhaustive edge lists. The NOIR sketch draws zero
outgoing edges from `blocked`, which would make `blocked` a permanent trap state — a design no phase
intends. A diagram demonstrably incomplete in one machine cannot be read as exhaustive for the others.
Eight edges go beyond the sketches; they are named, with their individual justification, in
`docs/superpowers/specs/2026-09-01-noctis-phase-1-foundation-design.md`, Section 4, "Edges added beyond
the Section 4.2 sketches." This decision was taken over a reviewer's Critical findings on the added
edges and is recorded here so it is not silently reopened.

## ADR-0007: `ws` is the client socket dependency

**Decision:** Add `ws` 8.21.3 as the only new runtime dependency for Phase 2. Serve HTTP from
`node:http` with no framework.

**Reason:** Node 22 ships a WebSocket _client_ but no server. The alternative is hand-writing RFC 6455
framing — masking, fragmentation, close codes, ping/pong — which is roughly 200 lines of protocol code
that has to be correct against every client and would need its own test suite. `ws` is zero-dependency
and the de-facto implementation. HTTP needs no such argument: `node:http` plus a path switch covers a
handful of command endpoints, so no framework was added.

## ADR-0008: Every command carries an idempotency key, claimed inside the transaction

**Decision:** `idempotencyKey` is a required field on every command schema, and `runCommand` in
`apps/core/src/kernel.ts` claims it inside the same transaction as the write, before the mutation runs.
A replayed key returns the original result rather than an error.

**Reason:** Phase 1 removed the global per-table `UNIQUE (idempotency_key)` constraints and left
`claimIdempotencyKey` as the single enforcement point, guarded only by prose. Making the claim part of
`runCommand`'s signature means a service physically cannot commit without claiming first: `tx` is only
reachable inside the callback the claim precedes. `apps/core/src/kernel.test.ts` — "issues every write
in %s on the transaction handle runCommand supplies" — is the mechanical check, verified by sabotage.

## ADR-0009: Phase 2 additions to the Phase 1 contract vocabulary

**Decision:** Reserve the event name `mission.status_changed.v1` and the stream type `authority`. Treat
Objective activation as the `active` case of one `objective.change_status` command rather than a
separate `objective.activate` command.

**Reason:** Both additions are additive, so every Phase 1 event still parses. `mission.status_changed.v1`
exists because Phase 1 named events only for `approval_requested`, `dispatched`, and `verified`; forcing
a `failed` or `blocked` transition into one of those would make the audit log say something untrue. The
`authority` stream type exists because a decision may reference an Objective, a Mission, both, or
neither, so filing it under either misdescribes the other cases. One status-change command means one
place the transition table is consulted; the audit stream still distinguishes activation by event name.

## ADR-0010: Phase 2 scope boundary

**Decision:** Phase 2 delivers config, API, events, objectives, missions, authority, and providers. The
`sources/` and `artifacts/` directories named in the master plan's Phase 2 "Create" list are deferred to
Phase 8. Request rate limiting is deferred to Phase 4.

**Reason:** No Phase 2 task or gate criterion exercises sources or artifacts, and Phase 8 is titled
"Full authority, sources, artifacts, and approval UI" — building empty services now would be scaffolding
for a phase that will redesign them. Rate limiting mitigates token brute-force, which against a loopback
bind, a 256-bit token, and a constant-time comparison is not a live risk; Phase 4 introduces the Tauri
proxy and Tailscale Serve path where it becomes one.
