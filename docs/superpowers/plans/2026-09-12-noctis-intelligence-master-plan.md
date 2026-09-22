# Noctis Intelligence Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 2 (2026-09-12, evening).** Revised after a seven-round reverse-prompt with the owner. Part 0 records every answer; the slices, ADRs, and tasks below are rewritten to match. Where revision 1 and this text disagree, this text wins.

> **Revision 3 (2026-09-16).** Adds the phone voice path after the owner's iOS 27 research session: Part 0 rows 0.32–0.35, ADR-0032…0034, and Slices 6 (Siri Shortcuts) and 7 (Noctis as a Claude connector). No native iOS app. Slices 1–5 are unchanged.

> **Revision 4 (2026-09-22).** Business control center and cross-device access. Supersedes conflicting goals, priorities and future-work assumptions in revisions 1–3 and the older Fable brief; preserves implemented Slices 1–2 and tasks 3.1/3.6. This is a planning revision, not permission to deploy or activate capabilities. Stable task IDs are retained; follow the revised execution order below rather than numerical slice order.

**Goal:** Build a personal business control center that unifies existing Codex, Claude and local-agent work, provides access to the owner's machines, and runs useful repeatable business workflows with predictable costs. The business can start before Noctis is finished. Direct use of provider applications remains a first-class option; replacing them is not a success criterion.

**Architecture:** Preserve the implemented core, node-agent runtime adapters, authority boundary, phone access and persistence. The work PC remains the authoritative core; execution stays on the machine owning the relevant files/apps. Add thin coordination over existing runtimes and established remote-desktop software, not a new agent framework or video transport. Hermes/LM Studio remains the local-worker candidate, qualified on bounded business jobs before unattended use. Models propose semantic intent; deterministic code owns authority, scheduling, routing, state and placement. Remote human control is a distinct access path, not an agent approval bypass.

**Tech Stack:** Keep the repository's exact package lock and Node.js 22.23.2. Existing TypeScript/Zod/SQLite/ws/React/Vite/Tauri stack and Codex App Server/Claude adapters remain. Historical runtime/model versions in the completed task descriptions are evidence snapshots, not upgrade instructions: verify installed interfaces before extending them. Hermes + LM Studio is the planned local path; Playwright MCP and Windows-MCP provide agent tools. Remote desktop candidates are Windows RDP and Sunshine/Moonlight; selection and activation are separate from this plan revision.

**Spec:** [`docs/architecture/NOCTIS-FABLE-IMPLEMENTATION-BRIEF.md`](../../architecture/NOCTIS-FABLE-IMPLEMENTATION-BRIEF.md), [`docs/acceptance/INTENT-IMPLEMENTATION-AUDIT.md`](../../acceptance/INTENT-IMPLEMENTATION-AUDIT.md) (findings F1–F13), and Part 0 below (owner's answers, which outrank both where they differ).

---

## Part 0 — What the owner actually wants (2026-09-12 reverse prompt)

Recorded verbatim in intent, paraphrased in wording. Each row names the slice that delivers it.

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                           | Delivered in         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 0.1  | Runtimes execute on the **node agent**, never in the core or the Tauri shell.                                                                                                                                                                                                                                                                                                      | S1                   |
| 0.2  | **Both Codex and Claude in Slice 1.** Astra (`gpt-6-astra`) is only the model building Noctis; in use he picks Sonnet, Opus, Sol, Terra, Luna.                                                                                                                                                                                                                                     | S1                   |
| 0.3  | **Model choice is first-class**: per-identity default in Settings plus a per-turn override on the prompt. Names are not locked to roles ("Sol does X"); new models appear as data, and switching what model does what is a toggle, not a code change. Every turn records provider + model.                                                                                         | S1                   |
| 0.4  | Under an **active Objective, local edits and commands inside granted folders are auto-allowed and audited**. Outside the folders, network, sends, publishes, spends, deletes always ask.                                                                                                                                                                                           | S1                   |
| 0.5  | **Workspace-write from day one.** The first live run may edit files.                                                                                                                                                                                                                                                                                                               | S1                   |
| 0.6  | A prompt with no Objective is **answered in Chat; Vesper may suggest an Objective**, never activate one.                                                                                                                                                                                                                                                                           | S1                   |
| 0.7  | **Token streaming day one**, not item-level only.                                                                                                                                                                                                                                                                                                                                  | S1                   |
| 0.8  | **Jester = Hermes Agent**, MIT, wrapped as a runtime behind the node agent now, pieces ported later with ledger + licence. "Translation" was a one-time port question, settled as wrap-first.                                                                                                                                                                                      | S4                   |
| 0.9  | Hermes's **skills are kept** (visible read-only in Noctis); its **memory and cron are disabled** — Vault owns memory, Noctis owns Automations.                                                                                                                                                                                                                                     | S4                   |
| 0.10 | Local model server: **LM Studio** on the RTX 5070.                                                                                                                                                                                                                                                                                                                                 | S4                   |
| 0.11 | Phone: **the Noctis web app over Tailscale Serve**, porting as much as possible from the donor's mobile surface (`MobileTabBar`, `useIsMobile`, `push.js`, `assistant-token.js`, `DEPLOYMENT.md` Serve procedure).                                                                                                                                                                 | S2                   |
| 0.12 | Thread life: **one runtime thread per Objective plus one free-chat thread per identity.**                                                                                                                                                                                                                                                                                          | S1                   |
| 0.13 | General **Windows desktop control in Slice 3, behind an allowlist** (Windows-MCP: Click/Type/Screenshot/Snapshot/App only).                                                                                                                                                                                                                                                        | S3                   |
| 0.14 | **Read the real MindVault now, write only under `inbox/`** (and attachments beside notes, see 0.30). Vault engine writes elsewhere remain behind Phase 14.                                                                                                                                                                                                                         | S2                   |
| 0.15 | **Core on the work PC from Slice 1**; home PC is a worker.                                                                                                                                                                                                                                                                                                                         | S1                   |
| 0.16 | Develop adaptive UI alongside remote access and business workflows (owner confirmed 2026-09-22). Astra owns frontend visuals once affected contracts stabilise; no need to finish all of Slice 3 first. The tracks can deliver independently.                                                                                                                                      | 4.7, Part E          |
| 0.17 | **Subagent per task, review between tasks, commit per green task**, no AI co-author trailers.                                                                                                                                                                                                                                                                                      | process              |
| 0.18 | Grant roots from the first live run: **`Documents\Jarvis` (Noctis-OS rw, donor ro), `Downloads`, `Documents`, `MindVault` (ro) + `MindVault\inbox` (rw)**. No scratch-only phase.                                                                                                                                                                                                  | S1                   |
| 0.19 | Primary purpose: build a business and side hustles that generate income. TikTok selling, a Shopify store, clothing and promotional product videos are examples, not selected businesses. Exclude models dependent on calling/pitching. Dev, research, Vault and file chores support this purpose; music/personal admin remain optional.                                            | 5.0–5.1, S3–S4       |
| 0.20 | Autonomy: **autonomous inside the boundary, ask at consequences.**                                                                                                                                                                                                                                                                                                                 | S1                   |
| 0.21 | Pre-approved background work is wanted. Use bounded jobs, reviewable outputs and owner-configured notifications. Continuous speculative agent activity and unlimited interruptions are not default requirements.                                                                                                                                                                   | 4.6                  |
| 0.22 | Memory beyond the Vault: **reusable skills** (how a task was done) and **preferences/corrections** (Agent-Brain style). Conversation history is kept regardless.                                                                                                                                                                                                                   | S4                   |
| 0.23 | Input: **typed text, and images/files in the prompt.** Voice and wake word later (backlog).                                                                                                                                                                                                                                                                                        | S2                   |
| 0.24 | **Several Objectives run concurrently; Vesper may spawn sub-agents freely** (runtime-native), all under the same asks.                                                                                                                                                                                                                                                             | S3                   |
| 0.25 | Phone notifications: **approvals waiting, turn/Objective finished or blocked, Sense suggestions.**                                                                                                                                                                                                                                                                                 | S2, S4               |
| 0.26 | Blockers: **try alternatives within scope, then stop with evidence and a proposed next step or capability.**                                                                                                                                                                                                                                                                       | S1 prompt policy     |
| 0.27 | Jester/local models: useful background business work using existing hardware without metered model fallback; private work and creative experiments remain optional. Measure accepted outputs, review time and operating cost, not GPU utilisation.                                                                                                                                 | S4                   |
| 0.28 | NOIR: **low priority**; later gains a "God's Eye" world view over public cameras (public repo).                                                                                                                                                                                                                                                                                    | backlog              |
| 0.29 | Success: less coordination and repeated explanation, dependable access to the right PC, and more usable business output with bounded cost. Continuing to use ChatGPT/Claude directly is expected. Revenue and customer evidence assess the business; Noctis must demonstrate operational benefit separately.                                                                       | all                  |
| 0.30 | **Data boundary:** work-PC data is available on both PCs; the work PC may _request_ work from the personal PC but never reads personal files. Files/images live **beside notes in OneDrive as Obsidian attachments, indexed as Artifacts.**                                                                                                                                        | S1 grants, S3        |
| 0.31 | MacBook: optional worker later.                                                                                                                                                                                                                                                                                                                                                    | backlog              |
| 0.32 | **Phone voice via Siri Shortcuts over the tailnet** (owner, 2026-09-16). Siri is a front door: "Hey Siri, Noctis …" runs a Shortcut that calls the private Tailscale Serve URL. No public exposure. Voice moves from backlog to Slice 6.                                                                                                                                           | S6                   |
| 0.33 | **Noctis as a Claude custom connector (remote MCP)** so the Claude iPhone app and CarPlay can call Noctis tools by voice. claude.ai connects from Anthropic's cloud, so this needs a public ingress: authorised in principle for the MCP surface only, behind OAuth; still needs a fresh approval by name before it goes live. The core API stays private; Funnel stays forbidden. | S7                   |
| 0.34 | Native iPhone app is optional, not blocked by absence of paid membership: free Personal Team signing expires after seven days and capabilities vary. Keep the working PWA; reconsider native only for a specific valuable feature and acceptable signing maintenance. No dependency on future Siri releases.                                                                       | backlog              |
| 0.35 | **Noctis never prompts Siri.** There is no inbound Siri API. Noctis → phone is web push (2.3) and, only if a journey needs it, remotely triggered Shortcuts via Pushcut (external, about $2–4/month) — backlog.                                                                                                                                                                    | S2                   |
| 0.36 | Unify existing assistants; preserve their native interfaces and capabilities. No custom replacement planning loop or mandatory chat migration.                                                                                                                                                                                                                                     | S3–S4                |
| 0.37 | Full human remote desktop, keyboard/mouse and terminal access between devices is a real requirement, separate from agent remote sessions. Reuse established transport first.                                                                                                                                                                                                       | 3.8–3.10             |
| 0.38 | Wake home PC remotely where hardware/topology supports it; powered off, awake, network reachable and desktop ready are distinct states.                                                                                                                                                                                                                                            | 5.3, brought forward |
| 0.39 | Local compute is for useful jobs without accumulating API credits. Jev is a paid hosted candidate and is not selected, installed or a required dependency.                                                                                                                                                                                                                         | S4                   |
| 0.40 | Cool/fun design is an explicit creative benefit. Adaptive panels/windows are an active parallel track, not relegated to backlog; they do not gate business execution or remote access.                                                                                                                                                                                             | 4.7, Part E          |
| 0.41 | One initial business workflow, chosen with the owner, should justify automation. No autonomous storefront creation, purchases, publishing or multi-business expansion is implied.                                                                                                                                                                                                  | 5.0–5.1              |

**One consequence to be aware of (0.15 + 0.30):** with the core on the work PC, the core database — including message bodies of turns that ran at home — lives on the work PC. File _contents_ never leave the home node (grants), but conversation text does. Accepted for now; if that becomes unacceptable, the repair is content residency (bodies stored on the node that ran the turn, core keeps references), which `identity_message_content` was shaped to allow.

---

## Revision 4 — Current status, priorities and business test

### Preserve completed work

- [x] Slice 1: implemented, owner-reported on 2026-09-22; retain existing evidence and runtime contracts.
- [x] Slice 2: implemented, owner-reported on 2026-09-22; retain the PWA, notifications, attachments and recovery paths.
- [x] Task 3.1: implemented; commit `3f14c41` supplies the isolated browser capability.
- [x] Task 3.6: implemented; commit `8e39704` supplies Missions and execution provenance.
- [x] Task 3.8: discovery complete 2026-09-22 — `docs/operations/remote-access.md`. Recommends the IronRDP web component behind Devolutions Gateway and **stops for the owner's answer**: embedded panel with exclusive handover (RDP evicts the console session, so agent GUI work stops while a human is connected), or console sharing with a launcher. 3.9 does not start until that is answered.
- [x] Task 5.3: discovery complete 2026-09-22 — `docs/operations/WOL.md`. Hardware is ready (S3, no Modern Standby, NIC already wake-armed); blocked on an always-on LAN relay and on node-agent autostart, which is free and needs only the approval the plan already keeps default-off.
- [~] Task 3.3: first half proven 2026-09-22 by fixture — two Objectives run at once on one node, answer out of order and keep their threads and runtime sessions apart (`conversation.integration.test.ts`). It needed no code; the router's `activeLeases` was already a tie-break rather than a cap. The sub-agent half still needs both runtimes live.
- [ ] Remaining Slice 3 and new access/business tasks: planned unless independently recorded as complete elsewhere.

This revision inspected the current plan, source paths and commit history; it did not rerun completed acceptance gates. Do not replay Slice 1/2 implementation or replace Missions. Reconcile any later commits before extending the task list.

### Next work and decision gates

1. **In parallel with business selection:** complete 3.8 remote-access discovery, then 3.9/3.10 using existing software. Discover 5.3 wake topology early; absence of a relay must not block access to an already-awake PC.
2. **Select the first business experiment (5.0):** customer, offer, acquisition channel without required calls/pitches, allowed inputs, budget, and a concrete output. Do not silently select TikTok, Shopify or clothing on the owner's behalf. Business execution starts with existing tools now.
3. **Finish only relevant reach:** 3.2, 3.3 and 3.5 where the chosen workflow needs desktop tools, concurrency or steering; 3.7 where it needs attachment provenance. Record 3.4 against a previously unseen variation of that real workflow. Retain broader generality work as planned, not a launch dependency.
4. **Qualify local work:** 4.1–4.5, then the minimum scheduled-job subset of 4.6. Prefer scripts/existing tools for deterministic transformations. Do not build all proactive subsystems before delivering one useful overnight job.
5. **Evaluate 5.1:** compare real repeated work with direct Codex/Claude/Hermes use. Expand only when accepted output or reduced coordination exceeds review and maintenance burden.
6. **Active parallel track from now: 4.7 adaptive workspace and Part E.** Develop alongside remote access and business workflows, as the owner chose. Share stable surface contracts and keep each track independently deliverable. Personal admin, Mac worker, Slices 6–7 and native iOS remain optional.

### Business acceptance, not infrastructure activity

Proposed trial: two weeks or enough comparable runs to expose repeat failures; this is an evaluation window, not a promised time to revenue. Record baseline hands-on time, accepted/rejected outputs, corrections, failure/recovery rate, review time, and maintenance time. Record local elapsed time/energy estimate where measurable; do not claim a saving from unmeasured electricity or idle GPU capacity. Track business outcomes separately (e.g. enquiries, clicks, conversions, margin), selecting metrics appropriate to the chosen offer.

Each automation needs explicit inputs, output location, success checks, schedule/trigger, time/resource limits, stop/cancel, retry policy and a review boundary. Preparation can run unattended inside existing grants; sends, listings, publishing, purchases and spend retain their existing approvals. Availability near 24/7 is desired; constant inference is not. If the workflow is not useful manually, do not scale its automation.

### Assumptions awaiting owner preference

Owner confirmed adaptive UI should develop alongside remote access and business workflows and already uses AnyDesk. Working assumption from the earlier request for complete remote view/control: an embedded Noctis desktop panel is the target; a launcher alone is not acceptance. The follow-up clarification remains open and can amend this planning assumption. AnyDesk remains the fallback. The first business, spending budget, local model, home-LAN wake relay and embeddable remote backend remain unselected. Ask only when a task depends on the answer; continue independent work.

## Global Constraints

Every task's requirements implicitly include this section.

- **Donor:** `C:\Users\mmush\Documents\Jarvis\Jarvis-Sub-Agent-Dashboard` is read-only. Every port gets a `DONOR-PORT-LEDGER.md` row _before_ the copy. `npm run test:boundary` before and after any port. Hermes ports get the same treatment under its MIT licence in `NOTICE.md`.
- **Node:** use Node.js 22.23.2 and the exact package lock locally and in CI. Historical mentions of Node 24 are not permission to change the toolchain.
- **Module system:** ESM, `"module": "NodeNext"`. Relative imports end in `.js`. Types via `import type`.
- **Strictness:** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. Spread-omit optional fields.
- **Schemas:** every Zod object schema ends in `.strict()`. Every cross-process message (node frame, runtime JSON-RPC, MCP tool input, HTTP body, Rust-forwarded frame) is parsed through its schema before use.
- **Commands:** every mutation is a command with a required `idempotencyKey`, through `runCommand`. Never nest `runCommand`; extract `…InTransaction(tx, …)` helpers.
- **Events:** append-only names in `packages/contracts/src/events.ts`. Delivery after commit via `kernel.broker`. Token deltas are the one ephemeral channel and are never written to `orchestration_events`.
- **Authority:** the operation class of a capability is fixed by the capability. Models never receive coordinates, never confirm, never grant. The runtime cannot proceed past an ask until the node forwards the core's answer.
- **Cost:** current scope registers no metered model adapter and permits no silent paid fallback. Spawned runtimes never see `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`; `claude --bare` is forbidden. Auth mode is probed and enforced. Jev remains research-only unless separately approved. Local inference still has resource and maintenance costs; no claim of free/unlimited production.
- **Isolation of spawned runtimes:** Claude: `settingSources: []`, `strictMcpConfig: true` (the owner's `~/.claude/settings.json` carries Jarvis hooks). Codex: `--ignore-user-config` if `app-server` accepts it, else explicit `-c` overrides (Task 1.7 verifies). Hermes: its own config dir under `%NOCTIS_NODE_HOME%\hermes`, memory and cron off.
- **No listeners on workers:** Noctis node agents remain outbound-only; their MCP children use stdio. An established remote-desktop host may require its own listener: document its authentication, tailnet-only exposure and access scope, and obtain activation approval before enabling it. This exception does not expose the core or give agents raw desktop input authority.
- **Production capabilities:** the owner authorised on 2026-09-12: the core on the work PC, Tailscale Serve for the core (private, never Funnel), pairing the home PC as a worker, and the grant roots in 0.18. Still default-off and needing a fresh approval by name: Windows service/autostart registration, Vault writes outside `inbox/` and attachment folders, any publish/send/spend, Wake-on-LAN hardware config.
- **Tests:** colocated `*.test.ts`; integration tests `*.integration.test.ts`; one focused failing test before each behaviour; red then green. Fixture proof (fake runtime) and live proof are labelled separately in `IMPLEMENTATION-STATUS.md`.
- **Verification before commit:** `npm run format:check && npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build`; Rust gates when a `.rs` changed; `npm run test:e2e` when `apps/web` changed.
- **Commit style:** `feat(area): …` / `fix(area): …` / `docs: …`. No AI co-author trailers (Agent Brain rule).
- **Secrets:** never in SQLite, logs, or docs. Probes report a mode string, never a token.

---

## Part A — Decisions to record (ADR-0020 … ADR-0034)

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

**ADR-0031 — Bounded Automations before broad proactivity.** Slice 4 first delivers scheduled useful jobs with output evidence, cancellation, resource limits, overlap prevention and restart-safe status. Reuse the current scheduler/authority path; Hermes cron stays off in the managed adapter to avoid two schedulers. Sense is optional until a real workflow benefits. Suggestions never activate Objectives; notifications are configurable and tied to actionable events.

**ADR-0032 — Siri is a front door, not a backend.** iOS 27's Siri AI reaches third-party code only through App Intents (a signed native app) or by running Shortcuts. Noctis exposes a small `shortcuts` surface — prompt, status, answer-ask — behind a scoped, revocable device token; Shortcuts on the tailnet call it over Tailscale Serve. Spoken replies are deterministic one-sentence summaries the core builds from turn state; no model call. `destructive` asks are refused on this surface and must be answered on a screen. Slice 6.

**ADR-0033 — A Claude custom connector on its own ingress (scopes the "never Funnel" rule; amends the production-capabilities constraint).** claude.ai reaches custom connectors from Anthropic's cloud, so the connector needs a public hostname. The core's MCP transport (Streamable HTTP, `@modelcontextprotocol/sdk` already in the node agent) binds its own port and is the only thing the public ingress forwards; the core API remains loopback plus private Tailscale Serve. Auth is OAuth 2.1 with the core as resource server validating JWTs from an external authorization server (Auth0 free tier first; a core-hosted server only if its limits bite). Tools are read-mostly plus `noctis_prompt` and `noctis_answer_ask` (never `destructive`); every input parsed through a strict schema; every mutation an ordinary command. Tailscale Funnel remains forbidden for the core; the ingress is Cloudflare Tunnel (free). Slice 7.

**ADR-0034 — Native iOS is optional; free signing is possible.** Keep the working PWA. Apple Personal Team permits personal-device testing with seven-day provisioning and capability limits. Revisit native for a concrete feature, not an assumed mandatory annual fee or speculative Siri release. Recheck Apple capability/signing rules before implementation.

### Sequence

Task IDs are stable references, not execution priority. Revision 4's order above is authoritative.

| Slice                                          | Status and purpose                                                                           | Deferred / not required                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1 — runtime loop                               | Implemented per owner; preserve Codex/Claude integration and boundaries                      | Rebuilding provider applications                            |
| 2 — device front door                          | Implemented per owner; preserve phone/PWA and recovery                                       | Native rewrite                                              |
| 3 — reach and machine access                   | 3.1/3.6 done; extend relevant agent capabilities and add 3.8–3.10 human remote access        | Custom video engine; all concurrency before first workflow  |
| 4 — useful local jobs and parallel adaptive UI | Hermes/LM Studio qualification, bounded Automations; 4.7 runs alongside access/business work | Broad Sense; making one track a prerequisite for the others |
| 5 — business experiment and integrations       | 5.0 first-workflow selection; 5.1 measured delivery; 5.3 wake discovery pulled forward       | Personal admin and Mac unless needed                        |
| 6 — Siri Shortcuts                             | Optional convenience after a demonstrated need                                               | Voice as a business launch gate                             |
| 7 — Claude connector                           | Optional; explicit ingress approval still applies                                            | Public ingress solely to duplicate working access           |

Part C is retained as completed Slice 1 implementation history. Part D defines remaining task/file/interface boundaries; expand only the next selected task into a focused executable plan, verifying current files and interfaces first.

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

## Part D — Slices 2–7 (task level; preserve completed work, expand next selected task)

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

### Slice 3 — Generality, business reach and human machine access

| #    | Task                                               | Files                                                                                                | Interface / gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | **Implemented** — Playwright MCP, isolated         | `apps/node-agent/src/runtimes/mcp-config.ts`                                                         | profile per thread under `%NOCTIS_NODE_HOME%\browser`; allowlist `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_take_screenshot`; every call is classified by `classifyAsk`; retain recorded cookie-isolation evidence.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 3.2  | Windows-MCP, allowlisted (0.13)                    | `docs/operations/desktop-control.md`, `mcp-config.ts`                                                | install Python 3.13 + uv on the node PC (documented, owner-run); tools `Click, Type, Scroll, Move, Shortcut, Wait, WaitFor, Screenshot, Snapshot, App, DisplayInventory` only; `PowerShell, Registry, FileSystem, Process, Clipboard` excluded; every action an ask classed `external_write` unless targeting a window of a process Noctis launched inside a granted root.                                                                                                                                                                                                                                                                                                   |
| 3.3  | **Half done** — concurrency proven; sub-agents     | core dispatcher, node agent                                                                          | integration: two turns on two Objectives run concurrently on one node; a Claude `Agent` tool call and a Codex collab agent appear as `sub_agent` items and their tool calls still ask.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3.4  | The recorded unseen task                           | `runtime-live-evidence.md §Unseen`                                                                   | prompt committed before the run; no source edit between.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3.5  | Objective change mid-run                           | `turn/steer` / Claude follow-up message                                                              | pinned Surfaces survive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3.6  | **Implemented** — Missions page (functional)       | `apps/web/src/pages/Missions.tsx`                                                                    | turns, jobs, hosts, models, items, links to Chat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3.7  | Vault attachments as Artifacts (0.30)              | `apps/core/src/vault/indexer.ts`, `artifacts`                                                        | files beside a note (`<note>/…` or Obsidian attachment folder) indexed as `local_artifact` with checksum and provenance to the note; `noctis_record_artifact` MCP tool lets a turn save a file there (write allowed only under that note's folder inside the `inbox` grant until Phase 14).                                                                                                                                                                                                                                                                                                                                                                                  |
| 3.8  | **Discovered** — remote-access and embedding       | New `docs/operations/remote-access.md`; existing node status and Missions reads                      | Inventory real hosts, tailnet routes, display/session behaviour and auth. Baseline current AnyDesk. Evaluate maintained backends including RDP and Sunshine/Moonlight, but separately prove a supported embed path in the actual Noctis client; a native client launch is not embedding and a browser cannot be assumed to speak RDP/GameStream. Record licence, integration cost, keyboard/mouse, resolution, measured latency, network path and deployment boundaries. Prefer existing libraries/gateways; stop for an owner decision if embedding requires a new transport or unacceptable compromise. ORION is an architectural reference, not proof or copy permission. |
| 3.9  | Embedded remote desktop panel (working assumption) | Existing node/Missions UI and Tauri/web integration selected by 3.8; exact files in its focused plan | Reuse the selected maintained backend. Show target host, connection/control state, full keyboard/mouse input and disconnect; never show a snapshot loop as equivalent to interactive video. Authenticate with the backend, validate destinations/session ownership, keep credentials server-side/out of logs, and verify unauthorized connection/input rejection. State desktop versus PWA support explicitly. Preserve AnyDesk/client handoff as fallback, not completion. No custom codec/video transport.                                                                                                                                                                 |
| 3.10 | Agent/human handover and acceptance                | Node execution coordination; `docs/operations/runtime-live-evidence.md`                              | One owner of a shared GUI/input surface at a time: pause conflicting agent GUI actions before takeover and explicitly resume afterwards; headless/isolated jobs may continue. No orphaned input lease after disconnect. Verify keyboard, mouse, terminal, display scaling, reconnect, locked/logged-out behaviour and denied access on the actual route. Record resolution, observed latency and limitations; do not label untested access AnyDesk-equivalent.                                                                                                                                                                                                               |

**Remote gate:** from the work PC, open the home desktop inside the supported Noctis client, use a real terminal and GUI, resize/reconnect, then release control and resume the agent without competing input. Record latency/resolution against the existing AnyDesk baseline; agree target thresholds during 3.8 rather than invent them here. Wake adds its separate 5.3 readiness gate. An external-client launch or snapshot-only panel does not satisfy the assumed embedded requirement. Unsupported web/PWA embedding must be stated honestly and must not prevent a supported desktop path.

**Gate:** the unseen prompt completes through generic capabilities; a browser task and a desktop-click task each ask and are auditable; two Objectives at once.

### Slice 4 — Qualified local workers and bounded business automation

| #   | Task                                      | Files                                                                                                       | Interface / gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Hermes install and interface discovery    | `docs/operations/hermes.md`                                                                                 | Install Hermes on the home PC with its native Windows installer into `%NOCTIS_NODE_HOME%\hermes`; record `hermes --help`, its non-interactive/JSON output mode, its command-approval hook, and its MCP client config. Decide the adapter shape from what exists: (a) stream-JSON CLI mode with an approval callback → same shape as Codex; (b) no approval hook → run Hermes with its shell/file tools disabled and give it only Noctis MCP tools that ask. Write the decision into ADR-0030 before coding.                                                                                                                                                           |
| 4.2 | Hermes runtime (ADR-0030)                 | `apps/node-agent/src/runtimes/hermes.ts` (+ test)                                                           | provider `hermes`, `authMode: "local"`, LM Studio endpoint from config, memory off, cron off, skills dir kept and listed read-only via `GET /skills`; Noctis MCP tools attached; deltas if its stream mode has them. Probe: LM Studio `/v1/models` reachable → models list.                                                                                                                                                                                                                                                                                                                                                                                           |
| 4.3 | LM Studio/model qualification             | `docs/operations/lm-studio.md`                                                                              | Retain RTX 5070 as initial candidate, verify actual VRAM and workload headroom. Evaluate at least 20 representative inputs from 5.0, including failures; record accepted outputs, review time, latency and resource use against the current direct-tool baseline. Select by useful output, not model size. No model installation or metered fallback implied.                                                                                                                                                                                                                                                                                                         |
| 4.4 | Jester as a useful local worker           | identity profile, routing                                                                                   | Keep Hermes/local routing and honest offline status. Use bounded preparation/inspection jobs from 5.0. Personality is optional; do not create additional identities, independent memories or schedulers without a distinct need.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4.5 | Skills and preferences (0.22)             | `apps/core/src/skills/`, `noctis_remember_preference`                                                       | skills index (Hermes's folder + Noctis-written recipes after a completed Objective, proposed, never auto-applied to authority); preferences to `agent/brain.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4.6 | Bounded Automations first; Sense optional | Existing scheduler/authority services; `apps/web/src/pages/Automations.tsx`; extend only missing interfaces | Schedule/trigger + input/output scope + identity/model + timeout + concurrency/resource limit + success check + review policy. Prevent duplicate runs/overlap, bounded retry, cancellation and clear offline/blocked states; reconcile interrupted jobs without replaying consequential effects. Reuse existing engine or maintained integration before a new subsystem. Pause/queue around interactive GPU/desktop use. Source evidence, output and actionable notification per run.                                                                                                                                                                                 |
| 4.7 | Adaptive workspace, active parallel track | Existing proposal/compositor boundary; focused design before new files                                      | Context model proposes which panels/windows to show, open or prioritise and their relative arrangement; deterministic compositor computes geometry and enforces pins/manual overrides. Candidate surfaces/actions may be generated dynamically; do not reduce the requirement to canned layouts. Event-triggered inference with debounce, explicit correction/undo and stable focus. Start with shadow proposals then opt-in application after qualification. Model/runtime choice is separate from Vesper and Jester; benchmark a small local candidate without requiring full Hermes scheduling first. No per-frame calls or metered fallback; Jev is not selected. |

**Gate:** a chosen business preparation job produces reviewable usable output locally, runs on its approved schedule, survives cancel/restart/offline cases honestly, and reports its costs/limits without any metered fallback. Compare at least one repeated batch with the direct-tool baseline. A Sense card or persona alone does not pass this gate.

### Slice 5 — Business experiment, results and selective integrations

| #   | Task                                                | Files                                                                                       | Interface / gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.0 | Choose one real business workflow before automating | New `docs/acceptance/BUSINESS-WORKFLOW.md` after owner selection                            | Record customer/offer, acquisition without required calling/pitching, inputs and rights to use them, baseline manual steps, budget, output, success metric and review boundary. Research/preparation may start with existing tools immediately. No storefront, inventory, ad spend or public account actions are authorised by this document.                                                                                                                                                                                                        |
| 5.1 | Deliver and measure the chosen workflow             | `docs/acceptance/JOURNEYS.md`, existing Missions/Artifacts; tool catalogue only when needed | Link experiment, inputs, prompt/model/host, outputs and review result using existing Objectives/Artifacts before new entities. Compare repeated runs with manual/direct-assistant baseline. Example candidates: product-content drafts, approved-data research, catalogue QA or asset processing. These are options, not authority to publish or choose a business.                                                                                                                                                                                  |
| 5.2 | Personal admin, optional                            | Existing account-specific MCP integration points                                            | Implement only if the chosen workflow needs it. Reads within grants; sends show recipient and final content and require approval. No new account connections implied.                                                                                                                                                                                                                                                                                                                                                                                |
| 5.3 | **Discovered** — Wake-on-LAN topology               | `docs/operations/WOL.md`; existing node capability path only if needed                      | Inspect actual motherboard/NIC, firmware, Windows power states and home LAN. Require an always-on home-LAN relay/router/NAS for remote wake; Tailscale alone cannot wake an offline endpoint. Prefer an existing WoL tool such as UpSnap. Activation/hardware changes need separate approval. Distinguish wake requested, reachable, worker authenticated and desktop ready; timeout honestly. Verify sleep and shutdown separately, including post-boot login/unlock limits. Missing relay is a named blocker, not permission to purchase hardware. |
| 5.4 | Mac worker (0.31)                                   | `nodes.md`                                                                                  | optional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5.5 | Shell tool routes as node capability                | only if a phone journey needs them                                                          | port the decision, not the executors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**Backlog (not scheduled):** broad Sense/proactivity, personal admin not serving the selected workflow, Mac worker, wake word, native iOS/App Intents for a concrete capability (free signing possible; seven-day maintenance), Pushcut, NOIR/God's Eye, Hermes code ports and content residency. Adaptive UI (4.7) is explicitly active alongside access/business work. Slices 6–7 below are retained designs, not the next scheduled work; recheck provider features, costs and device support before promoting either.

### Slice 6 — Voice front door via Siri Shortcuts (0.32, ADR-0032)

Depends on Slice 2 (Tailscale Serve, session realm, web push). The phone is on the tailnet, so nothing here is public. If the owner's test shows the iOS 27 Siri app chains Shortcuts conversationally, only 6.4 changes.

| #   | Task                            | Files                                                                                 | Interface / gate                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | Device token, scope `shortcuts` | `apps/core/src/api/auth.ts` (extend the session realm's token flow), Settings → Phone | Issued once from Settings, shown once, stored in the Shortcut as `Authorization: Bearer …`; revocable; scope allows only 6.2's routes; hostile-origin and wrong-scope tests extend the realm suite.                                                                                                                                                                              |
| 6.2 | Shortcut-facing routes          | `apps/core/src/api/shortcuts.ts`                                                      | `POST /shortcuts/prompt {text, identity?, model?}` → a turn in Chat (0.6) or the active Objective's thread, returns `{threadId, turnId, say}`; `GET /shortcuts/status` → `{say}`; `POST /shortcuts/answer {decision}` → answers the oldest pending non-destructive ask, `409 destructive_needs_screen` otherwise. Strict Zod on every body; every mutation through `runCommand`. |
| 6.3 | Spoken summaries                | `apps/core/src/conversation/say.ts`                                                   | Pure function: turn state + pending asks → one sentence ≤ 200 chars ("Finished: 3 files edited in Noctis-OS; 1 approval waiting"). No model call. Table-driven test. `// ponytail: templates; a model-written summary if the templates ever mislead`.                                                                                                                            |
| 6.4 | The Shortcuts and the runbook   | `docs/operations/phone-shortcuts.md`                                                  | Four Shortcuts the owner builds on the phone, action by action: Noctis Ping, Noctis Ask (Dictate Text → Get Contents of URL → Speak), Noctis Status, Noctis Approve (Speak the ask → Ask for Input yes/no → POST). Includes the CarPlay note (Siri button, no wake word for Noctis).                                                                                             |
| 6.5 | Evidence                        | `docs/operations/runtime-live-evidence.md`                                            | From the phone and from the car: Ask → turn streams on the desk → push → Status spoken → Approve answers a real ask. Recorded with host, iOS build, and limits.                                                                                                                                                                                                                  |

**Gate:** hands-free from the car: a dictated prompt runs on the chosen model, a push arrives, the status is spoken back, one non-destructive ask is answered by voice, and a destructive ask is correctly refused to the screen.

### Slice 7 — Noctis as a Claude connector, remote MCP (0.33, ADR-0033)

Optional and unscheduled. Depends on Slice 6 summaries/command paths only if those remain useful; do not build voice merely to satisfy an old dependency. Needs fresh approval by name for public ingress before 7.3 runs live. Recheck existing connector options, auth requirements and free-tier limits before committing to Auth0/Cloudflare.

| #   | Task                               | Files                                                                                              | Interface / gate                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | MCP server in the core             | `apps/core/src/mcp/server.ts`, `tools.ts`; `@modelcontextprotocol/sdk` 1.30.0 added to `apps/core` | Streamable HTTP on `NOCTIS_MCP_PORT` (own listener, loopback bind). Tools: `noctis_status`, `noctis_threads`, `noctis_thread_messages`, `noctis_vault_search` (read), `noctis_prompt`, `noctis_answer_ask` (non-destructive only). Every input `.strict()`; every mutation via `runCommand`; the server proposes nothing. Integration test with the SDK client. |
| 7.2 | OAuth 2.1, core as resource server | `apps/core/src/mcp/auth.ts`, `docs/operations/connector-auth.md`                                   | Auth0 tenant (owner creates; free tier) with dynamic client registration on for claude.ai; core validates JWTs (issuer, audience, expiry, scope) with `jose`; serves `/.well-known/oauth-protected-resource`. Tests: expired, wrong audience, wrong scope, unsigned → 401.                                                                                      |
| 7.3 | Public ingress, MCP port only      | `docs/operations/connector-ingress.md`                                                             | Cloudflare Tunnel on the work PC forwarding one hostname → `127.0.0.1:NOCTIS_MCP_PORT` only. The core API, node realm, and Serve URL are unreachable through it (test from outside the tailnet). Rate limit on the MCP listener. Funnel not used. Default-off until approved by name.                                                                           |
| 7.4 | Register and use                   | claude.ai → Settings → Connectors → Add custom connector                                           | Connector visible in the Claude iPhone app; from CarPlay's Claude voice mode: "ask Noctis what's running" → `noctis_status`; "tell Noctis to …" → `noctis_prompt`; a Vault question → `noctis_vault_search`.                                                                                                                                                    |
| 7.5 | Evidence                           | `docs/operations/runtime-live-evidence.md`                                                         | Recorded from the car: tool calls in the core log, the spoken answer, latency, and what Claude did when a tool was refused.                                                                                                                                                                                                                                     |

**Gate:** from CarPlay, through the Claude app, a spoken sentence becomes a Noctis turn on the work PC and its result is spoken back; the core API is provably unreachable from the public hostname.

---

## Part E — Functional and creative frontend tracks

Develop three independently deliverable surfaces alongside each other: machine access, business work/results, and adaptive workspace (4.7). Extend implemented Missions rather than replace it; keep model selection, approvals, artifacts and recovery clear. Preserve provider-native escape paths. Astra owns frontend visuals once each affected contract stabilises; do not wait for all Slice 3 work. Adaptation must respect pins, manual changes and stable focus. Phone/native work is driven by a missing user capability, not a platform preference alone.

**Adaptive gate:** use the same recorded context changes to compare model proposals with a stable/manual workspace. Show a relevant panel, arrange it relative to current work, preserve a pinned surface, respect a recent manual correction, undo an applied change and handle an unavailable model without layout churn. Record proposal latency and unwanted focus/layout changes. Visual enjoyment is a valid outcome, reported separately from business productivity. Validate at the relevant render/interaction boundary before claiming improvement.

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
| 3.8 Remote backend/embedding discovery                 | L3    | client compatibility, licensing and actual measurements against AnyDesk                                                        |
| 3.9 Embedded desktop integration                       | L4    | supported embed interface, session authentication, input and platform compatibility; discovery first                           |
| 3.10 Human/agent handover                              | L3    | exclusive GUI control and disconnect recovery                                                                                  |
| 5.0 Business selection                                 | L2    | owner choice and measurable experiment, not infrastructure                                                                     |
| **Slice 4 overall**                                    | L4    | local runtime approval mapping and restart-safe scheduled work; broad proactivity is optional                                  |
| 4.1 Hermes interface discovery                         | L2    | investigation and an ADR, no adapter yet                                                                                       |
| 4.2 Hermes runtime                                     | L4    | unknown programmatic surface until 4.1; approval mapping may need Noctis-mediated tools                                        |
| 4.3 LM Studio + model qualification                    | L2    | owner installs; measurement and a quality fixture                                                                              |
| 4.4 Jester routing and profile                         | L1    | data and one routing rule                                                                                                      |
| 4.5 Skills + preferences                               | L2    | index plus one append tool with existing rules                                                                                 |
| 4.6 Bounded Automations                                | L3    | overlap, cancellation, restart and consequential retry safety; optional Sense scoped separately                                |
| 4.7 Adaptive workspace, parallel                       | L3    | context selection, stable focus and manual overrides; shadow evaluation first                                                  |
| **Slice 5 overall**                                    | L3    | integrations with external accounts and hardware                                                                               |
| 5.1 Measured business workflow                         | L2    | selected workflow, provenance and measured acceptance; external publication remains separately approved                        |
| 5.2 Personal admin (mail/calendar MCP)                 | L3    | external accounts, sends behind confirmation, account choice per provider                                                      |
| 5.3 Wake-on-LAN                                        | L2    | topology first; a narrow capability after                                                                                      |
| 5.4 Mac worker                                         | L1    | pairing on another OS                                                                                                          |
| 5.5 Shell tool routes to node                          | L2    | port a decision, not executors                                                                                                 |
| **Slice 6 overall**                                    | L2    | three routes and a template function; the token scope is the one security decision                                             |
| 6.1 Device token with scope                            | L2    | extends the hardened realm; scope enforcement must be tested hostile-first                                                     |
| 6.2 Shortcut routes                                    | L1    | thin over existing commands                                                                                                    |
| 6.3 Spoken summaries                                   | L1    | pure templates, table test                                                                                                     |
| 6.4 Shortcuts runbook                                  | L1    | owner builds them by hand; the doc must be exact                                                                               |
| 6.5 Evidence                                           | L1    | procedure and honesty                                                                                                          |
| **Slice 7 overall**                                    | L3    | a second listener, OAuth, and a public ingress into a security-hardened core                                                   |
| 7.1 MCP server in the core                             | L2    | known SDK, tools map to existing commands; the refusal classes matter                                                          |
| 7.2 OAuth resource server                              | L3    | JWT validation is security-sensitive; DCR and discovery must match what claude.ai expects                                      |
| 7.3 Public ingress                                     | L3    | no code, high blast radius; the "unreachable" proof is the gate                                                                |
| 7.4 Register and use                                   | L1    | configuration on claude.ai                                                                                                     |
| 7.5 Evidence                                           | L1    | procedure and honesty                                                                                                          |
| **Astra visual pass**                                  | L3    | creative and cross-cutting; must not touch contracts                                                                           |

Rule of thumb that matches the Agent Brain: L4 and L3 tasks go to the strongest available model with a second-model review; L2 to a capable mid model; L1 to the cheapest model that passes the gates. Whatever runs a task, the gates in Global Constraints are the same.

---

## Self-review against Part 0

Revision 4 preserves runtime contracts, completed Slices 1–2 and tasks 3.1/3.6. Rows 0.19/0.29/0.36/0.41 now lead to business selection and evaluation (5.0–5.1), not replacing provider interfaces. Rows 0.37/0.38 lead to actual human access (3.8–3.10) and a separately verified wake path (5.3). Rows 0.27/0.39 lead to qualified local jobs (4.3/4.6), not an always-busy GPU. Row 0.40 makes adaptive workspace an active parallel track with independent acceptance. Row 0.34 removes the incorrect paid-membership/Siri-release dependency. Runtime-native agents still supply general intelligence; Noctis coordinates and enforces boundaries.

Open choices are explicit; historical implementation detail is retained as history. No new production activation, external writes, paid APIs, hardware purchases or acceptance claims are authorised by the revision.

Revision 3: 0.32 → Slice 6, 0.33 → Slice 7, 0.34 and 0.35 → backlog rows; ADR-0033 narrows the public-ingress exception to the MCP listener only, so the constraint "Tailscale Serve for the core (private, never Funnel)" still holds as written.

## Revision 4 research references (checked 2026-09-22)

- [ORION remote-access source](https://github.com/tol518/orion-personal-ai-operating-system/blob/main/server/remote-access.js): discovers/hands off to native RDP/macOS Screen Sharing. [Browser Screens](https://github.com/tol518/orion-personal-ai-operating-system/blob/main/client/src/components/ScreensPage.tsx) uses snapshots with 850 ms delay after each capture, not evidence of high-frame-rate streaming. Private deployment performance was not tested.
- [Microsoft Remote Desktop](https://support.microsoft.com/en-us/windows/experience/connectivity-networking/how-to-use-remote-desktop), [Sunshine](https://docs.lizardbyte.dev/projects/sunshine/latest/), [Moonlight](https://moonlight-stream.org/): established backends to evaluate; no new subscription assumed for software, network/hardware costs separate.
- [Tailscale WoL/UpSnap guide](https://tailscale.com/blog/wake-on-lan-tailscale-upsnap), [Windows power states](https://learn.microsoft.com/en-us/windows/win32/power/system-power-states): home-LAN relay and hardware/power-state qualification.
- [Apple personal-device signing](https://developer.apple.com/help/account/basics/about-your-developer-account): free Personal Team, seven-day provisioning; check individual capabilities before promising native features.
- [Jev release/pricing](https://typesafe.ai/blog/introducing-system-one-models-and-jev): paid hosted decision model, not chosen for this plan. Typed outputs do not establish correct layout decisions.
- [Codex remote](https://learn.chatgpt.com/docs/remote-connections), [Claude Remote Control](https://code.claude.com/docs/en/remote-control), [Hermes features](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview): remote agent execution, native interfaces and reusable runtime capabilities are the baseline; full human remote desktop is a separate need.
