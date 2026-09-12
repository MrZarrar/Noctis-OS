# Intent versus implementation audit

Prepared 2026-09-12 against `HEAD fe1ffc1` (clean tree, one untracked file:
`docs/architecture/NOCTIS-FABLE-IMPLEMENTATION-BRIEF.md`). Host: the home PC
(`mushafzarrar` on Tailscale, RTX 5070 12 GB, Node 24.19.0 locally, CI pins
22.23.2). Spec for this audit: the brief above, which outranks the 2026-08-23
master plan where they differ.

Everything below is a **demonstrated** finding unless marked _risk_ or
_unverified_. Line references are to the files as they are at `fe1ffc1`.

## One-paragraph verdict

The repository is a well-built deterministic chassis with no engine in it. Ten
phases delivered contracts, an atomic kernel, a real node protocol, a real
consequence boundary, a pure compositor, a working Vault index and sphere, Win32
placement, and a tool router — every one of them tested at its own boundary
(1,374 unit, 150 integration, 206 Rust tests, all green on 2026-09-10). What
none of them delivered is a single model call. The provider registry registers
nothing, the message table has no writer, and the prompt box on the Presence
screen is an `<input>` with no handler. Every Surface a user sees today was
proposed by the React page from the Objective record. Nothing in the product can
interpret a request. The chassis is worth keeping; the next work is the engine,
and it belongs on the node agent, not in the page or the desktop shell.

## The trace the brief asked for

Request: a person types "Summarise the notes in my Downloads folder" and presses
Enter.

| Link                  | Where                                                                                                         | State               |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------- |
| UI prompt             | `apps/web/src/pages/Presence.tsx:47` `<input>` with no `onSubmit`/`onChange`                                  | **unreachable**     |
| Transport             | `apps/web/src/transport/TauriTransport.ts`, `BrowserTransport.ts`                                             | implemented         |
| Core command          | no `conversation.*` command in `apps/core/src/api/http.ts:318-427`                                            | **missing**         |
| Identity thread       | `apps/core/src/identities/service.ts` (threads only)                                                          | implemented         |
| Message persistence   | `identity_messages` created in `0001_foundation.sql:183`, never written                                       | **missing**         |
| Provider runtime      | `apps/core/src/providers/registry.ts` — "Phase 2 registers nothing"                                           | **missing**         |
| Permission boundary   | `apps/core/src/authority/service.ts`, `packages/domain/src/authority/evaluate.ts`                             | implemented         |
| Tool call             | node agent: 3 read-only adapters (`apps/node-agent/src/adapters.ts:209`); shell: `tools_commands.rs`          | implemented, narrow |
| Observation → Surface | only `Command.tsx` proposes intents (`seedIntents`, `focusForObjective`, `toolsForObjective`, `showApproval`) | template-driven     |
| Composition           | `packages/domain/src/compositor/compose.ts`                                                                   | implemented         |
| Updated UI            | `apps/web/src/workbench/Workbench.tsx` + handoffs                                                             | implemented         |

The chain breaks at the first link and stays broken until the compositor. The
compositor, authority, and node layers are real; they have nothing to compose,
authorise, or run that a person asked for in words.

## Findings

Each: user-visible failure → evidence → root cause → smallest repair → proof.

### F1. There is no intelligence in the product (demonstrated)

- **Failure:** Nothing a user types reaches a model. Vesper and Jester are a
  renderer, a thread row, and a placeholder string.
- **Evidence:** `grep -rn "codex\|anthropic\|ollama\|child_process" apps packages`
  finds spawns only in the shell (process launch for tools) and the Win32 crate.
  `providers/registry.ts` has a refusal test and no registrations.
  `identity_messages` has no `INSERT` anywhere. `Presence.tsx` input has no
  handler. The `conversation` Surface payload is `objective.intent` echoed back
  (`Command.tsx:52-69`).
- **Root cause:** provider work was deferred from Phase 2 ("Register only explicit
  provider classes") through Phase 10; every later phase built around the hole.
- **Repair:** Slice 1 of the master plan — a `runtime.turn` node capability that
  runs Codex App Server on the subscription, a `conversation.send` command, the
  message writer, and a Chat page.
- **Proof:** a live prompt, recorded before the run, produces persisted messages,
  a read-only tool action visible as items, and a Surface change, through the
  built app path.

### F2. Composition is a template keyed by the Objective record, proposed by the page (demonstrated)

- **Failure:** every Objective gets the same three Surfaces; the native focus
  layout is hard-coded to `vscode` and `emulator`; nothing changes when evidence
  changes.
- **Evidence:** `Command.tsx:52` (`seedIntents`), `:159` (`FOCUS_LAYOUT`), `:248`
  (`toolsForObjective`). The core exposes `surface.upsert_intent` and nothing but
  the page calls it.
- **Root cause:** there is no proposer other than the page. The compositor is
  pure and deterministic as designed; its _inputs_ are canned.
- **Repair:** give the runtime a structured proposal channel (the Noctis MCP
  tools in Slice 1, task 8) that lands in `surface.upsert_intent` with
  `actorType: "identity"`, and move the deterministic activation seed into the
  core (`apps/core/src/objectives/seed.ts`, Slice 2) so the page proposes
  nothing.
- **Proof:** change the Objective's intent mid-run; the Surfaces change with no
  page edit; user-pinned Surfaces survive (already enforced by the compositor).

### F3. `Command.tsx` is a 1,203-line orchestrator (demonstrated, quality)

- **Failure:** retry policy (`RETRY_AFTER_CONFIRM`), approval fetching, focus
  layout, tool survey, and recall all live in a React page. Five handoff-plumbing
  defects in Phases 8–10 came from this shape (status log, Phase 10 part 3).
- **Root cause:** each phase added its handoff to the one page that had a
  transport.
- **Repair:** not a rewrite. Slice 2 moves _policy_ (what to retry after a
  confirmation, when to propose an approval Surface) into the core where the
  approval row lives, leaving the page with transport calls and rendering.
- **Proof:** `Command.tsx` under 400 lines with the existing handoffs test still
  green.

### F4. Tool execution and route choice live in the desktop shell, not on a worker (demonstrated, architectural)

- **Failure:** a phone cannot cause a tool action; a headless work-PC core cannot
  act; node host-affinity routing does not apply to tools at all.
- **Evidence:** `tool_registry.rs` (767), `tool_authority.rs` (718),
  `tools_commands.rs` (886) — the shell chooses the route, derives the operation
  class, POSTs `/commands/authority.request` (`tools_commands.rs:378`), and
  executes. The node agent has `environment.inspect`, `file.search`,
  `verification.noop` (`contracts/node.ts:77`).
- **Root cause:** Phase 9 needed the interactive Win32 session for placement,
  and Phase 10 followed it into the shell.
- **Repair:** keep window placement in the shell (it genuinely needs the desktop
  session and is qualified). Make the node agent the general execution plane via
  `runtime.turn`, where the runtime's own tools and MCP servers (Playwright,
  later Windows-MCP) do the work behind the node boundary. Reclassify the shell's
  `tools.json` routes as the deterministic _handoff_ path. Move `tool_execute` to
  a node capability only when the phone slice proves it needs it.
- **Proof:** Slice 5 — a run started from the phone executes on the intended PC
  and returns evidence.

### F5. Approvals cannot answer a running executor (demonstrated)

- **Failure:** an approval row does not know which job asked; there is no deny
  command; confirmation is reachable only from the Command page.
- **Evidence:** `0005_authority.sql` adds `confirmed_at`, `executed_at`, no job
  reference. `COMMANDS` has `authority.request|confirm|execute` and no decline.
  `SurfaceContext.onConfirm` is supplied only by `Command.tsx:858`.
- **Root cause:** ADR-0018 was designed for the shell as the only executor, which
  polls its own retry.
- **Repair:** `approvals.node_job_id` + `ask_id` (migration 0006), an `answer`
  server frame to the node, an `authority.decline` command, and the approval
  Surface rendered in Chat as well as Command.
- **Proof:** deny → the runtime receives a decline and no action occurs; reload
  before confirming → still confirmable; confirm after node reconnect → the
  re-sent ask is answered from the existing row.

### F6. The node job model cannot hold a runtime turn (demonstrated)

- **Evidence:** `LEASE_MS = 30_000` (`nodes/jobs.ts:19`); progress frames are
  "validated, counted, and dropped" (`nodes/ws.ts:162`); a per-job frame budget
  closes the socket; expired leases re-queue retryable capabilities.
- **Repair:** progress and stream frames renew the lease; `runtime.turn` is
  non-retryable (a turn is consequential); the frame budget is per capability.
- **Proof:** integration test with a fake runtime that takes 90 s and streams
  200 items.

### F7. Cost class is verified by nobody in code (demonstrated gap; live state verified today)

- **Verified today, without logging secrets:** `codex login status` → "Logged in
  using ChatGPT" (codex-cli 0.153.4 at
  `%LOCALAPPDATA%\OpenAI\Codex\bin\…\codex.exe`; configured model
  `gpt-6-astra`). `claude auth status` → `authMethod: claude.ai`,
  `subscriptionType: team` (Claude Code 2.1.223). The June 15 update on the
  Claude plan article confirms `claude -p` and the Agent SDK still draw from
  subscription limits.
- **Risks found:** (a) a spawned `claude` with `ANTHROPIC_API_KEY` in its
  environment, or run with `--bare`, bills an API key — `--bare` explicitly does
  not use the subscription login; (b) `%USERPROFILE%\.claude\settings.json`
  installs PreToolUse/PostToolUse/Stop hooks that point at scripts inside a
  Jarvis worktree; a Noctis-spawned Claude session that loads user settings
  would run Jarvis's permission gate inside Noctis.
- **Repair:** the node agent probes both runtimes at startup, reports
  `authMode` in its `hello`, strips `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` from
  every spawned environment, and isolates settings (`settingSources: []`,
  `strictMcpConfig`; Codex `--ignore-user-config` or explicit `-c` overrides).
  The core refuses to dispatch to a provider whose `authMode` is not a
  subscription.
- **Proof:** unit test on the spawn environment; integration test that a node
  advertising `authMode: "api_key"` is never selected.

### F8. There is no phone path (gap, not a defect)

- `BrowserTransport` is development-only by ADR-0015 (token in page memory,
  polling). Tailscale is up with four devices. Slice 5 adds a same-origin
  session-cookie client realm behind Tailscale Serve and amends ADR-0015.

### F9. Four of eight rail destinations render "not built yet" (demonstrated)

- Chat, Missions, Nodes, Automations (`App.tsx:88`). Chat arrives in Slice 1 as
  a functional page; Missions and Nodes in Slices 2 and 5; visual design of all
  four is Astra's.

### F10. Tests prove the chassis, not the product (assessment)

- The suites exercise real boundaries (idempotency by sabotage, node realm
  hostile fixtures, compositor determinism, Win32 identity). None touches a
  model, a runtime, or a real tool, because none exists. Slice 1 adds a fake
  runtime for CI and a separately labelled live-evidence procedure.

### F11. Native acceptance on this PC is unreliable (recorded limitation)

- Smart App Control has blocked freshly built executables intermittently since
  Phase 4 (Rust test binaries, Playwright's Chromium; `build:desktop` "not run
  here" since Phase 9). Local development runs Node 24.19.0 against a CI pin of
  22.23.2. Native and desktop gates are proven in CI or on the work PC; this
  audit does not treat a local block as a product defect.

### F12. Jester has no local model to run on (gap)

- No Ollama, LM Studio, Python, or `uv` on this machine. RTX 5070 with 12 GB.
  Codex CLI supports `--oss --local-provider lmstudio|ollama`, so Jester can be
  the _same_ Codex runtime on a local-provider profile rather than a second agent
  framework. Hermes is not adopted unless a measured workload shows the Codex
  route cannot serve it. Note: the Agent Brain says not to recommend local
  models; the brief is the newer, explicit instruction and wins here — recorded
  so the conflict is visible.

### F13. Windows computer control is not installed and must be scoped (gap)

- Windows-MCP needs Python 3.13 and `uv` (absent), is MIT, and exposes
  PowerShell, Registry, and FileSystem tools with "full system access". It is
  adopted only behind a tool-name allowlist inside the runtime's MCP
  configuration, in Slice 3 at the earliest. Playwright 1.63 is already a
  dependency; `@playwright/mcp` 0.0.80 is the browser MCP candidate.

## Keep / cut / merge / reorder

| Item                                               | Decision        | Reason                                                                                        |
| -------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| Contracts, kernel, migrations, events              | keep            | Sound; every slice extends them additively.                                                   |
| Node protocol, pairing, grants, leases, dispatcher | keep            | Becomes the execution plane for runtimes (F4, F6).                                            |
| Authority three-command boundary                   | keep + extend   | Add decline and job linkage (F5). ADR-0018 amended, not replaced.                             |
| Compositor, registry, overrides, restore           | keep            | The deterministic half of "propose / validate / place" already exists.                        |
| Vault index, recall, sphere                        | keep            | Untouched by this plan until recall is wired into turns (Slice 3).                            |
| Win32 placement in the shell                       | keep            | Needs the interactive session; qualified twice.                                               |
| Shell tool routes (`tools.json`)                   | keep as handoff | Deterministic open/launch stays; general execution moves to the node (F4).                    |
| Phase 10 runbook desk walk                         | merge           | Folded into Slice 2's desk session; no separate gate.                                         |
| Phase 11 Song/Vinted/Development _adapters_        | cut as code     | They become `tools.json` rows plus recorded prompts and acceptance journeys (Slice 5).        |
| Phase 12 NOIR                                      | reorder         | After Slice 4; it needs a runtime to reason with.                                             |
| Phase 13 Sense / Automations                       | reorder         | After the phone slice; a schedule with no reachable approval is a liability.                  |
| Phase 14 cutover                                   | unchanged       | Still last, still gated.                                                                      |
| Hermes as Jester runtime                           | cut (for now)   | Codex local-provider profile first; adopt only on measured need (F12).                        |
| Token-level streaming to the page                  | defer           | Item-level events suffice for Slice 1; deltas are an Astra-era polish behind the Rust stream. |
| `provider_decisions` table                         | build now       | It finally has a writer (Slice 1).                                                            |

## Sequence (see the master plan for tasks)

Revised on 2026-09-12 after the owner answered a seven-round reverse prompt; the
master plan's Part 0 records every answer. Two rows in the keep/cut table above
changed as a result: **Hermes is adopted** (wrapped as Jester's runtime on LM Studio,
memory and cron off, skills kept, ported piecewise later) and **the phone moves to
Slice 2** because the owner's success criterion is "Noctis is the front door for all
AI work". The core runs on the work PC from Slice 1 by the owner's decision.

1. **Slice 1 — the live loop, both runtimes, work-PC core:** Codex App Server and
   Claude Agent SDK behind the node agent; model choice as data with per-identity
   defaults and per-turn override; workspace-write on the real grant roots
   (`Documents\Jarvis`, `Downloads`, `Documents`, `MindVault` read + `inbox` write);
   auto-allowed local edits under an active Objective; token streaming; proposals
   placed; one runtime thread per Objective plus a free-chat thread per identity;
   home PC paired as a worker of the work-PC core.
2. **Slice 2 — front door on every device:** session realm and Tailscale Serve,
   phone shell and web push ported from the donor, images and files in the prompt,
   live Vault read plus inbox writes, recovery, core-side approval Surfaces,
   `Command.tsx` slimmed.
3. **Slice 3 — generality and reach:** isolated Playwright MCP, allowlisted
   Windows-MCP, concurrent Objectives and sub-agents, the recorded unseen task,
   Objective change mid-run, Vault attachments as Artifacts.
4. **Slice 4 — Jester, memory, proactivity:** Hermes on LM Studio, skills and
   preferences, Sense suggestions, Attention Required, Automations, the small
   interpreter in shadow mode.
5. **Slice 5 — journeys and integrations:** Song, Vinted, Development as rows and
   prompts; personal admin via mail/calendar MCPs with confirmed sends;
   Wake-on-LAN after topology; optional Mac worker.
6. **Astra — visual and frontend pass** after Slice 3.
