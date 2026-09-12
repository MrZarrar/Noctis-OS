# Noctis Intelligence Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 2 (2026-09-12, evening).** Revised after a seven-round reverse-prompt with the owner. Part 0 records every answer; the slices, ADRs, and tasks below are rewritten to match. Where revision 1 and this text disagree, this text wins.

**Goal:** Make Noctis the front door for all of Mushaf's AI work: an ordinary sentence typed (or a photo dropped) into Noctis becomes interpreted work that runs on the right PC with the model he chose, edits and browses autonomously inside granted boundaries, asks at consequences, streams what it is doing token by token, returns evidence, updates the workspace, and reaches his phone — on top of the deterministic chassis Phases 0–10 built.

**Architecture:** The node agent is the execution plane: a `runtime.turn` capability spawns Codex App Server or Claude Code (Slice 1) and Hermes (Slice 4, for Jester on a local model) on the machine that owns the files, streams items and token deltas back over the existing node socket, and routes every consequential action through the existing `approvals` boundary via an ask/answer frame pair. The authoritative core runs on the work PC from the start (owner's decision; AnyDesk gives him console access); the home PC is a worker. The core gains one thin service (`conversation`) that persists messages, records provider and model decisions, links approvals to the job that asked, and turns model proposals into commands that already exist. Model choice is data: a catalogue, a per-identity default, a per-turn override. The page proposes nothing; it sends and renders.

**Tech Stack:** TypeScript 6.0.3 (ESM, NodeNext), Zod 4.4.3, Vitest 4.1.11, `node:sqlite`, `ws` 8.21.3, React 18.3.1, Vite 8.2.2, Tauri 2.11.5, Rust; Codex CLI 0.153.4 (`app-server --stdio`, ChatGPT login; models today: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-6-astra`); Claude Code 2.1.223 via `@anthropic-ai/claude-agent-sdk` 0.3.269 (claude.ai team login; `sonnet`, `opus`); Hermes Agent (MIT, Python + Node, native Windows installer) for Jester on LM Studio; `@modelcontextprotocol/sdk` for the Noctis proposal tools; Playwright 1.63 and `@playwright/mcp` 0.0.80; Windows-MCP (MIT, Python 3.13 + uv) behind an allowlist.

**Spec:** [`docs/architecture/NOCTIS-FABLE-IMPLEMENTATION-BRIEF.md`](../../architecture/NOCTIS-FABLE-IMPLEMENTATION-BRIEF.md), [`docs/acceptance/INTENT-IMPLEMENTATION-AUDIT.md`](../../acceptance/INTENT-IMPLEMENTATION-AUDIT.md) (findings F1–F13), and Part 0 below (owner's answers, which outrank both where they differ).

---

## Part 0 — What the owner actually wants (2026-09-12 reverse prompt)

Recorded verbatim in intent, paraphrased in wording. Each row names the slice that delivers it.

| #    | Decision                                                                                                                                                                                                                                                                                   | Delivered in     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 0.1  | Runtimes execute on the **node agent**, never in the core or the Tauri shell.                                                                                                                                                                                                              | S1               |
| 0.2  | **Both Codex and Claude in Slice 1.** Astra (`gpt-6-astra`) is only the model building Noctis; in use he picks Sonnet, Opus, Sol, Terra, Luna.                                                                                                                                             | S1               |
| 0.3  | **Model choice is first-class**: per-identity default in Settings plus a per-turn override on the prompt. Names are not locked to roles ("Sol does X"); new models appear as data, and switching what model does what is a toggle, not a code change. Every turn records provider + model. | S1               |
| 0.4  | Under an **active Objective, local edits and commands inside granted folders are auto-allowed and audited**. Outside the folders, network, sends, publishes, spends, deletes always ask.                                                                                                   | S1               |
| 0.5  | **Workspace-write from day one.** The first live run may edit files.                                                                                                                                                                                                                       | S1               |
| 0.6  | A prompt with no Objective is **answered in Chat; Vesper may suggest an Objective**, never activate one.                                                                                                                                                                                   | S1               |
| 0.7  | **Token streaming day one**, not item-level only.                                                                                                                                                                                                                                          | S1               |
| 0.8  | **Jester = Hermes Agent**, MIT, wrapped as a runtime behind the node agent now, pieces ported later with ledger + licence. "Translation" was a one-time port question, settled as wrap-first.                                                                                              | S4               |
| 0.9  | Hermes's **skills are kept** (visible read-only in Noctis); its **memory and cron are disabled** — Vault owns memory, Noctis owns Automations.                                                                                                                                             | S4               |
| 0.10 | Local model server: **LM Studio** on the RTX 5070.                                                                                                                                                                                                                                         | S4               |
| 0.11 | Phone: **the Noctis web app over Tailscale Serve**, porting as much as possible from the donor's mobile surface (`MobileTabBar`, `useIsMobile`, `push.js`, `assistant-token.js`, `DEPLOYMENT.md` Serve procedure).                                                                         | S2               |
| 0.12 | Thread life: **one runtime thread per Objective plus one free-chat thread per identity.**                                                                                                                                                                                                  | S1               |
| 0.13 | General **Windows desktop control in Slice 3, behind an allowlist** (Windows-MCP: Click/Type/Screenshot/Snapshot/App only).                                                                                                                                                                | S3               |
| 0.14 | **Read the real MindVault now, write only under `inbox/`** (and attachments beside notes, see 0.30). Vault engine writes elsewhere remain behind Phase 14.                                                                                                                                 | S2               |
| 0.15 | **Core on the work PC from Slice 1**; home PC is a worker.                                                                                                                                                                                                                                 | S1               |
| 0.16 | Astra: **visual and frontend pass after Slice 3.**                                                                                                                                                                                                                                         | Part E           |
| 0.17 | **Subagent per task, review between tasks, commit per green task**, no AI co-author trailers.                                                                                                                                                                                              | process          |
| 0.18 | Grant roots from the first live run: **`Documents\Jarvis` (Noctis-OS rw, donor ro), `Downloads`, `Documents`, `MindVault` (ro) + `MindVault\inbox` (rw)**. No scratch-only phase.                                                                                                          | S1               |
| 0.19 | Use cases, first three months: **dev missions, reselling, web research, second brain, file chores, personal admin (email/calendar/messages), music.**                                                                                                                                      | S3–S5            |
| 0.20 | Autonomy: **autonomous inside the boundary, ask at consequences.**                                                                                                                                                                                                                         | S1               |
| 0.21 | Proactivity: **suggest, run pre-approved Automations, and interrupt as much as it wants** (Attention Required on desktop and phone). Pulled forward from Phase 13.                                                                                                                         | S4               |
| 0.22 | Memory beyond the Vault: **reusable skills** (how a task was done) and **preferences/corrections** (Agent-Brain style). Conversation history is kept regardless.                                                                                                                           | S4               |
| 0.23 | Input: **typed text, and images/files in the prompt.** Voice and wake word later (backlog).                                                                                                                                                                                                | S2               |
| 0.24 | **Several Objectives run concurrently; Vesper may spawn sub-agents freely** (runtime-native), all under the same asks.                                                                                                                                                                     | S3               |
| 0.25 | Phone notifications: **approvals waiting, turn/Objective finished or blocked, Sense suggestions.**                                                                                                                                                                                         | S2, S4           |
| 0.26 | Blockers: **try alternatives within scope, then stop with evidence and a proposed next step or capability.**                                                                                                                                                                               | S1 prompt policy |
| 0.27 | Jester's purposes: **parallel second worker, creative riffs, private/local-only work, red-team.**                                                                                                                                                                                          | S4               |
| 0.28 | NOIR: **low priority**; later gains a "God's Eye" world view over public cameras (public repo).                                                                                                                                                                                            | backlog          |
| 0.29 | Success in three months: **"I stopped opening ChatGPT/Claude directly; I talk to Noctis and it gets things done in my real apps."**                                                                                                                                                        | all              |
| 0.30 | **Data boundary:** work-PC data is available on both PCs; the work PC may _request_ work from the personal PC but never reads personal files. Files/images live **beside notes in OneDrive as Obsidian attachments, indexed as Artifacts.**                                                | S1 grants, S3    |
| 0.31 | MacBook: optional worker later.                                                                                                                                                                                                                                                            | backlog          |

**One consequence to be aware of (0.15 + 0.30):** with the core on the work PC, the core database — including message bodies of turns that ran at home — lives on the work PC. File _contents_ never leave the home node (grants), but conversation text does. Accepted for now; if that becomes unacceptable, the repair is content residency (bodies stored on the node that ran the turn, core keeps references), which `identity_message_content` was shaped to allow.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Donor:** `C:\Users\mmush\Documents\Jarvis\Jarvis-Sub-Agent-Dashboard` is read-only. Every port gets a `DONOR-PORT-LEDGER.md` row _before_ the copy. `npm run test:boundary` before and after any port. Hermes ports get the same treatment under its MIT licence in `NOTICE.md`.
- **Node:** `engines` is `22.x`; CI pins `22.23.2`. Local development runs 24.19.0; CI is authoritative.
- **Module system:** ESM, `"module": "NodeNext"`. Relative imports end in `.js`. Types via `import type`.
- **Strictness:** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. Spread-omit optional fields.
- **Schemas:** every Zod object schema ends in `.strict()`. Every cross-process message (node frame, runtime JSON-RPC, MCP tool input, HTTP body, Rust-forwarded frame) is parsed through its schema before use.
- **Commands:** every mutation is a command with a required `idempotencyKey`, through `runCommand`. Never nest `runCommand`; extract `…InTransaction(tx, …)` helpers.
- **Events:** append-only names in `packages/contracts/src/events.ts`. Delivery after commit via `kernel.broker`. Token deltas are the one ephemeral channel and are never written to `orchestration_events`.
- **Authority:** the operation class of a capability is fixed by the capability. Models never receive coordinates, never confirm, never grant. The runtime cannot proceed past an ask until the node forwards the core's answer.
- **Cost:** no metered API adapter is registered, ever. Spawned runtimes never see `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`. `claude --bare` is forbidden. Auth mode is probed, reported in `hello`, and enforced at dispatch.
- **Isolation of spawned runtimes:** Claude: `settingSources: []`, `strictMcpConfig: true` (the owner's `~/.claude/settings.json` carries Jarvis hooks). Codex: `--ignore-user-config` if `app-server` accepts it, else explicit `-c` overrides (Task 1.7 verifies). Hermes: its own config dir under `%NOCTIS_NODE_HOME%\hermes`, memory and cron off.
- **No listeners on workers:** the node agent opens no port; MCP servers it hosts are stdio children; the proposal channel is a file it tails.
- **Production capabilities:** the owner authorised on 2026-09-12: the core on the work PC, Tailscale Serve for the core (private, never Funnel), pairing the home PC as a worker, and the grant roots in 0.18. Still default-off and needing a fresh approval by name: Windows service/autostart registration, Vault writes outside `inbox/` and attachment folders, any publish/send/spend, Wake-on-LAN hardware config.
- **Tests:** colocated `*.test.ts`; integration tests `*.integration.test.ts`; one focused failing test before each behaviour; red then green. Fixture proof (fake runtime) and live proof are labelled separately in `IMPLEMENTATION-STATUS.md`.
- **Verification before commit:** `npm run format:check && npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build`; Rust gates when a `.rs` changed; `npm run test:e2e` when `apps/web` changed.
- **Commit style:** `feat(area): …` / `fix(area): …` / `docs: …`. No AI co-author trailers (Agent Brain rule).
- **Secrets:** never in SQLite, logs, or docs. Probes report a mode string, never a token.

---

## Part A — Decisions to record (ADR-0020 … ADR-0031)

Write into `docs/architecture/DECISIONS.md` as each lands (S1 writes 0020–0027; S2 0028–0029; S4 0030–0031).

**ADR-0020 — Runtimes execute on nodes.** A runtime reads files, runs commands, holds a login; those belong to a machine, and the node agent is already the outbound, granted, leased, revocable worker on one. The core stays thin. The shell keeps Win32 placement only. Phone → core → worker is the only path, so it is proven from day one.

**ADR-0021 — A turn is `read_inspect`; the actions inside it ask.** `runtime.turn` never needs approval to start. Each command, file change, network permission or tool call the runtime wants is surfaced by the runtime (Codex `item/*/requestApproval`, Claude `canUseTool`, Hermes's approval hook or Noctis-mediated tools) and classified by deterministic node code into an `AuthorityRequest`. Under an active Objective, `local_reversible_edit` inside granted roots is allowed by the existing evaluator and audited; everything else waits. The sandbox (`workspace-write` on granted roots, `--add-dir` for the rest) is an independent second fence.

**ADR-0022 — Items are events; deltas are an ephemeral frame.** Completed items become `identity.turn_item.v1` / `identity.message_added.v1`. Token deltas travel node `delta` → core in-process `LiveBroker` → client `runtime_delta` frame over `/ws/clients` and an SSE endpoint for browser clients. Deltas are never persisted; a client that missed them has the completed message.

**ADR-0023 — Cost class is probed at startup and enforced at dispatch.** `hello.providers[]` carries `{providerId, available, authMode, version, models[]}`; the router selects only `chatgpt`, `claude_ai`, or `local` auth modes.

**ADR-0024 — Model proposals travel a structured channel into existing commands.** `noctis_propose_surface`, `noctis_propose_objective` (and, S2, `noctis_record_artifact`) served by an MCP server the agent owns; validated against the Surface payload schemas; landed via `surface.upsert_intent` / `objective.create(status: suggested)` with `actorType: "identity"`. ADR-0005 holds.

**ADR-0025 — The boundary gains `authority.decline` and job linkage (amends ADR-0018).** `declined_at/by`, `node_job_id`, `ask_id`. The ask id is the request's idempotency key, so a reconnecting node re-asks and gets the existing answer.

**ADR-0026 — Model choice is data.** A `ModelRef { providerId, model }` catalogue is assembled from probes (Codex's model list, Claude's `sonnet`/`opus` aliases, LM Studio's loaded models), stored in `runtime_kv`, shown in Settings. Each identity has a default `ModelRef`; `conversation.send` may override per turn; `provider_decisions` records both. No code names a model's job.

**ADR-0027 — The core runs on the work PC from Slice 1.** Owner's decision (0.15). The home PC pairs as a worker over Tailscale. The home development core remains for tests only. The work PC never holds a home-root grant (0.30); a turn that needs home files is pinned to the home node, and the work node may enqueue such a turn but never read the result files.

**ADR-0028 — Browser clients get a same-origin session realm (amends ADR-0015).** Cookie login over Tailscale Serve, CSRF header on mutations, SSE for live frames. Ports the donor's token-once flow and mobile shell. Delivered in Slice 2, because the phone is part of "front door".

**ADR-0029 — The live Vault is readable now; writes are scoped.** `NOCTIS_VAULT_ROOT` may point at the real MindVault for indexing and recall (read-only). Runtime writes are permitted only through two grant roots: `MindVault\inbox` and per-note attachment folders. The Vault engine's own write paths stay disabled until Phase 14. Preferences and corrections Noctis learns are appended to `agent/brain.md` under its existing rules (one bullet, grep first), so every tool sees them.

**ADR-0030 — Jester is Hermes behind the node agent (wrap-first).** A third `Runtime` adapter spawns Hermes with a Noctis-owned config: LM Studio provider, memory off, cron off, skills on and read-only from Noctis, Noctis MCP tools attached. `authMode: "local"`. When LM Studio is down, Jester is unavailable, never silently cloud-backed. Pieces are ported later, each with a ledger row. Data tagged `local_only` (a root attribute) routes only to local-auth providers.

**ADR-0031 — Sense, Attention Required, and Automations are Slice 4, not Phase 13.** The owner wants suggestions, pre-approved schedules, and interruptions. Suggestions never activate an Objective; Automations run only capabilities their grant already covers and never a metered provider; interruptions elevate to Attention Required and push to the phone.

### Sequence

| Slice                                              | Proves                                                                                                                                                                                                                                                                                | Out of scope                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **1 — the live loop, both runtimes, work-PC core** | prompt → chosen model on Codex or Claude → workspace-write on real roots → auto-allowed local edits, asks for the rest → token streaming → proposals placed → history and runtime thread restored → core on work PC, home worker paired                                               | phone, Hermes, desktop control              |
| **2 — front door on every device**                 | session realm + Tailscale Serve + phone layout ported from the donor; web push for approvals/finished/blocked; images and files in the prompt; live Vault read + inbox writes; recovery (reload, reconnect, cancel, host offline); core-side approval Surfaces; `Command.tsx` slimmed | Jester, Sense                               |
| **3 — generality and reach**                       | Playwright MCP isolated; Windows-MCP allowlisted; several Objectives at once; sub-agents; the recorded unseen task; Objective change mid-run; Missions page; Vault attachments as Artifacts                                                                                           | Hermes                                      |
| **4 — Jester, memory, proactivity**                | Hermes on LM Studio as Jester; skills visible; preferences to brain.md; Sense suggestions; Attention Required; Automations with schedules; the small interpreter in shadow mode                                                                                                       | NOIR                                        |
| **5 — journeys and integrations**                  | Song, Vinted, Development as rows + prompts; personal admin via email/calendar MCPs (sends confirmed); Wake-on-LAN after topology; Mac worker if wanted                                                                                                                               | NOIR + God's Eye (backlog), voice (backlog) |
| **Astra — visual pass**                            | after Slice 3                                                                                                                                                                                                                                                                         | contracts                                   |

Slice 1 is at step level (Part C). Slices 2–5 are at task/file/interface level (Part D) and are expanded after Slice 1's live evidence.

---

## Part B — File structure for Slice 1

**`packages/contracts/src/`**

| File                  | Change | Responsibility                                                                                                                                                                                              |
| --------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.ts`          | create | provider ids (`codex`, `claude`, `hermes`), auth modes, `ModelRef`, probe (with `models[]`), turn payload/evidence, items, proposals, ask/answer, delta, grant constraints (roots with `mode`, `localOnly`) |
| `surface-payloads.ts` | create | the Surface payload schemas moved out of `apps/web/src/surfaces/registry.ts` so the core can validate proposals                                                                                             |
| `node.ts`             | modify | `runtime.turn`; `providers` on `hello`; `stream`/`delta`/`ask` node frames; `answer` server frame                                                                                                           |
| `ws.ts`               | modify | `runtime_delta` server frame                                                                                                                                                                                |
| `events.ts`           | modify | `identity.turn_started.v1`, `identity.turn_item.v1`, `identity.turn_completed.v1`, `authority.declined.v1`, `provider.decision_recorded.v1`, `identity.default_model_set.v1`; stream type `provider`        |
| `command.ts`          | modify | `conversation.send` (with `model?`, `objectiveId?`), `conversation.cancel`, `authority.decline`, `identity.set_default_model`; `nodeJobId?`/`askId?` on `authority.request`                                 |
| `authority.ts`        | modify | `declinedAt`, `declinedBy`, `nodeJobId`, `askId` on `ApprovalRecord`                                                                                                                                        |

**`packages/domain/src/`**

| File                           | Change | Responsibility                                                                                                           |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `runtime/route.ts` (+ test)    | create | `chooseProvider(identity, modelRef, candidates)` — pure; honours the requested model, session affinity, local-only roots |
| `runtime/classify.ts` (+ test) | create | `classifyAsk` — deterministic operation class for commands, file changes, permissions, tool calls                        |
| `result.ts`                    | modify | conflict kind `unavailable`                                                                                              |

**`apps/core/`**

| File                                              | Change | Responsibility                                                                                                                             |
| ------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `migrations/0006_runtime.sql`                     | create | message content, sessions (per thread × provider × node), turns, approval linkage, provider decisions, job pinning, `nodes.providers_json` |
| `src/conversation/service.ts` (+ tests)           | create | `sendMessage`, `cancelTurn`, `listMessages`, `listTurns`, `onStreamItem`, `onDelta`, `onAsk`, broker subscribers                           |
| `src/conversation/threads.ts`                     | create | free-chat thread per identity + one thread per Objective (0.12)                                                                            |
| `src/conversation/asks.ts`                        | create | ask ↔ approval ↔ answer; `proposeApprovalSurface`                                                                                          |
| `src/conversation/proposals.ts`                   | create | proposal → `surface.upsert_intent` / `objective.create`                                                                                    |
| `src/conversation/models.ts`                      | create | catalogue assembly from probes; identity defaults in `runtime_kv`                                                                          |
| `src/events/live.ts`                              | create | `LiveBroker` — in-process, ephemeral fan-out for deltas                                                                                    |
| `src/nodes/{jobs,router,registry,ws,dispatch}.ts` | modify | pinning, lease renewal, frames, `sendAnswer`, providers on hello                                                                           |
| `src/authority/service.ts`                        | modify | `declineAuthority`; linkage on request                                                                                                     |
| `src/api/{http,ws}.ts`                            | modify | commands, `GET /threads/:id/messages                                                                                                       | turns`, `GET /models`, `runtime_delta` relay |
| `src/server.ts`                                   | modify | wire `LiveBroker` and the conversation service                                                                                             |

**`apps/node-agent/src/`**

| File                                          | Change        | Responsibility                                                                                  |
| --------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `runtimes/Runtime.ts`                         | create        | `Runtime`, `RuntimeSink` (`item`, `delta`, `ask`)                                               |
| `runtimes/codex-command.ts` (+ test)          | create (port) | resolve `codex.exe` — donor `server/lib/providers/codex-command.js`                             |
| `runtimes/codex.ts` (+ test)                  | create        | App Server JSON-RPC client incl. `item/agentMessage/delta`                                      |
| `runtimes/claude.ts` (+ test)                 | create        | Agent SDK `query()` with `canUseTool`, `includePartialMessages`                                 |
| `runtimes/fake.ts`                            | create        | scripted runtime for CI                                                                         |
| `runtimes/probe.ts` (+ test)                  | create        | auth mode + model list per provider                                                             |
| `runtimes/env.ts` (+ test)                    | create        | child environment, billing keys stripped                                                        |
| `runtimes/roots.ts` (+ test)                  | create        | resolve grant roots → cwd, writable dirs, read-only dirs; `localOnly`                           |
| `proposals-file.ts` (+ test), `noctis-mcp.ts` | create        | proposal channel                                                                                |
| `adapters.ts`, `agent.ts`                     | modify        | `runtime.turn`; concurrent turns; heartbeat; pending asks; `answer` frame; `providers` in hello |

**`apps/desktop/src-tauri/src/stream.rs`** — modify only if it filters frames by kind: forward `runtime_delta` to the page as `core:frame`.

**`apps/web/src/`**

| File                                                         | Change | Responsibility                                                                         |
| ------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------- |
| `pages/Presence.tsx`                                         | modify | form that sends; model selector                                                        |
| `pages/Chat.tsx`, `conversation/useConversation.ts` (+ test) | create | history, streaming text, items, approvals with Confirm/Decline, Cancel, model selector |
| `pages/Settings.tsx`                                         | modify | per-identity default model from `GET /models`                                          |
| `App.tsx`, `surfaces/renderers.tsx`, `surfaces/registry.ts`  | modify | route Chat; `onDecline`; import payload schemas from contracts                         |
| `transport/*.ts`                                             | modify | surface `runtime_delta` frames to subscribers                                          |

**Docs:** `DECISIONS.md` (0020–0027), `DONOR-PORT-LEDGER.md` (codex-command), `docs/operations/nodes.md` (granting `runtime.turn` with roots and providers; pairing the home PC to the work-PC core), `docs/operations/work-pc-core.md` (Serve, env, token handling), `docs/operations/runtime-live-evidence.md`, `IMPLEMENTATION-STATUS.md`.

---

## Part C — Slice 1 tasks (step level)

Slice 1 has two checkpoints: **1A** (Tasks 1.1–1.9: the loop proven on the home dev core with the fake runtime and one live Codex run) and **1B** (Tasks 1.10–1.13: Claude, token streaming through the shell, model picker, work-PC core + home worker, live evidence on the real topology).

### Task 1.1: Runtime contracts

**Files:**

- Create: `packages/contracts/src/runtime.ts`, `packages/contracts/src/surface-payloads.ts`
- Modify: `packages/contracts/src/{node,ws,events,command,authority,index}.ts`, `apps/web/src/surfaces/registry.ts` (import the moved schemas)
- Test: `packages/contracts/src/runtime.test.ts`; extend `contracts.malformed.test.ts`; `apps/web/src/surfaces/registry.test.ts` must stay green

**Interfaces (produces):**

- `RUNTIME_PROVIDERS = ["codex", "claude", "hermes"]`; `RuntimeAuthModeSchema = "chatgpt" | "claude_ai" | "local" | "api_key" | "unknown"`; `ELIGIBLE_AUTH_MODES = {chatgpt, claude_ai, local}`.
- `ModelRefSchema { providerId, model: string (1..128), label?: string }`.
- `RuntimeProbeSchema { providerId, available, authMode, version?, reason?, models: ModelRef[] (max 64) }`.
- `RuntimeRootSchema { grantId, path, mode: "read" | "write", localOnly: boolean (default false) }`; `RuntimeGrantConstraintsSchema { providers: RuntimeProviderId[], roots: RuntimeRoot[] (1..16) }`.
- `RuntimeTurnPayloadSchema { threadId, identityId, model: ModelRef, userMessageId, prompt (1..20000), primaryRootGrantId, sessionRef?, objectiveId?, objectiveActive: boolean }`.
- `RuntimeItemSchema` as revision 1 (`agent_message`, `command`, `file_change`, `tool_call`, `proposal`) plus `sub_agent {itemId, status, label}` for 0.24.
- `RuntimeDeltaSchema { itemId, text (1..2000) }`.
- `RuntimeAskSchema`, `RuntimeAnswerSchema`, `RuntimeTurnEvidenceSchema` as revision 1; evidence gains `model: ModelRef`.
- Node frames: `stream {jobId, sequence, item}`, `delta {jobId, delta}`, `ask {jobId, ask}`; server frame `answer {jobId, answer}`; `hello.providers: RuntimeProbe[]`.
- Client server frame: `runtime_delta { envelopeVersion, threadId, jobId, itemId, text }`.
- Commands: `SendConversationMessageCommandSchema { …CommandBase, identityId, text (1..20000), model?: ModelRef, objectiveId? }`; `CancelConversationTurnCommandSchema { …CommandBase, jobId }`; `DeclineAuthorityCommandSchema { …CommandBase, requestId, reason? }`; `SetIdentityDefaultModelCommandSchema { …CommandBase, identityId, model: ModelRef }`; `RequestAuthorityCommandSchema` gains `nodeJobId?`, `askId?`.
- `CAPABILITY_OPERATION_CLASS["runtime.turn"] = "read_inspect"`; `CAPABILITY_CONTRACTS["runtime.turn"]`.

- [ ] **Step 1: Failing test** — `packages/contracts/src/runtime.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_OPERATION_CLASS,
  ELIGIBLE_AUTH_MODES,
  NodeFrameSchema,
  NodeServerFrameSchema,
  RuntimeGrantConstraintsSchema,
  RuntimeItemSchema,
  RuntimeTurnPayloadSchema,
  ServerFrameSchema,
} from "./index.js";

const UUID = "0199a000-0000-7000-8000-000000000001";
const MODEL = { providerId: "codex", model: "gpt-5.6-sol" };

describe("runtime contracts", () => {
  it("classes a turn as read_inspect and carries the chosen model", () => {
    expect(CAPABILITY_OPERATION_CLASS["runtime.turn"]).toBe("read_inspect");
    expect(
      RuntimeTurnPayloadSchema.safeParse({
        threadId: UUID,
        identityId: "vesper",
        model: MODEL,
        userMessageId: UUID,
        prompt: "hello",
        primaryRootGrantId: "documents",
        objectiveActive: false,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown provider and an over-long prompt", () => {
    const base = {
      threadId: UUID,
      identityId: "vesper",
      userMessageId: UUID,
      primaryRootGrantId: "d",
      objectiveActive: false,
    };
    expect(
      RuntimeTurnPayloadSchema.safeParse({
        ...base,
        model: { providerId: "gemini", model: "x" },
        prompt: "x",
      }).success,
    ).toBe(false);
    expect(
      RuntimeTurnPayloadSchema.safeParse({ ...base, model: MODEL, prompt: "x".repeat(20_001) })
        .success,
    ).toBe(false);
  });

  it("bounds command output and delta text", () => {
    expect(
      RuntimeItemSchema.safeParse({
        kind: "command",
        itemId: "c1",
        status: "completed",
        command: "dir",
        output: "y".repeat(4_001),
      }).success,
    ).toBe(false);
    expect(
      NodeFrameSchema.safeParse({
        kind: "delta",
        envelopeVersion: 1,
        jobId: UUID,
        delta: { itemId: "m1", text: "z".repeat(2_001) },
      }).success,
    ).toBe(false);
  });

  it("carries providers with models on hello, answers on the server frame, deltas to clients", () => {
    expect(
      NodeFrameSchema.safeParse({
        kind: "hello",
        envelopeVersion: 1,
        agentVersion: "0.0.0",
        capabilities: ["runtime.turn"],
        providers: [{ providerId: "codex", available: true, authMode: "chatgpt", models: [MODEL] }],
      }).success,
    ).toBe(true);
    expect(
      NodeServerFrameSchema.safeParse({
        kind: "answer",
        envelopeVersion: 1,
        jobId: UUID,
        answer: { askId: UUID, decision: "deny", approvalId: UUID },
      }).success,
    ).toBe(true);
    expect(
      ServerFrameSchema.safeParse({
        kind: "runtime_delta",
        envelopeVersion: 1,
        threadId: UUID,
        jobId: UUID,
        itemId: "m1",
        text: "Hel",
      }).success,
    ).toBe(true);
  });

  it("roots carry a mode and a local-only flag", () => {
    expect(
      RuntimeGrantConstraintsSchema.safeParse({
        providers: ["codex", "claude"],
        roots: [
          {
            grantId: "vault",
            path: "C:\\Users\\mmush\\OneDrive\\MindVault",
            mode: "read",
            localOnly: true,
          },
          { grantId: "inbox", path: "C:\\Users\\mmush\\OneDrive\\MindVault\\inbox", mode: "write" },
        ],
      }).success,
    ).toBe(true);
  });

  it("names chatgpt, claude_ai and local as eligible", () => {
    expect([...ELIGIBLE_AUTH_MODES].sort()).toEqual(["chatgpt", "claude_ai", "local"]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run packages/contracts/src/runtime.test.ts` — FAIL.
- [ ] **Step 3: Write `runtime.ts`** — revision 1's file with these changes: `RUNTIME_PROVIDERS` gains `"hermes"`; add `ModelRefSchema`; `RuntimeProbeSchema.models: z.array(ModelRefSchema).max(64).default([])`; replace `SUBSCRIPTION_AUTH_MODES` with `ELIGIBLE_AUTH_MODES` (`chatgpt`, `claude_ai`, `local`); `RuntimeRootSchema` with `mode` and `localOnly`; payload fields `model`, `primaryRootGrantId`, `objectiveActive` replacing `providerId`/`rootGrantId`; `RuntimeDeltaSchema`; `sub_agent` item; evidence `model`.
- [ ] **Step 4: Move the payload schemas** — cut `ConversationPayloadSchema … VaultRecallPayloadSchema` from `apps/web/src/surfaces/registry.ts` into `packages/contracts/src/surface-payloads.ts` (export a `SURFACE_PAYLOAD_SCHEMAS: Record<string, { payloadVersion: number; schema: z.ZodType }>`); the registry imports and spreads them. `registry.test.ts` unchanged and green.
- [ ] **Step 5: Extend `node.ts`, `ws.ts`, `events.ts`, `command.ts`, `authority.ts`, `index.ts`** as listed under Interfaces. `runtime.ts` imports nothing from `node.ts`.
- [ ] **Step 6: Run** `npx vitest run packages/contracts apps/web/src/surfaces && npm run typecheck`. Add a temporary `"runtime.turn"` adapter that throws `AdapterRefused` so the tree compiles (Task 1.7 replaces it).
- [ ] **Step 7: Commit** — `feat(contracts): the runtime vocabulary — models are data, a turn is read_inspect`

### Task 1.2: Migration 0006 and the `unavailable` conflict

**Files:** create `apps/core/migrations/0006_runtime.sql`; modify `apps/core/src/db/migrate.test.ts`, `packages/domain/src/result.ts`, `apps/core/src/api/http.ts`.

- [ ] **Step 1: Extend the migration test** to expect version 6 and the tables `identity_message_content`, `identity_sessions`, `identity_turns`, `provider_decisions`, indexes `idx_approvals_ask`, `idx_identity_turns_thread`, `idx_identity_threads_objective`, and columns `approvals.{node_job_id, ask_id, declined_at, declined_by}`, `node_jobs.pinned_node_id`, `nodes.providers_json`, `identity_threads.objective_id`.
- [ ] **Step 2: Run** `npm run test:migrations` — FAIL.
- [ ] **Step 3: Write the migration** — revision 1's SQL plus:

```sql
-- 0.12: one runtime thread per Objective, plus the identity's free-chat thread
-- (objective_id NULL). 0001's "one thread per identity" becomes "one free-chat
-- thread per identity", enforced by the partial unique index.
ALTER TABLE identity_threads ADD COLUMN objective_id TEXT REFERENCES objectives (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_identity_threads_free ON identity_threads (identity_id) WHERE objective_id IS NULL;
CREATE UNIQUE INDEX idx_identity_threads_objective ON identity_threads (identity_id, objective_id) WHERE objective_id IS NOT NULL;

-- ADR-0023: what each node reported it can run, refreshed on every hello.
ALTER TABLE nodes ADD COLUMN providers_json TEXT NOT NULL DEFAULT '[]';

-- ADR-0026: the chosen model is recorded per turn, not inferred later.
-- (provider_decisions from revision 1 gains one column)
--   selected_model TEXT
```

Fold `selected_model TEXT` into the `provider_decisions` CREATE TABLE and `model_json TEXT NOT NULL` into `identity_turns`.

- [ ] **Step 4: Add `{ kind: "unavailable"; entity: string; reason: string }`** to `DomainConflict`; map to 503 in `conflictResponse`; one test case.
- [ ] **Step 5: Run** `npm run test:migrations && npm run typecheck` — PASS. **Commit** — `feat(core): migration 0006, threads per Objective, models per turn`

### Task 1.3: Provider routing and ask classification, pure

**Files:** create `packages/domain/src/runtime/route.ts` (+ test), `packages/domain/src/runtime/classify.ts` (+ test); modify `packages/domain/src/index.ts`.

**Interfaces (produces):**

```ts
export interface ProviderCandidate {
  nodeId: string;
  hostId: string;
  connected: boolean;
  granted: boolean;
  probe: RuntimeProbe;
  /** True when every root the turn needs is granted on this node. */
  hasRoots: boolean;
}
export interface ProviderDecision {
  selected?: { nodeId: string; model: ModelRef };
  candidates: Array<{
    nodeId: string;
    providerId: RuntimeProviderId;
    eligible: boolean;
    reasonCodes: string[];
  }>;
  reasonCodes: string[];
  costClass: "subscription" | "local" | "none";
}
export function chooseProvider(
  requested: ModelRef,
  candidates: readonly ProviderCandidate[],
  options?: { preferredNodeId?: string; localOnly?: boolean },
): ProviderDecision;

export interface AskInput {
  kind: "command" | "file_change" | "permission" | "tool_call";
  command?: string;
  cwd?: string;
  paths?: readonly string[];
  tool?: string;
  writableRoots: readonly string[];
  readableRoots: readonly string[];
}
export function classifyAsk(input: AskInput): {
  operationClass: OperationClass;
  reversibility: Reversibility;
  capability: string;
  reason: string;
};
```

- [ ] **Step 1: Failing tests**
  - `route.test.ts`: selects the node offering the requested `model` with an eligible auth mode and the roots; `api_key` never; `localOnly: true` rejects `chatgpt`/`claude_ai` with `local_only_root`; `preferredNodeId` wins ties with `session_affinity`; a requested model no node offers → `model_not_offered`; stable order by nodeId.
  - `classify.test.ts` (table-driven): `rm -rf`, `Remove-Item -Recurse`, `del /s`, `git push --force`, `format` → `destructive`; `git push`, `gh pr create`, `curl -X POST`, `Invoke-WebRequest -Method Post` → `external_write`; a write path inside a writable root → `local_reversible_edit`; a write outside → `external_write`; a read-only command (`dir`, `git status`, `type`) → `read_inspect`; `permission` kind → `external_write`; `tool_call` on `browser_*` → `external_write`, on `noctis_*` → `read_inspect`. Mark the table `// ponytail: pattern table; a grammar if it ever misclassifies in practice`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** both; `route.ts` follows revision 1's shape with `requested.model` matched against `probe.models[].model` and `providerId`. **Step 4: PASS. Commit** — `feat(domain): route to the model that was asked for; class every ask before it runs`

### Task 1.4: Nodes — pinning, lease renewal, stream/delta/ask frames, answers, providers

Unchanged from revision 1 except: accept the `delta` frame and hand it to `deps.runtime.onDelta(nodeId, jobId, delta)`; persist `providers_json` on hello; `listRuntimeCandidates(db, isConnected, roots: string[])` computes `hasRoots`; `FRAME_BUDGET["runtime.turn"] = 100_000` because deltas are frequent. Tests as revision 1 plus "a `delta` frame renews the lease and reaches the handler without being persisted". **Commit** — `feat(nodes): a job can be pinned, renewed, streamed from, and asked through`

### Task 1.5: Authority — decline and linkage

Unchanged from revision 1. **Commit** — `feat(authority): a human can say no, and the executor that asked is recorded`

### Task 1.6: The conversation service, threads per Objective, models, live deltas

**Files:** create `apps/core/src/conversation/{service,threads,asks,proposals,models}.ts` (+ tests), `apps/core/src/events/live.ts`; modify `apps/core/src/api/{http,ws}.ts`, `apps/core/src/server.ts`, `apps/core/src/index.ts`.

**Interfaces (produces):**

```ts
// events/live.ts
export interface LiveBroker { publish(frame: ServerFrame): void; subscribe(listener: (frame: ServerFrame) => void): () => void; }
// conversation/threads.ts
export function threadFor(tx, kernel, identityId, objectiveId: string | undefined, now): ConversationThread; // free-chat when undefined
// conversation/models.ts
export function catalogue(db): ModelRef[];                                  // union of connected nodes' probes
export function defaultModelFor(db, identityId): ModelRef | undefined;      // runtime_kv "identity_model_default:<id>"
export function setDefaultModel(kernel, context, command): Result<ModelRef>;
// conversation/service.ts — as revision 1, plus
onDelta(nodeId: string, jobId: string, delta: RuntimeDelta): void;          // → live.publish(runtime_delta)
```

**Behaviour changes from revision 1:**

1. `sendMessage` resolves the model: `command.model ?? defaultModelFor(identityId)`; none → `unavailable` with `no_default_model`. Thread: `threadFor(identityId, objectiveId)`. Roots for the turn: all `runtime.turn` grant roots on candidate nodes; `localOnly` if any root the prompt names is local-only (S1: computed from the identity — Jester turns are local-only; Vesper turns are not). Payload carries `objectiveActive` (from the Objective's status) so the node can choose auto-allow behaviour honestly and the evaluator makes the actual decision.
2. `onDelta` publishes `{ kind: "runtime_delta", threadId, jobId, itemId, text }` to `LiveBroker`; nothing is written.
3. Sub-agent items are recorded like any item.
4. Objective proposals create `status: "suggested"` Objectives (0.6) and the reply message says so.
5. HTTP: `GET /models` → `{ catalogue, defaults: { vesper, jester } }`; `identity.set_default_model` command.
6. `api/ws.ts`: subscribe to `LiveBroker` and send `runtime_delta` frames to every streaming client (no sequence, no replay).
7. `server.ts` wires `live` into `ApiDeps` and the conversation service.

- [ ] **Step 1: Failing unit tests** — revision 1's six plus: "a free-chat prompt uses the identity's free thread; a prompt with an objectiveId uses that Objective's thread and creates it once"; "a turn with no default model and no override is refused with `no_default_model`"; "a delta is published to LiveBroker and no event is written"; "`identity.set_default_model` persists and is returned by `GET /models`".
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: unit + integration + typecheck PASS. Commit** — `feat(core): the conversation service — a prompt becomes a turn on the model you chose`

### Task 1.7: Node agent — Runtime interface, roots, Codex App Server runtime, probes, adapter

As revision 1 (Step 0 schema generation, env stripper, probes, codex-command port, `codex.ts`, `fake.ts`, adapter, agent changes) with these changes:

- `RuntimeSink` gains `delta(itemId, text)`; `codex.ts` maps `item/agentMessage/delta` to it.
- `runtimes/roots.ts`: `resolveRoots(grant, primaryRootGrantId) → { cwd, writable: string[], readable: string[], localOnly: boolean }`; refuses a primary root the grant lacks; canonicalises paths and resolves junctions (the Phase 3 lesson).
- Codex spawn: `sandbox_mode="workspace-write"`, `cwd = primary root`, `--add-dir` for every other writable root (verify the app-server config key for additional writable dirs in Step 0; if only `thread/start` carries it, pass it there). Read-only roots need nothing: `workspace-write` permits reads.
- `classifyApproval` delegates to `classifyAsk` from Task 1.3 with the resolved roots.
- Probe: `codex login status` for auth mode; the model list from `%USERPROFILE%\.codex\models_cache.json` (`slug`, `display_name`, skip `visibility: "hide"`), `codex --version`.
- Concurrency: the agent already tracks running jobs in a `Map`; ensure two `runtime.turn` jobs run concurrently (0.24) and that the heartbeat and pending-ask maps are per job.
- Node `NOCTIS_RUNTIME=fake` env selects `createFakeRuntime` for E2E.

**Commit** — `feat(node-agent): a runtime behind the node boundary — Codex App Server, real roots, deltas`

### Task 1.8: The proposal channel

As revision 1. **Commit** — `feat(node-agent): the proposal channel, a file the model writes and Noctis validates`

### Task 1.9: Web — Presence sends, Chat streams, approvals answer

As revision 1 plus: the prompt has a model selector (populated from `GET /models`, preselecting the identity default); `useConversation` appends `runtime_delta` text to the in-progress message and replaces it with the committed `agent_message`; Settings gains the per-identity default model control. E2E `chat.test.mjs` with the fake runtime asserts the streamed text appears before the committed message. **Commit** — `feat(web): the prompt sends, Chat streams, and you choose the model`

**Checkpoint 1A:** live run on the home dev core with Codex, `gpt-5.6-sol`, grant roots per 0.18, prompt recorded first: _"Look at the newest three files in my Downloads folder, tell me what they are, and move any screenshots into Documents\Screenshots (create it if needed)."_ Expected: read commands auto-run; the move is a `file_change` inside writable roots → auto-allowed only if an Objective is active, otherwise an approval card appears in Chat; confirming performs it; the Chat text streamed. Record per Task 1.13.

### Task 1.10: Claude runtime via the Agent SDK

**Files:** create `apps/node-agent/src/runtimes/claude.ts` (+ test); modify `apps/node-agent/package.json` (`@anthropic-ai/claude-agent-sdk` pinned), `runtimes/probe.ts`.

- [ ] **Step 1: Failing tests** — with a fake `query` generator: `system/init` yields `sessionRef`; `stream_event` text deltas → `sink.delta`; `assistant` text blocks → `agent_message`; `tool_use` Bash/Edit/Write/Agent → `command`/`file_change`/`sub_agent` items; `canUseTool` → `sink.ask` via `classifyAsk` and returns `{ behavior: "allow" }` / `{ behavior: "deny", message }`; options contain `settingSources: []`, `strictMcpConfig: true`, `permissionMode: "default"`, `cwd`, `additionalDirectories`, `env` without billing keys, `model` from the payload, `includePartialMessages: true`, `resume: sessionRef`; never `--bare`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** with `createSdkMcpServer` hosting the two Noctis tools in-process (no proposals file needed on this route). Probe: `claude auth status` JSON → `claude_ai`; models `[{claude, "sonnet"}, {claude, "opus"}]` (aliases the SDK accepts) plus any exact ids the owner adds in Settings.
- [ ] **Step 4: PASS. Commit** — `feat(node-agent): the Claude route, same asks, same items, its own login`

### Task 1.11: Token deltas through the desktop shell

- [ ] **Step 1:** read `apps/desktop/src-tauri/src/stream.rs`; if it deserialises `ServerFrame` into a closed Rust enum, add the `runtime_delta` variant (fields as the contract) and forward it as `core:frame`; if it forwards raw JSON, no change. Test: the existing Rust stream test gains a `runtime_delta` case.
- [ ] **Step 2:** `TauriTransport` and `BrowserTransport` expose `onFrame` for non-event frames; `useConversation` consumes it. (Browser polling has no deltas until Slice 2's SSE; the page shows items.)
- [ ] **Step 3:** `npm run rust:test` (CI if Smart App Control blocks locally), `npm run test:unit`. **Commit** — `feat(desktop): forward live deltas to the page`

### Task 1.12: The core on the work PC, the home PC as its worker

**Files:** create `docs/operations/work-pc-core.md`; modify `docs/operations/nodes.md`. No code unless a config gap appears.

- [ ] **Step 1 (work PC, via AnyDesk):** clone at the same path, `npm ci` with Node 22.23.2, `npm run build`. Set `NOCTIS_CORE_TOKEN` (32+ chars) in a user-scoped environment variable, `NOCTIS_DATABASE_PATH=%LOCALAPPDATA%\Noctis\core.db`, `NOCTIS_VAULT_ROOT` unset (Slice 2 turns it on). Start `node apps/core/dist/main.js` in a terminal (no service registration yet). `tailscale serve --bg 7717` → note the HTTPS URL. Confirm `/ready` from the home PC over the tailnet.
- [ ] **Step 2 (work PC):** pair a local node (`--host work`), grant `runtime.turn` with `providers: ["codex","claude"]` and the work roots the owner names on that machine; start the agent.
- [ ] **Step 3 (home PC):** `node apps/node-agent/dist/main.js pair --core https://<serve-url> --code <code> --host home`; grant `runtime.turn` with the 0.18 roots: `{ grantId: "jarvis-noctis", path: "C:\\Users\\mmush\\Documents\\Jarvis\\Noctis-OS", mode: "write" }`, `{ grantId: "jarvis-donor", path: "...\\Jarvis-Sub-Agent-Dashboard", mode: "read" }`, `{ grantId: "downloads", path: "C:\\Users\\mmush\\Downloads", mode: "write" }`, `{ grantId: "documents", path: "C:\\Users\\mmush\\Documents", mode: "write" }`, `{ grantId: "vault", path: "C:\\Users\\mmush\\OneDrive\\MindVault", mode: "read", localOnly: false }`, `{ grantId: "inbox", path: "C:\\Users\\mmush\\OneDrive\\MindVault\\inbox", mode: "write" }`. Start the agent. The node agent must accept an `https://` core URL (check `apps/node-agent/src/main.ts`; `wss://` for the socket).
- [ ] **Step 4:** the desktop shell / web on either PC points at the Serve URL (`NOCTIS_CORE_URL`); note the shell's Rust client has no TLS backend by design (Cargo comment) — for Slice 1 the shell on the work PC uses `http://127.0.0.1:7717`, the home PC uses the browser transport over Serve until Slice 2's session realm lands; record this limit.
- [ ] **Step 5:** `nodes.md` documents the two-node topology, `work-pc-core.md` documents start/stop, token rotation (re-pair both nodes), and that autostart/service registration is a separate approval. **Commit** — `docs: the core on the work PC, and two workers`

### Task 1.13: Live evidence, ADRs, status entry

As revision 1's Task 1.10 with the prompt from Checkpoint 1A re-run on the real topology (home node pinned by roots), a second run on `claude/sonnet` for the same prompt in a fresh Objective, a third run from the work node on a work root, and a restart-and-resume check for each identity thread. Record host, versions, auth modes, models, prompts, items, screenshots, and limits (no phone yet; browser transport polling on the home PC; Jester unavailable by design). Write ADR-0020…0027. **Commit** — `docs: Slice 1 evidence — both runtimes, both PCs, streamed`

---

## Part D — Slices 2–5 (task level; expand after Slice 1's evidence)

### Slice 2 — Front door on every device

| #   | Task                                                  | Files                                                                                                                                                                     | Interface / gate                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Session realm (ADR-0028)                              | `apps/core/src/api/auth.ts`, `http.ts`, `BrowserTransport.ts`; port donor `server/lib/assistant-token.js` flow shape                                                      | `POST /session/login {token}` → `HttpOnly; Secure; SameSite=Strict` cookie; `X-Noctis-CSRF` on mutations; `GET /events/live` SSE carrying `event` and `runtime_delta` frames; hostile-origin tests extended.                                                                                                                              |
| 2.2 | Phone shell                                           | port donor `client/src/components/MobileTabBar.tsx`, `hooks/useIsMobile.ts` (ledger rows) into `apps/web`                                                                 | Rail collapses to a tab bar under 720 px; Chat and approvals usable at 400 px; Playwright E2E at phone viewport.                                                                                                                                                                                                                          |
| 2.3 | Web push notifications (0.25)                         | port donor `server/lib/push.js` shape → `apps/core/src/notify/push.ts`; service worker in `apps/web`                                                                      | VAPID keys in the OS credential store/env, never SQLite; subscriptions per session; push on `authority.decision_recorded.v1` (pending), `identity.turn_completed.v1` (failed/blocked or long turn), later Sense. Requires HTTPS = Tailscale Serve.                                                                                        |
| 2.4 | Images and files in the prompt (0.23)                 | `POST /attachments` (core, size cap, content-type allowlist), `attachments` table in 0007, node fetch via node-realm `GET /node/attachments/:id` with the node credential | `conversation.send.attachmentIds[]`; the node downloads into the turn's temp dir and passes them to the runtime (`-i` for Codex, image blocks for Claude); an attachment becomes an `external_reference` artifact until a turn saves it under a root.                                                                                     |
| 2.5 | Live Vault, read-only, plus inbox (ADR-0029)          | `apps/core/src/vault/root.ts` (`live` allowed for indexing), Vault recall into the turn context, `docs/operations/vault.md`                                               | `NOCTIS_VAULT_ROOT` on the work PC points at its OneDrive MindVault copy; index, recall, provenance; writes refused by the Vault service; runtime writes only via `inbox` grant. Preferences/corrections: a `noctis_remember_preference` MCP tool that appends one bullet to `agent/brain.md` under its rules (grep first; 150-line cap). |
| 2.6 | Recovery                                              | as revision 1's 2.4–2.6                                                                                                                                                   | reload before confirm; reconnect re-asks; cancel; pinned host offline → 503 `node_offline` and an offered new thread elsewhere.                                                                                                                                                                                                           |
| 2.7 | Core-side approval Surfaces and `Command.tsx` slimmed | as revision 1's 2.3 and 2.7                                                                                                                                               | `Command.tsx` < 400 lines; page proposes nothing.                                                                                                                                                                                                                                                                                         |
| 2.8 | Desk session                                          | both runbooks                                                                                                                                                             | walk on whichever PC builds the shell.                                                                                                                                                                                                                                                                                                    |

**Gate:** from the phone over Tailscale: send a prompt, watch it stream, get a push, confirm an approval, see the result and the Vault-informed answer.

### Slice 3 — Generality and reach

| #   | Task                                     | Files                                                 | Interface / gate                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Playwright MCP, isolated                 | `apps/node-agent/src/runtimes/mcp-config.ts`          | profile per thread under `%NOCTIS_NODE_HOME%\browser`; allowlist `browser_navigate                                                                                                                                                                                                                                                                                         | snapshot | click | type | take_screenshot`; every call is an ask classed by `classifyAsk`; cookie isolation demonstrated. |
| 3.2 | Windows-MCP, allowlisted (0.13)          | `docs/operations/desktop-control.md`, `mcp-config.ts` | install Python 3.13 + uv on the node PC (documented, owner-run); tools `Click, Type, Scroll, Move, Shortcut, Wait, WaitFor, Screenshot, Snapshot, App, DisplayInventory` only; `PowerShell, Registry, FileSystem, Process, Clipboard` excluded; every action an ask classed `external_write` unless targeting a window of a process Noctis launched inside a granted root. |
| 3.3 | Several Objectives and sub-agents (0.24) | core dispatcher, node agent                           | integration: two turns on two Objectives run concurrently on one node; a Claude `Agent` tool call and a Codex collab agent appear as `sub_agent` items and their tool calls still ask.                                                                                                                                                                                     |
| 3.4 | The recorded unseen task                 | `runtime-live-evidence.md §Unseen`                    | prompt committed before the run; no source edit between.                                                                                                                                                                                                                                                                                                                   |
| 3.5 | Objective change mid-run                 | `turn/steer` / Claude follow-up message               | pinned Surfaces survive.                                                                                                                                                                                                                                                                                                                                                   |
| 3.6 | Missions page (functional)               | `apps/web/src/pages/Missions.tsx`                     | turns, jobs, hosts, models, items, links to Chat.                                                                                                                                                                                                                                                                                                                          |
| 3.7 | Vault attachments as Artifacts (0.30)    | `apps/core/src/vault/indexer.ts`, `artifacts`         | files beside a note (`<note>/…` or Obsidian attachment folder) indexed as `local_artifact` with checksum and provenance to the note; `noctis_record_artifact` MCP tool lets a turn save a file there (write allowed only under that note's folder inside the `inbox` grant until Phase 14).                                                                                |

**Gate:** the unseen prompt completes through generic capabilities; a browser task and a desktop-click task each ask and are auditable; two Objectives at once.

### Slice 4 — Jester, memory, proactivity

| #   | Task                                              | Files                                                                      | Interface / gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Hermes install and interface discovery            | `docs/operations/hermes.md`                                                | Install Hermes on the home PC with its native Windows installer into `%NOCTIS_NODE_HOME%\hermes`; record `hermes --help`, its non-interactive/JSON output mode, its command-approval hook, and its MCP client config. Decide the adapter shape from what exists: (a) stream-JSON CLI mode with an approval callback → same shape as Codex; (b) no approval hook → run Hermes with its shell/file tools disabled and give it only Noctis MCP tools that ask. Write the decision into ADR-0030 before coding. |
| 4.2 | Hermes runtime (ADR-0030)                         | `apps/node-agent/src/runtimes/hermes.ts` (+ test)                          | provider `hermes`, `authMode: "local"`, LM Studio endpoint from config, memory off, cron off, skills dir kept and listed read-only via `GET /skills`; Noctis MCP tools attached; deltas if its stream mode has them. Probe: LM Studio `/v1/models` reachable → models list.                                                                                                                                                                                                                                 |
| 4.3 | LM Studio on the RTX 5070 (0.10)                  | `docs/operations/lm-studio.md`                                             | owner installs; choose a model fitting 12 GB with headroom; record p95 latency and a 20-prompt quality fixture; `local_only` roots route only here.                                                                                                                                                                                                                                                                                                                                                         |
| 4.4 | Jester purposes (0.27)                            | identity profile, routing                                                  | Jester default model = Hermes/LM Studio; `IDENTITY_PROVIDER_ORDER.jester = ["hermes"]`; local-only roots; parallel to Vesper (already, per 0.24); red-team prompt profile stays prepare-only.                                                                                                                                                                                                                                                                                                               |
| 4.5 | Skills and preferences (0.22)                     | `apps/core/src/skills/`, `noctis_remember_preference`                      | skills index (Hermes's folder + Noctis-written recipes after a completed Objective, proposed, never auto-applied to authority); preferences to `agent/brain.md`.                                                                                                                                                                                                                                                                                                                                            |
| 4.6 | Sense, Attention Required, Automations (ADR-0031) | `apps/core/src/{sense,automations}/`, `apps/web/src/pages/Automations.tsx` | suggestions ranked with source/reason/expiry, dismiss/snooze, never activate; Automations: schedule + prompt + identity + model + roots, run as ordinary turns, authority unchanged; interruptions → Attention Required + push.                                                                                                                                                                                                                                                                             |
| 4.7 | The small interpreter, shadow mode                | as revision 1's 4.3                                                        | logged proposals only until benchmarked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Gate:** Jester answers locally and is honestly unavailable when LM Studio is off; a scheduled Automation runs unattended inside its grant; a suggestion appears on the phone and can be dismissed.

### Slice 5 — Journeys and integrations

| #   | Task                                 | Files                                                                                             | Interface / gate                                                                                        |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 5.1 | Journeys as rows and prompts         | `tools.json`, `docs/acceptance/JOURNEYS.md`                                                       | Song, Vinted (publish behind typed confirmation; status from source), Development (real VS Code focus). |
| 5.2 | Personal admin (0.19)                | MCP servers for mail/calendar (choose per account: Microsoft Graph or Gmail MCP), `mcp-config.ts` | read/summarise autonomous; every send is `message_send` → asks with recipient and final content shown.  |
| 5.3 | Wake-on-LAN                          | `docs/operations/WOL.md`                                                                          | topology first; relay if needed; awake ≠ ready.                                                         |
| 5.4 | Mac worker (0.31)                    | `nodes.md`                                                                                        | optional.                                                                                               |
| 5.5 | Shell tool routes as node capability | only if a phone journey needs them                                                                | port the decision, not the executors.                                                                   |

**Backlog (not scheduled):** voice dictation and wake word; NOIR + God's Eye view; Hermes piece ports; content residency for message bodies.

---

## Part E — Hand-off to Astra (after Slice 3)

As revision 1, plus: the model selector and Settings model defaults; the phone tab bar and push permission UX; Automations and Sense suggestion cards; Jester's lime/red identity in Chat; attachment previews in Chat and on notes. Inputs Astra needs: endpoints (`/threads/:id/messages|turns`, `/models`, `/approvals`, `/attachments`, `/events/live`, `/objectives/:id/surfaces`), event names, the Surface payload schemas (now in contracts), tokens, mockup manifest.

---

## Part F — Complexity ledger (for choosing which model runs each task)

Scale: **L1 routine** — mechanical, pattern exists in the repo, low blast radius. **L2 moderate** — some design judgment or one new boundary. **L3 hard** — cross-process or security-sensitive, extends a hardened suite, mistakes are expensive to find. **L4 frontier** — an external interface not yet verified against the installed binary, concurrency, or a new subsystem with safety consequences; wants the strongest model plus a review pass.

| Task                                                   | Level | What makes it that level                                                                                                       |
| ------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Slice 1 overall**                                    | L4    | one live loop across contracts, core, node protocol, two external runtimes, streaming, and a two-PC deployment                 |
| 1.1 Runtime contracts                                  | L2    | many files but mechanical; the one judgment is the schema shapes, which ripple everywhere                                      |
| 1.2 Migration 0006 + conflict kind                     | L1    | SQL and one union member, with an existing migration test pattern                                                              |
| 1.3 Routing + ask classification                       | L2    | pure functions; the classification table is a security decision and needs care, not cleverness                                 |
| 1.4 Node frames, pinning, lease renewal                | L3    | touches the hardened node realm and its 1,153-line integration suite; budgets and lease semantics                              |
| 1.5 Authority decline + linkage                        | L1    | mirrors `confirmAuthority` exactly                                                                                             |
| 1.6 Conversation service                               | L3    | the central service: transactions without nesting, broker subscribers, threads per Objective, model defaults, live broker      |
| 1.7 Codex App Server runtime + adapter + roots         | L4    | experimental JSON-RPC verified from generated schema, process lifecycle, approvals mid-turn, root resolution, concurrent turns |
| 1.8 Proposal channel (MCP + file tail)                 | L2    | small, but a new dependency and a cross-process handshake                                                                      |
| 1.9 Web: Presence sends, Chat streams, model picker    | L2    | functional UI over known endpoints; E2E harness exists                                                                         |
| 1.10 Claude runtime via Agent SDK                      | L3    | SDK mapping, `canUseTool`, settings isolation, model aliases; the cost trap (`--bare`, API key) is here                        |
| 1.11 Deltas through the Rust shell                     | L2    | small Rust change; the cost is the build environment (Smart App Control), not the code                                         |
| 1.12 Work-PC core + home worker (ops)                  | L2    | no code; misconfiguration risk, TLS limits of the shell, token handling                                                        |
| 1.13 Live evidence, ADRs, status                       | L2    | writing with judgment; honesty about what was and was not proven                                                               |
| **Slice 2 overall**                                    | L3    | security realm plus phone plus recovery edge cases                                                                             |
| 2.1 Session realm + SSE                                | L3    | authentication and CSRF; hostile-origin tests must extend                                                                      |
| 2.2 Phone shell port                                   | L1    | donor components with tests already                                                                                            |
| 2.3 Web push                                           | L2    | service worker, VAPID key handling outside SQLite                                                                              |
| 2.4 Attachments in the prompt                          | L3    | new storage, size and type limits, node-realm fetch, two runtime input paths                                                   |
| 2.5 Live Vault read + inbox + brain tool               | L2    | the write switch already exists; the brain append has rules to honour                                                          |
| 2.6 Recovery (reload, reconnect, cancel, host offline) | L3    | distributed edge cases; each needs an integration test that actually drops a socket                                            |
| 2.7 Core-side approval Surfaces, Command.tsx slimmed   | L2    | moving policy, not inventing it; the handoffs test guards regressions                                                          |
| 2.8 Desk session                                       | L1    | manual runbook walk                                                                                                            |
| **Slice 3 overall**                                    | L3    | reach into browsers and the desktop with allowlists; concurrency                                                               |
| 3.1 Playwright MCP, isolated                           | L2    | known tool, profile isolation, allowlist                                                                                       |
| 3.2 Windows-MCP, allowlisted                           | L3    | full-system-access tool constrained by allowlist and asks; install prerequisites                                               |
| 3.3 Concurrent Objectives + sub-agents                 | L3    | concurrency across dispatcher and agent; sub-agent items from two runtimes                                                     |
| 3.4 Recorded unseen task                               | L1    | procedure and honesty, no code                                                                                                 |
| 3.5 Objective change mid-run                           | L2    | steer/follow-up message plumbing                                                                                               |
| 3.6 Missions page (functional)                         | L1    | list over existing reads                                                                                                       |
| 3.7 Vault attachments as Artifacts                     | L2    | indexer extension with checksums and provenance                                                                                |
| **Slice 4 overall**                                    | L4    | a third runtime on a local model, and three new proactive subsystems                                                           |
| 4.1 Hermes interface discovery                         | L2    | investigation and an ADR, no adapter yet                                                                                       |
| 4.2 Hermes runtime                                     | L4    | unknown programmatic surface until 4.1; approval mapping may need Noctis-mediated tools                                        |
| 4.3 LM Studio + model qualification                    | L2    | owner installs; measurement and a quality fixture                                                                              |
| 4.4 Jester routing and profile                         | L1    | data and one routing rule                                                                                                      |
| 4.5 Skills + preferences                               | L2    | index plus one append tool with existing rules                                                                                 |
| 4.6 Sense, Attention Required, Automations             | L4    | new subsystems that act without a prompt; every safety property must be mechanical                                             |
| 4.7 Interpreter, shadow mode                           | L3    | bounded inputs, debounce, benchmark before it matters                                                                          |
| **Slice 5 overall**                                    | L3    | integrations with external accounts and hardware                                                                               |
| 5.1 Journeys as rows + prompts                         | L2    | data plus recorded prompts; Vinted publish is the consequential one                                                            |
| 5.2 Personal admin (mail/calendar MCP)                 | L3    | external accounts, sends behind confirmation, account choice per provider                                                      |
| 5.3 Wake-on-LAN                                        | L2    | topology first; a narrow capability after                                                                                      |
| 5.4 Mac worker                                         | L1    | pairing on another OS                                                                                                          |
| 5.5 Shell tool routes to node                          | L2    | port a decision, not executors                                                                                                 |
| **Astra visual pass**                                  | L3    | creative and cross-cutting; must not touch contracts                                                                           |

Rule of thumb that matches the Agent Brain: L4 and L3 tasks go to the strongest available model with a second-model review; L2 to a capable mid model; L1 to the cheapest model that passes the gates. Whatever runs a task, the gates in Global Constraints are the same.

---

## Self-review against Part 0

Every row in Part 0 names a slice; every slice gate names an observable behaviour. Model choice is data (1.1, 1.6, 1.9, ADR-0026). Both runtimes are Slice 1 (1.7, 1.10). Workspace-write and auto-allow under an active Objective rest on the existing evaluator plus `classifyAsk` (1.3, 1.7). Token streaming is 1.6/1.7/1.9/1.11. Work-PC core is 1.12. Hermes is wrap-first with discovery before code (4.1, 4.2). Phone and push are Slice 2. Grant roots are the real folders from the first live run (1.12). Type names used later match earlier definitions: `ModelRef`, `RuntimeRoot`, `RuntimeSink.delta`, `classifyAsk`, `LiveBroker`, `threadFor`.
