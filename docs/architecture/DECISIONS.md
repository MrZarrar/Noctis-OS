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

## ADR-0011: Node credentials are derived, not stored

**Decision:** A node's connection credential is `HMAC-SHA256(NOCTIS_CORE_TOKEN, "noctis.node.credential.v1:<nodeId>:<generation>")`.
The database stores only `nodes.credential_generation`, an integer. The core recomputes the credential
whenever it needs to verify a connection or sign a job, accepts the current generation and the one
before it, and rotates by incrementing the counter on every connection. The same derived value is the
HMAC key for job assignment signatures.

**Reason:** `migrations/0001_foundation.sql` states "No secrets are stored in this database", which rules
out a random per-node secret. A digest satisfies the rule but cannot sign anything, and Section 10 step 4
requires the node to validate a job's signature — so the core needs a value it can reproduce, not merely
compare. Deriving it gives verification, signing, and rotation from one integer, and the only copy at
rest lives in the node agent's own credential file on its own machine. The two-generation window exists
because the core commits a rotation before the agent has persisted it: without it, an agent that died in
that gap could never reconnect and would need an operator to cut a fresh pairing code. The coupling this
introduces is recorded in the source: rotating `NOCTIS_CORE_TOKEN` invalidates every node credential at
once and every node must re-pair.

## ADR-0012: `leased -> succeeded` and `leased -> failed` are node-job edges

**Decision:** Add both edges to `transitionNodeJobStatus`. `running` stays in the machine.

**Reason:** `running` is a state only the node can observe. Phase 3's three adapters are single
round-trip and report no start, so requiring `running` before an outcome would make the core write a
transition it never witnessed — the same objection ADR-0009 raised against forcing a failed Mission
transition into `mission.verified.v1`. `running` remains for the long-running jobs of later phases,
which do stream a start. This is an edit to a Phase 1 matrix, so it is recorded here rather than made
quietly; `packages/domain/src/state/node-job-status.test.ts` enumerates the full cross-product against a
hand-written edge list, and that list was updated alongside the table rather than derived from it.

## ADR-0013: Phase 3 additions to the contract vocabulary

**Decision:** Reserve the event names `node.paired.v1`, `node.status_changed.v1`,
`node.capability_granted.v1`, `node.job_queued.v1`, and `node.job_status_changed.v1`; the stream type
`node_job`; and a node envelope version (`NODE_ENVELOPE_VERSION`) separate from the client envelope.

**Reason:** All additive, so every Phase 1 and Phase 2 event still parses. `node.status_changed.v1`
follows the `mission.status_changed.v1` precedent rather than inventing a name per status.
`node_job` exists because a queued job has no node yet: keying job events by a job id under the `node`
stream type would make "read the stream for node X" return rows that are not about node X, which is the
same argument that gave authority decisions their own stream in ADR-0009. The envelope versions are
separate because `/ws/clients` and `/ws/nodes` are not one protocol, and bumping one must not force a
lockstep change in the other.

## ADR-0014: Phase 3 scope boundary

**Decision:** Phase 3 delivers pairing, credentials, the node realm, capability grants, job leases,
routing, three deterministic adapters, and the node agent. Two named items are not built as written:
request rate limiting stays deferred (ADR-0010), and `better-sqlite3` is not qualified.

**Reason:** The Phase 3 task "Qualify Node 22 and `better-sqlite3` on each supported Windows
environment" is moot as written. Phase 1 chose the built-in `node:sqlite` behind the driver seam in
`apps/core/src/db/connection.ts`, `better-sqlite3` is not a dependency of this repository, and the node
agent needs no database at all — its only persistent state is a credential file. The task reduces to
qualifying Node 22, which CI does on the pinned runtime. If a later phase adopts `better-sqlite3`, the
seam and `inTransaction` already exist for it and the qualification belongs to that phase.

## ADR-0015: The shell holds the client socket; the browser transport polls

**Decision:** `TauriTransport` receives events pushed from Rust, which holds `/ws/clients` itself.
`BrowserTransport` receives the same events by polling `GET /events?after=` behind the same interface.

**Reason:** The client realm authenticates with an `Authorization` header, and a browser `WebSocket`
cannot send one. That leaves three options: poll in both transports, change the core to accept a
credential a browser can present, or let the two transports differ. Adding a second
credential-presentation path to the client realm for a development-only page is the worst of the
three: it widens the surface Phase 3 spent its sabotage budget hardening, and puts the token in a
subprotocol value, which is a place proxies log. Polling in both would leave the product surface —
the packaged shell — on a mechanism nobody intends to ship.

So the transports differ where the platform differs, and are identical where it does not: both resume
by global sequence, both surface a gap frame rather than swallowing it, and both refuse a path that
could name another host before anything is sent. `BrowserTransport` carries a token in page memory
and is development-only for exactly that reason.

## ADR-0016: The Phase 4 core token comes from the environment

**Decision:** The shell reads `NOCTIS_CORE_TOKEN` from its process environment. The Phase 4 task
"keep the core token in Rust/OS protected storage, not JavaScript local storage" is met in its
load-bearing half — the token is never in the WebView, in `localStorage`, or in the page bundle — and
deferred in its other half: it is not in Windows Credential Manager.

**Reason:** The gate is that the WebView cannot read the token, and that holds either way: the token
lives in `CoreConfig`, which is Rust process state with a hand-written redacting `Debug`, and the
three commands the page can invoke never return it. What the environment does not give is protection
at rest for an unattended machine, which is a property of a shipped install rather than of a canary.
Adopting the `keyring` crate now would add a dependency and a seeding path to protect a development
token that is already only as durable as the terminal that set it.

**Cost of being wrong:** a shell packaged for real use before this is revisited would leave the token
wherever the launching environment put it. The Phase 14 production-qualification gate must not pass
while that is true.

## ADR-0017: Phase 4 scope boundary

**Decision:** Phase 4 delivers the two transports, the Rust request proxy, the Rust-held client
socket, single instance, `noctis://` deep links, the global shortcut, the tray, native notifications,
and crash-safe window placement restore. Four named items in Sections 11.1 and 14 are deliberately
not built:

- **Autostart.** A production activation. The plugin is not a dependency, and
  `apps/desktop/tests/shell-boundary.test.mjs` asserts it is not.
- **Update channel and signature verification.** Section 11.1 already conditions these on release
  infrastructure existing, and none does.
- **Monitor and display inventory as a command.** The shell reads the monitor arrangement to place
  its own window; exposing an inventory to the page belongs with the native window orchestration in
  Phase 9, which is what would consume it.
- **OS-protected token storage.** ADR-0016.

**Also recorded:** `noctis://` scheme registration writes to `HKCU\Software\Classes` and is therefore
default-off behind `NOCTIS_REGISTER_SCHEME=true`, in line with the rule that production capabilities
stay off until asked for by name.

**No contract changed.** The transports speak the Phase 1 client envelope and the Phase 2 REST
surface as they already are. `core:frame`, `core:status`, and `core:deep-link` are Tauri event names
inside one process, not additions to the event registry in `@noctis/contracts`.

## ADR-0018: The consequence boundary is three commands, and `executed_at` is the fact

**Decision:** `authority.request`, `authority.confirm`, and `authority.execute` are three separate
commands against one `approvals` row. A request asks the policy and records its answer; a
confirmation is a human answering at the boundary; an execution records that the consequence
happened. None of them may be folded into another.

**Why three and not one or two.** Section 9.1 says preparation "must stop before the external commit
boundary". A request that also confirmed would let a caller answer its own question. A confirmation
that also executed would make preparing and committing the same act, which is the boundary the
section exists to draw. The split is also what makes the audit answer a question a merged row could
not: _was this approved before it ran, and by whom?_

**`executed_at` is the single fact that prevents a repeat.** It is written by an
`UPDATE ... WHERE id = ? AND executed_at IS NULL` inside the transaction that read it, so two
concurrent submits cannot both pass. The idempotency key already makes a _retry_ of one submit safe;
this makes a _second_ submit refuse, which a key cannot do because a second click carries a new key.
`apps/core/src/api/headless.integration.test.ts` proves both halves separately — same key returns the
original result, different key is refused with `already_executed`.

**The typed confirmation phrase is derived, never proposed.**
`packages/domain/src/authority/confirmation.ts` builds it from the operation class, the target, and
the amount, and the core stores it at decision time. A client renders it and echoes it back. A phrase
a caller could choose is a phrase a caller could make easy to type by accident. Matching is
case-sensitive after trimming: a phrase that matches case-insensitively is one that can be typed
without being read, and reading it is the entire mechanism.

**Money rounds up through millionths.** `1.005 * 100` is `100.49999999999999` in IEEE-754, so naive
rounding renders a spend confirmation a penny short. The amount is normalised to millionths and then
rounded up, because a confirmation may state more than will be spent and must never state less. The
real fix is integer pence in the contract; this is the boundary that made the float load-bearing and
it is marked `ponytail:` at the site.

## ADR-0019: Phase 8 scope boundary

**Decision:** Phase 8 delivers every operation class and its typed-confirmation rule, narrow
target-bound standing permissions with expiry/visibility/revocation, the prepare-versus-commit
boundary with idempotency, external references versus local artifacts with lineage, normalized source
freshness with remembered/current conflict display, the Approval, Artifact, and Source State
Surfaces, the Settings permissions screen, and node dispatch routed through the authority evaluator.

Four things named nearby are deliberately not built:

- **`provider_decisions`.** Section 4.1 lists the table and Section 8 owns provider and model
  routing. Phase 8's task list does not include routing, and a table with no writer is scaffolding.
- **Real execution evidence.** `authority.execute` records whatever evidence its caller supplies, and
  the only caller today is the workbench, which supplies `{ confirmedInWorkbench: true }`. The
  adapters that reach a real external system and return its answer arrive with Phases 10 and 11. The
  boundary is built and proven; what crosses it is still a stub, and the Artifacts page says so.
- **Model-proposed authority requests.** The contracts admit one — `authority.request` takes an
  `actorId` — but nothing emits one yet, because there is no provider runtime. The evaluator does not
  care who asked, which is the property that makes this additive.
- **A UI for granting a permission.** Settings lists and revokes; `authority.grant_permission` is a
  command with no button. Granting standing authority through a form before any adapter needs one
  would be building the riskiest control first. Revocation is the half that must exist immediately,
  and it does.

**Contract vocabulary added:** eight commands (`authority.confirm`, `authority.execute`,
`authority.grant_permission`, `authority.revoke_permission`, `source.register`, `source.observe`,
`artifact.record`, `artifact.import`); five event names (`authority.confirmed.v1`,
`authority.executed.v1`, `permission.granted.v1`, `source.registered.v1`, `artifact.imported.v1`);
two stream types (`source`, `artifact`); and one `DomainConflict` kind, `authority_refused`, which
maps to HTTP 403. It is its own kind rather than a `forbidden_transition` because a state-machine
refusal is about what a record is and this is about what an actor may do to it, and a client cannot
retry the same way after each.

## ADR-0020: Runtimes execute on nodes

**Decision:** A model runtime (Codex App Server, Claude Code via the Agent SDK, later Hermes) is
spawned by the node agent through a `runtime.turn` capability, never by the core and never by the
Tauri shell.

**Why.** A runtime reads files, runs commands, and holds a login; all three belong to a machine, and
the node agent is already the outbound, granted, leased, revocable worker on one. The core stays a
thin ledger; the shell keeps Win32 placement only. Phone → core → worker is the only path, so the
path a phone will need is proven from the first live run.

## ADR-0021: A turn is `read_inspect`; the actions inside it ask

**Decision:** `runtime.turn` needs no approval to start. Each command, file change, network
permission or tool call the runtime wants is surfaced by the runtime itself (Codex
`item/*/requestApproval`, Claude `canUseTool`) and classified by deterministic node code
(`classifyAsk`) into an `AuthorityRequest` whose idempotency key is the ask id. Under an active
Objective, `local_reversible_edit` inside granted roots is allowed by the existing evaluator and
audited; everything else waits for a human. The sandbox (`workspace-write` on granted roots when the
Objective is active, read-only otherwise) is an independent second fence.

**Why.** The capability owns its operation class, and a turn's class is honest only if the
consequential acts inside it are classed separately. Nothing the model emits is a decision: the node
classifies, the core evaluates, and the runtime blocks until the core's answer is forwarded.

## ADR-0022: Items are events; deltas are an ephemeral frame

**Decision:** Completed runtime items become `identity.turn_item.v1` and, for agent messages,
`identity.message_added.v1`. Token deltas travel node `delta` frame → in-process `LiveBroker` →
client `runtime_delta` frame over `/ws/clients`. Deltas are never written to `orchestration_events`.

**Why.** A ledger row per token would bury every real event under thousands of fragments nobody
reads back. A client that missed a delta has the committed message; a client that missed an item has
the ledger. The node socket's frame budget for `runtime.turn` is sized for deltas (100 000 per job)
and every frame renews the lease, so a turn that streams is a turn that stays alive.

## ADR-0023: Cost class is probed at startup and enforced at dispatch

**Decision:** `hello.providers[]` carries `{providerId, available, authMode, version, models[]}`
per runtime the node found; the core stores it on the node row and the router selects only
`chatgpt`, `claude_ai`, or `local` auth modes. Spawned children never see `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, or `CODEX_API_KEY`; `claude --bare` is never used.

**Why.** No metered API adapter is ever registered. A probe that reports a mode string (never a
token) lets the core refuse an `api_key` login before a job exists, rather than discovering a bill
afterwards.

## ADR-0024: Model proposals travel a structured channel into existing commands

**Decision:** `noctis_propose_surface` and `noctis_propose_objective` are tools served by a stdio
MCP server the node agent owns. Each call is validated against `RuntimeProposalSchema`, appended to a
per-turn proposals file the runtime adapter tails, and surfaced as a `proposal` item. The core
validates a surface proposal against `SURFACE_PAYLOAD_SCHEMAS` and lands it through
`surface.upsert_intent`; an objective proposal lands through `objective.create` with
`status: "suggested"`, both with `actorType: "identity"`. ADR-0005 holds: the model proposes
validated intent, deterministic code owns everything else.

## ADR-0025: The boundary gains `authority.decline` and job linkage (amends ADR-0018)

**Decision:** `approvals` gains `declined_at`, `declined_by`, `node_job_id`, and `ask_id`. A human
may decline a `require_*` decision; a declined approval can be neither confirmed nor executed. The
ask id is the request's idempotency key, so a reconnecting node that re-asks receives the answer
already recorded.

**Why.** A "no" that was only an absence could not be told to the executor waiting on it, and could
not be audited. Linking the row to the job and the ask is what lets the conversation service answer
the right node, and what lets the Chat page show which turn is waiting.

## ADR-0026: Model choice is data

**Decision:** A `ModelRef { providerId, model, label? }` catalogue is assembled from probes (Codex's
`models_cache.json`, Claude's `sonnet`/`opus` aliases, later LM Studio's loaded models). Each
identity has a default `ModelRef` in `runtime_kv`; `conversation.send` may override per turn;
`provider_decisions` records the request, the candidates, and the choice. No code names a model's
job.

**Why.** Owner decision 0.3: switching what model does what is a toggle, not a code change, and a new
model appears when a node reports it.

## ADR-0027: The core runs on the work PC from Slice 1

**Decision:** The authoritative core runs on the work PC (owner decision 0.15); the home PC pairs as a
worker over Tailscale Serve (private, never Funnel). The home development core remains for tests. The
work PC never holds a home-root grant (0.30): a turn that needs home files is pinned to the home node
by `pinned_node_id`, and the work node may enqueue such a turn but never reads the result files.

**Consequence accepted for now.** Conversation text of turns that ran at home lives in the work-PC
database. File contents never leave the home node. If that becomes unacceptable, the repair is
content residency, which `identity_message_content` was shaped to allow.
