# Adaptive panels in the v1 web app: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Read first: six owner decisions (D1 to D6) are listed in the next section.** Slice 1 (P1 to P7) waits on D1 and D2. D3 to D6 shape later tasks and have defaults the plan is written to; a different answer changes only the task named beside it.

**Goal:** Bring the mockups' feel into v1. Work an agent produces appears as **panels** beside the conversation, laid out by the deterministic compositor, with Vesper's core docked beside the work, on desktop and on the phone. Today v1 has only fixed pages, and the compositor is reachable only from the hidden Command page.

**Architecture:** No new layout engine. The pieces exist and are wired together in a new place:

- **Panels belong to a thread.** A Surface may be owned by an Objective (as today) or by a thread (new). That is one migration and one optional field on the Surface contracts.
- **Threads draws its thread's panels.** It reuses `useComposition`, the restyled `Workbench` and `SurfaceFrame`, and the registry. Desktop: the conversation becomes a column, with the panels beside it. Phone: a row of panel chips above the composer, and a tapped panel fills the page as a back layer.
- **Who proposes.** The core proposes panels for what a turn produced (media outputs, written files, Vault recall), from committed events, the way `proposed-surfaces.ts` already does for Objectives. Agents propose plans, drafts, lists and checklists with `noctis_propose_surface`, against an allowlist.
- **The core keeps docking where it does.** The layout provides the slot; `dockFor` gets a preference list so a layout can offer a better slot (the companion column in focus).

**Tech Stack:** TypeScript monorepo:

- `apps/core`: Node, SQLite.
- `apps/node-agent`.
- `apps/web`: React and Vite PWA, inline style props, no router.
- `packages/ui`: tokens and the Three.js core.
- `packages/domain`.
- Tests: vitest (node environment, no Testing Library) and Playwright e2e under `node --test` (`apps/web/e2e/*.test.mjs`).

## Decisions the owner needs to make

| #   | Question                                                                                 | Recommendation                                                                                                                                                                                                                                                                                                                                                                            | Gates      |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| D1  | Where do panels live, and what owns them?                                                | **In Threads, owned by the thread.** Free chat, named conversations, delegated threads and Objective threads each have their own panels. No Objective is needed. This needs one core migration that lets a Surface belong to a thread. The migration rebuilds two tables, so the owner backs up `core.db` before the deploy that carries it. Presence stays the calm home, with no panels | P1 onwards |
| D2  | Should what a turn produces open as a panel by itself?                                   | **Yes, for media.** Every image, video, audio file or PDF a turn produces becomes a panel without the agent asking. Plans, drafts and checklists appear only when the agent proposes them. A new panel never takes over the screen: on the phone it arrives as a chip and opens only when tapped                                                                                          | P3, P11    |
| D3  | How does the owner arrange panels?                                                       | **No drag and drop in v1.** Each panel has **Focus** (make it the one big panel), **Pin** (keep it where it is, above newcomers), **Place** (left, centre, right or bottom, desktop only) and **Close**. Drag can come later on top of the same overrides                                                                                                                                 | P5, P9     |
| D4  | When a panel is focused on the desktop, should the conversation shrink to the companion? | **Yes**, as in the mockups. The core grows in a left column with Vesper's latest line and the composer under it, and **Show conversation** brings the transcript back                                                                                                                                                                                                                     | P12        |
| D5  | Can the owner edit a document panel?                                                     | **Read only in v1.** Saving an edit to a file on a PC is an external write, so it comes later, behind an approval                                                                                                                                                                                                                                                                         | P8, P11    |
| D6  | Do the old Command canvas and the new panels share one look?                             | **Yes.** `SurfaceFrame` and `Workbench` are restyled in place rather than copied. Command stays hidden behind `VITE_NOCTIS_ALL_PAGES` and simply looks newer                                                                                                                                                                                                                              | P5         |

## Global Constraints

- Node.js 22.23.2 and the exact package lock. No new dependency without the owner's agreement. Markdown in document panels is drawn by a small line renderer (P8), not a library.
- Write a focused failing test first, then verify red and green (`AGENTS.md`).
- Models may propose semantic intent. Deterministic code owns authority, state, layout, routing, restore and physical window placement. A model's panel names a `kind`, a `role`, a `priority` and a payload. It never names a region, a size, a position or an order.
- Production capabilities are default-off. Get explicit approval before any of these:
  - registering services or scheduled tasks;
  - enabling autostart;
  - connecting new live accounts;
  - external writes;
  - using metered APIs.
- No destructive Git or filesystem commands. Never modify the live MindVault without the owner's say-so. Reading it is fine.
- Commit only when the owner asks (global `CLAUDE.md`). The commit steps below are where a commit would go, and each waits for that yes.
- Record evidence in `docs/acceptance/IMPLEMENTATION-STATUS.md` before claiming a task done.
- Keep the design language: tokens in `packages/ui/src/tokens/*` and `glass`, `buttonStyle` and `fieldStyle` from `apps/web/src/layout/Page.tsx`. 44 px touch floor.
- Live testing of v1 is deferred by the owner (2026-10-09). Don't block on it.
- **This plan adds:**
  - The migration in P2 runs on the live core database at the next deploy. The deploy is the owner's, and the owner backs up `core.db` first.
  - "THE GATE: every v1 page fits a phone" in `apps/web/e2e/phone.test.mjs` must keep passing after every web task.
  - "THE GATE (companion)" in `apps/web/e2e/presence.test.mjs` must keep passing after every web task. It checks exactly one `.noctis-intelligence` element.

**Commands used throughout.** These are PowerShell, with the `npm.cmd` and `npx.cmd` shims, as the status log records.

- Unit: `npx.cmd vitest run <paths>`.
- Types and lint: `npm.cmd run typecheck`, then `npx.cmd eslint <changed files>` and `npx.cmd prettier --check <changed files>`.
- E2E. The suite runs the built core, node agent and ui, so build first. Use Chrome, a long TMP path, and **one e2e file per `node --test` call**:

```powershell
$env:NOCTIS_E2E_BROWSER_CHANNEL = "chrome"
$env:TMP = "C:\Users\mushaf.zarrar\AppData\Local\Temp"; $env:TEMP = $env:TMP
npm.cmd run build
node --test apps/web/e2e/panels.test.mjs
node --test apps/web/e2e/phone.test.mjs
```

The short 8.3 TMP path (`MUSHAF~1.ZAR`) breaks the node file-session tests. This PC runs Node 22.23.1, not the pinned 22.23.2. Note that in the evidence rather than installing anything.

---

## Findings (verified in the code on 2026-10-09)

| #   | What is there                                                                                                                                                                                                                                                                                    | What it means for panels                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `compose()` (`packages/domain/src/compositor/compose.ts`) is pure. It has four templates, three display classes (compact under 1200 px, standard under 1800 px, wide) and five regions. It ranks focus, then pinned, then role, priority, recency and id, and sends the rest to an overflow list | Reused unchanged except for the owner (P1) and "an override pins" (P9)                                                                            |
| 2   | `surface_intents.objective_id` and `composition_snapshots.objective_id` are `NOT NULL REFERENCES objectives`. `surface_overrides.surface_id` cascades from `surface_intents`                                                                                                                     | A thread-owned panel needs a table rebuild. A plain `DROP TABLE surface_intents` would cascade-delete every override, so P2 copies them out first |
| 3   | `applyProposal` (`apps/core/src/conversation/proposals.ts:97-101`) drops a surface proposal from a free-chat turn with `no_objective_for_surface`                                                                                                                                                | Today an agent in free chat or a named conversation **cannot** show a panel at all                                                                |
| 4   | Runtime proposals are upserted with `sourceIds: []`. A Surface's identity is `(owner, kind, sourceIds)`, and upsert keeps the lifecycle a row reached                                                                                                                                            | One panel per kind per owner. A second plan **replaces** the first, and once dismissed every later plan **stays dismissed**. P3 fixes this        |
| 5   | `SURFACE_PAYLOAD_SCHEMAS` includes `approval`, `vault_recall`, `native_application`, `external_tool` and `source_state`, and `applyProposal` accepts any of them from a model                                                                                                                    | A model could draw a fake approval card or fabricated Vault quotes. P3 adds an allowlist                                                          |
| 6   | `useComposition` re-reads only after its own commands. Nothing refreshes it when the core adds a Surface                                                                                                                                                                                         | P6 refreshes on `surface.*` events through the subscription `useConversation` already holds                                                       |
| 7   | `SurfaceFrame` uses a native `<select>` and controls under 44 px, on `depth.layers[1]` rather than glass. `apps/web/e2e/workbench.keyboard.test.mjs` reads each Surface's region from that `<select>`                                                                                            | P5 restyles the frame and moves the region to `data-surface-region`, and updates that e2e                                                         |
| 8   | The registry has 11 kinds. The master plan's §5.3 list is missing Document/Editor, Media, Timeline and Verification                                                                                                                                                                              | Media first (P4), then Document (P8), then Timeline and Verification (P13)                                                                        |
| 9   | `noctis_propose_surface` (Claude in `apps/node-agent/src/runtimes/claude.ts:485`, Codex and Hermes in `apps/node-agent/src/noctis-mcp.ts:38`) says only "Propose a surface". The payload is `unknown` and no kind is named                                                                       | An agent cannot know what to send. P8 writes the kinds and their shapes into the tool description                                                 |
| 10  | The fake runtime (`apps/node-agent/src/runtimes/fake.ts`) already has `IMAGE:` (an output with an `attachmentId`) and `WRITE:` (a `file_change` under the granted root)                                                                                                                          | Slice 1's e2e needs no new fake. P8 adds `PANEL:`                                                                                                 |
| 11  | The companion core (`apps/web/src/companion/{dock.ts,CompanionCore.tsx}`) measures `[data-core-slot="<name>"]` and falls back to the corner when the slot is not drawn. Threads draws `composer`, which sits at the foot of the conversation                                                     | With the conversation as a left column, the core is already bottom-left beside the panels, as in every mockup. Only focus needs more (P12)        |
| 12  | The Files page's `Viewer` (`apps/web/src/pages/Files.tsx:455`) already shows text, image, video and audio from `/files/content`. `locateInRoots` (`apps/web/src/pages/files-view.ts:66`) maps a written path to a grant. The core has `listRuntimeRoots` (`apps/core/src/nodes/registry.ts:287`) | File panels (P11) reuse all three                                                                                                                 |

## The six questions, answered

1. **Where panels live: inside Threads, owned by the thread (D1).** It is the smallest change that gives the mockup feel:
   - Threads is already where turns land, where the core docks, and where back layers work.
   - Presence keeps its job as the calm home. It already shows what a turn produced (owner-list A8), with "Open in Threads".
   - A new destination would add a sixth tab that shows a second copy of the same thread.
   - Panels do **not** need an Objective. Proposals go to the turn's thread unless the proposal names an Objective explicitly. The Objective canvas stays where it is, on the hidden Command page.
   - Delegated threads have their own panels. A child's image shows in the child thread. The parent's reply already lists the child's outputs.
2. **Kinds, and the order they come in.**
   - **Media** comes first (P4). It is what a turn visibly produces today, and Slice 1 is built on it.
   - **Document** comes second (P8). Plans and drafts, as in mockups 02-active-canvas and development-02, drawn read only as markdown-lite (D5).
   - **Timeline and Verification** come third (P13), for today-plan-03 and development-05.
   - **Restyling existing kinds.** `SurfaceFrame` becomes glass with mockup-style titles: a large uppercase title for the primary panel, and a small tracked accent label for the others ("RELEVANT FILES", "CURRENT DECISION"). Its controls become 44 px. `list`, `detail`, `evidence`, `attention` and `vault_recall` get row, label and pill styling (P5).
   - **Unchanged kinds.** `approval`, `native_application`, `external_tool`, `source_state` and `conversation` keep their renderers. They never appear in a thread's panels in v1, because approvals stay inline in the conversation as they are now.
3. **Phone (P7).** A phone is the `compact` display class. `canvas.split` then places one `centre` panel and one `bottom` panel, and the rest go to overflow.
   - **The tray.** Threads shows those panels as a row of 44 px chips above the composer, in plan order, then "+N" for overflow. The row is a native horizontal scroller, so swiping needs no gesture code.
   - **Focus.** Tapping a chip focuses the panel, which uses `focus.stage` (one stage panel). The panel takes the page body in place of the conversation, as the Conversations list already does. It is a back layer, `useBackLayer("panel", …)`, so the phone's back gesture returns to the conversation. The composer stays, so the owner can talk about the panel they are looking at.
   - **Attention.** An attention-role panel uses the compositor's `overlay` slot. It renders as a card at the top of the conversation, not a modal.
   - **No surprises.** Nothing opens by itself.
4. **The core (P12).** The layout provides the slot, and `dockFor` returns a **preference list** of slots in place of one slot name. `CompanionCore` takes the first one that is drawn, then the corner.
   - **Canvas.** Threads in canvas state draws only `composer`, which sits at the foot of the conversation column beside the panels. That is the mockups' arrangement with no dock change.
   - **Focus on the desktop.** The layout draws `companion` (a 160 px slot over Vesper's latest line), and the core moves there. Threads' preference list is `["companion", "composer"]`.
   - **Phone focus.** The composer stays, so the core stays in the composer slot. No sheet ever covers the core, so the z-index rules from C1 hold.
5. **Arranging and restore (P5, P9).**
   - **Close** is `surface.change_lifecycle` to `dismissed`, as now.
   - **Pin** is an override at the panel's current region and size (`surface.set_override`). `compose` ranks a panel with a live override as pinned, so a pinned panel is not pushed into overflow by a newcomer (§5.5: "user focus and pinned placement beat proactive rearrangement"). **Unpin** is `surface.release_override`.
   - **Place** is the same override with another region, chosen from a `Picker`.
   - **Reorder** is Place plus Focus. There is no order field and no drag (D3).
   - **Restore.** Overrides are stored per client and display fingerprint, and dismissals are stored in the core. After a reload, `GET /threads/:id/surfaces` recomputes the same plan from the same rows. Focus is deliberately not persisted: it lives in the back-layer entry, so a reload returns to the canvas.
6. **Slices.**
   - **Slice 1 (P1 to P7): "an image a turn makes opens as a panel beside the conversation", on desktop and phone.** It is visible on the first `IMAGE:` turn, needs no agent prompt change, and exercises ownership, migration, a core rule, a new kind, the restyled frame, live refresh and both layouts.
   - **Slice 2 (P8 to P11):** agent-proposed documents, pin and persistence, Vault recall as a panel, and files a turn wrote as panels.
   - **Slice 3 (P12 to P13):** the desktop companion column, then Timeline and Verification.
   - **P14:** evidence and the status entry.

## Order

1. **Slice 1, P1 to P7,** after D1 and D2. P1 and P2 come first and strictly in that order. P3 and P4 can then run in parallel, and so can P5. P6 needs P2 to P5, and P7 needs P6.
2. **Slice 2, P8 to P11.** These are independent of each other once Slice 1 is in.
3. **Slice 3, P12 then P13.** Then P14.

**Names used across tasks:**

- `SurfaceOwner` and `ownerIdOf` (P1);
- `MediaPayloadSchema`, `FileSourceSchema` and `PANEL_PROPOSABLE_KINDS` (P3);
- `MediaSurface` and `SurfaceContext.mediaUrl` (P4);
- `PanelControls` (P5);
- `ThreadPanels` and `panelsRevision` (P6);
- `PanelTray` (P7);
- `DocumentPayloadSchema` and `DocumentSurface` (P8);
- `CoreSlot` (P12);
- `TimelinePayloadSchema` and `VerificationPayloadSchema` (P13).

---

# Slice 1: an image a turn makes opens as a panel beside the conversation

### Task P1: A Surface can belong to a thread (contracts and compositor)

**Files:**

- Modify: `packages/contracts/src/surface.ts`:
  - `SurfaceIntentSchema`: `objectiveId` becomes optional and `threadId: UuidSchema.optional()` is added, with exactly one of the two set.
  - `CompositionPlanSchema`: the same change.
  - New: `SurfaceOwnerSchema`, `SurfaceOwner` and `ownerIdOf`.
- Modify: `packages/contracts/src/command.ts`: `UpsertSurfaceIntentCommandSchema` (line 234) and `ComposeSurfacesCommandSchema` take `objectiveId` or `threadId`, exactly one.
- Modify: `packages/domain/src/compositor/compose.ts`:
  - `CompositionInput.objectiveId` becomes `owner: SurfaceOwner`;
  - the foreign-owner check compares `ownerIdOf(intent)`;
  - the plan carries the owner's field;
  - `compositionSignature` includes `threadId`.
- Test: `packages/contracts/src/surface.test.ts` and `packages/domain/src/compositor/compose.test.ts`.

**Interfaces:**

- Produces:
  - `type SurfaceOwner = { objectiveId: string; threadId?: never } | { threadId: string; objectiveId?: never }`;
  - `ownerIdOf(value: { objectiveId?: string; threadId?: string }): string`;
  - `compose({ owner, intents, overrides, display, attentionState, focusedSurfaceId?, generatedAt })`.
- **Exactly one.** Enforce it with a `.refine` on each schema. In zod 4 a refine keeps the object schema, so `.strict()` and `.shape` users are unaffected; check with `npm.cmd run typecheck`. The message is `"exactly one of objectiveId and threadId"`.

- [ ] **Step 1: Write the failing tests.**
  - `surface.test.ts`:
    - "a Surface owned by a thread parses";
    - "a Surface with both an Objective and a thread is refused";
    - "a Surface with neither is refused";
    - the same three for `CompositionPlanSchema`.
  - `compose.test.ts`:
    - "composes a thread's Surfaces and stamps the plan with the thread";
    - "rejects an intent owned by another thread as intent.foreign_objective". Keep the reason code so restored snapshots and their reason lists do not change;
    - "an Objective and a thread with the same id-shaped Surfaces never share a plan": two plans differ in signature;
    - every existing test passes after moving to `owner: { objectiveId }`.
- [ ] **Step 2: Watch them fail.** Run `npx.cmd vitest run packages/contracts/src/surface.test.ts packages/domain/src/compositor`.
- [ ] **Step 3: Implement.** Then fix the callers the type checker names: `apps/core/src/objectives/surface-intents.ts` `planFor` and `composeSurfaces`, and `apps/web/src/workbench/useComposition.ts`. Each passes `{ objectiveId }` for now; P2 and P6 add the thread path.
- [ ] **Step 4: Go green.** Rerun the tests, plus `npx.cmd vitest run apps/core/src/objectives apps/web/src/workbench` and `npm.cmd run typecheck`.
- [ ] **Step 5: Commit, once the owner says yes.** `feat(contracts): a surface can belong to a thread`.

### Task P2: The core stores and serves a thread's panels

**Files:**

- Create: `apps/core/migrations/00NN_thread_surfaces.sql`. NN is the next free number: 0014 unless owner-list I1's `0014_listing_drafts.sql` has landed first.
- Modify: `apps/core/src/objectives/surface-intents.ts`. `listSurfaceIntents`, `listSurfaceOverrides`, `getSnapshotForDisplay`, `findByIdentity`, `upsertSurfaceIntent`, `planFor` and `composeSurfaces` take a `SurfaceOwner`. Pick the column through a two-entry constant map, never from input.
- Modify: `apps/core/src/api/http.ts`:
  - `handleSurfaceRead` (line 645) takes an owner;
  - add `collection === "threads" && sub === "surfaces"` beside the `turns` route at line 998. It returns 404 for an unknown thread, as the Objective route does.
- Modify: the `surface.intent_upserted.v1` and `surface.lifecycle_changed.v1` payloads gain `threadId` when the owner is a thread, beside `objectiveId`.
- Test:
  - `apps/core/src/db/migrate.test.ts`: the table count stays 41 (a rebuild adds no table); update the max-version assertion;
  - `apps/core/src/objectives/surfaces.integration.test.ts`.

**The migration.** It runs inside the migration's own transaction, with foreign keys on.

```sql
-- A Surface now belongs to an Objective or to a thread, never both. SQLite cannot
-- relax NOT NULL in place, so surface_intents and composition_snapshots are rebuilt.
-- Dropping surface_intents cascades to surface_overrides, so the overrides are
-- copied aside first and put back after.
CREATE TEMP TABLE overrides_kept AS SELECT * FROM surface_overrides;

CREATE TABLE surface_intents_next (
  id                TEXT PRIMARY KEY,
  objective_id      TEXT REFERENCES objectives (id) ON DELETE CASCADE,
  thread_id         TEXT REFERENCES identity_threads (id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  role              TEXT NOT NULL,
  persistence       TEXT NOT NULL,
  lifecycle         TEXT NOT NULL,
  priority          INTEGER NOT NULL,
  min_size          TEXT NOT NULL,
  preferred_region  TEXT,
  source_ids_json   TEXT NOT NULL DEFAULT '[]',
  artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  payload_version   INTEGER NOT NULL,
  payload_json      TEXT NOT NULL,
  requested_at      TEXT NOT NULL,
  CHECK ((objective_id IS NULL) <> (thread_id IS NULL))
);
INSERT INTO surface_intents_next
  SELECT id, objective_id, NULL, kind, role, persistence, lifecycle, priority, min_size,
         preferred_region, source_ids_json, artifact_ids_json, payload_version,
         payload_json, requested_at
  FROM surface_intents;
DROP TABLE surface_intents;
ALTER TABLE surface_intents_next RENAME TO surface_intents;
INSERT INTO surface_overrides SELECT * FROM overrides_kept;
DROP TABLE overrides_kept;
```

Then:

- **Rebuild `composition_snapshots`** the same way: nullable `objective_id`, plus `thread_id` and the same `CHECK`. Nothing references it, so no copy-aside is needed.
- **Recreate the indexes.** NULLs are distinct in a SQLite unique index, so each owner gets its own partial index:
  - `idx_surface_intents_objective` on `(objective_id)`;
  - `idx_surface_intents_thread` on `(thread_id)`;
  - `idx_surface_intents_identity` on `(objective_id, kind, source_ids_json) WHERE objective_id IS NOT NULL`;
  - `idx_surface_intents_thread_identity` on `(thread_id, kind, source_ids_json) WHERE thread_id IS NOT NULL`;
  - `idx_composition_snapshots_display` on `(objective_id, display_fingerprint) WHERE objective_id IS NOT NULL`;
  - `idx_composition_snapshots_thread_display` on `(thread_id, display_fingerprint) WHERE thread_id IS NOT NULL`.

- [ ] **Step 1: Write the failing tests.**
  - `migrate.test.ts`: "THE GATE (panels): the thread-surfaces migration keeps every Surface and override". Copy migrations `0001` to the one before NN into a `mkdtemp` directory and migrate an in-memory database with them. Insert an Objective, two intents and a live override, then migrate with the full directory. Assert:
    - the rows are equal;
    - `PRAGMA foreign_key_check` is empty;
    - `thread_id` exists;
    - an insert with both owners set throws.
  - `surfaces.integration.test.ts`, in a new `describe("a thread's panels")`:
    - "upserts a Surface owned by a free thread and reads it back from GET /threads/:id/surfaces";
    - "a thread's Surfaces never appear in an Objective's composition, or the reverse";
    - "an override on a thread's Surface is honoured, released, and survives a restart". Reuse the restart pattern of the existing "THE GATE: restores…" test;
    - "GET /threads/:id/surfaces is 404 for an unknown thread";
    - "surface.intent_upserted.v1 carries the threadId".
- [ ] **Step 2: Watch them fail.** Run `npx.cmd vitest run apps/core/src/db/migrate.test.ts apps/core/src/objectives`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Go green.** Run `npx.cmd vitest run apps/core` and `npm.cmd run typecheck`.
- [ ] **Step 5: Commit, once the owner says yes.** `feat(core): a thread keeps its own panels`.

### Task P3: The core proposes a panel for each media output, and agents can propose in any thread

**Files:**

- Modify: `packages/contracts/src/surface-payloads.ts`:
  - add `FileSourceSchema`, `MediaPayloadSchema` and `media` in `SURFACE_PAYLOAD_SCHEMAS`;
  - add `PANEL_PROPOSABLE_KINDS`.
- Modify: `apps/core/src/conversation/proposals.ts`, the surface branch from line 80:
  - the allowlist;
  - the owner is `proposal.objectiveId` when the model names one, else `turn.threadId`;
  - `sourceIds: [turn.id]`.
- Modify: `apps/core/src/objectives/proposed-surfaces.ts`. `proposeFor` gains a case for `identity.turn_item.v1`, which proposes a media panel.
- Test: `apps/core/src/objectives/proposed-surfaces.test.ts` and `apps/core/src/conversation/conversation.integration.test.ts`.

**Interfaces:**

```ts
export const FileSourceSchema = z
  .object({
    from: z.literal("file"),
    nodeId: z.string().min(1).max(64),
    grantId: z.string().min(1).max(64),
    relativePath: z
      .string()
      .min(1)
      .max(1024)
      .refine((path) => !path.split(/[\\/]/).includes(".."), "no parent segments"),
  })
  .strict();

export const MediaPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    mediaType: z.string().trim().min(1).max(128),
    source: z.discriminatedUnion("from", [
      z.object({ from: z.literal("attachment"), attachmentId: UuidSchema }).strict(),
      FileSourceSchema,
    ]),
  })
  .strict();

/** What a model may put on screen. The rest speak for the core: a decision, a Vault quote, a window, a file. */
export const PANEL_PROPOSABLE_KINDS: ReadonlySet<string> = new Set([
  "list",
  "detail",
  "evidence",
  "attention",
]);
```

P8 adds `document` to the allowlist and P13 adds `timeline` and `verification`. `media` is never on the allowlist: the core proposes it, so a model cannot point a panel at somebody else's attachment.

**The core rule (D2).** On `identity.turn_item.v1`, read the payload with the same `{ turnId, item }` shape the web parses. If all of these hold:

- `item.kind === "output"`;
- `item.status === "completed"`;
- `item.attachmentId` is set;
- the media type starts with `image/`, `video/` or `audio/`, or is `application/pdf`;

then upsert this intent on owner `{ threadId: event.streamId }`:

- `kind: "media"`, `role: "primary"`, `persistence: "restorable"`, `priority: 40`, `minSize: "compact"`;
- `sourceIds: [attachmentId]`, so each output is its own panel and a closed one stays closed;
- `idempotencyKey: \`output:${attachmentId}\``;
- payload `{ title: item.path?.split(/[\\/]/).at(-1) ?? "Output", mediaType, source: { from: "attachment", attachmentId } }`.

Other media types stay as links in the conversation.

**Why `sourceIds: [turn.id]` for model proposals.** A second plan in a later turn is a second panel, and the older one drops by recency into overflow. A panel the owner closed stays closed without blocking the next turn's panel (Findings 4). Within one turn, a re-proposal of the same kind updates the panel in place.

- [ ] **Step 1: Write the failing tests.**
  - `proposed-surfaces.test.ts`, using the file's existing kernel fixture:
    - "an image output becomes a media panel on its thread";
    - "an output with no attachment yet proposes nothing";
    - "a zip output proposes nothing";
    - "the same output twice is one panel".
  - `conversation.integration.test.ts`, with the scripted node already used there:
    - "a free-chat turn's surface proposal becomes a panel on its thread". Today this test fails with `no_objective_for_surface`;
    - "a model may not propose an approval, a recall, or a media panel": three proposals, a logged `kind_not_proposable` each, and no intent;
    - "two turns proposing a list make two panels, and closing the first leaves the second".
- [ ] **Step 2: Watch them fail.** Run `npx.cmd vitest run apps/core/src/objectives/proposed-surfaces.test.ts apps/core/src/conversation`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Go green.** Run `npx.cmd vitest run apps/core packages/contracts` and `npm.cmd run typecheck`.
- [ ] **Step 5: Commit, once the owner says yes.** `feat(core): media outputs and agent proposals become thread panels`.

### Task P4: The Media panel

**Files:**

- Create: `packages/ui/src/surfaces/media.tsx` (`MediaSurface`) and `media.test.ts`, following `native.test.ts`, which tests pure helpers.
- Modify: `packages/ui/src/index.ts` (export) and `apps/web/src/surfaces/registry.ts`. Add `media`: `payloadVersion 1`, `sizes: ALL_SIZES`, `title: "Media"`.
- Modify: `apps/web/src/surfaces/renderers.tsx`. Add `SurfaceContext.mediaUrl?: (source: MediaSource) => string | undefined` and the `media` renderer.
- Test: `apps/web/src/surfaces/registry.test.ts` and `media.test.ts`.

**Behaviour:**

- **What it draws.** The frame's title is the payload's `title`; `resolveSurface` already passes the registry title, so for `media` use the payload title. Then:
  - an `<img>` with `object-fit: contain`, filling the panel;
  - `<video controls playsInline preload="metadata">`;
  - `<audio controls>`;
  - for a PDF, an "Open PDF" link in `buttonStyle` with `target="_blank"`.
- **Where the URL comes from.** `mediaUrl` is supplied by Threads (P6) from `conversation.outputUrl` for attachments, and from `transport.contentUrl` for files (P11).
- **No URL.** Without one (no handoff, or a file source before P11), show "This file opens from Threads" in the muted colour. Never show a broken image.
- **Compact size.** A thumbnail at most 96 px high, used by the phone tray.
- **Pure helper.** `mediaElement(mediaType): "image" | "video" | "audio" | "link"`.

- [ ] **Step 1: Write the failing tests.**
  - `media.test.ts`: `mediaElement` for `image/png`, `video/mp4`, `audio/mpeg`, `application/pdf` and `application/zip`.
  - `registry.test.ts`:
    - "resolves a media payload from an attachment";
    - "falls back on a media payload with a relative path that escapes": `relativePath: "../x"` is refused by `FileSourceSchema`;
    - "renders a media Surface with no mediaUrl as text, not a broken image": call the renderer and check the element type.
- [ ] **Step 2: Watch them fail.** Run `npx.cmd vitest run packages/ui/src/surfaces apps/web/src/surfaces`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Go green.** Rerun the tests, then typecheck and lint.
- [ ] **Step 5: Commit, once the owner says yes.** `feat(ui): a media panel`.

### Task P5: Panels in the glass language

**Files:**

- Modify: `packages/ui/src/tokens/material.ts`. Move `glass` here from `apps/web/src/layout/Page.tsx`; `Page.tsx` re-exports it, so no caller changes.
- Modify: `packages/ui/src/surfaces/SurfaceFrame.tsx`:
  - glass;
  - `data-surface-region`, `data-surface-role` and `data-surface-id`;
  - the title style by role;
  - the native `<select>` and the small buttons are removed in favour of a `controls?: ReactNode` slot;
  - the role is kept as visually hidden text.
- Modify: `packages/ui/src/primitives/icons.tsx`: `PanelIcon({ glyph: "focus" | "pin" | "close" })`.
- Modify: `packages/ui/src/surfaces/primitives.tsx` and `packages/ui/src/vault/RecallSurface.tsx`:
  - list rows with hairline dividers;
  - detail as a muted label column beside its value (vinted-02);
  - evidence and recall freshness as pills;
  - attention as an amber left rule.
- Create: `apps/web/src/workbench/PanelControls.tsx`, with focus, pin, place and close.
- Modify: `apps/web/src/workbench/Workbench.tsx`:
  - pass `controls`;
  - remove the inline "Focus" button and the reason-code line (move the reason codes to `data-reason-codes` on the root, for tests);
  - restyle the overflow `<details>` as glass, keeping it, with "Show" and "Close" buttons at 44 px.
- Modify: `apps/web/e2e/workbench.keyboard.test.mjs`. `readCanvas` reads `data-surface-region` and `data-reason-codes` in place of the `<select>` value and the `<p>` text. Its assertions do not change.

**Interfaces:**

- `PanelControls({ title, region, pinned, focused, display, onFocus, onPin, onPlace, onClose })`.
- Each control is a 44 × 44 icon button with an `aria-label`:
  - `Focus ${title}` or `Leave focus`, with `aria-pressed`;
  - `Pin ${title}` or `Unpin ${title}`, with `aria-pressed`;
  - `Close ${title}`.
- Place is the A5 `Picker` with label `Place ${title}`, offering Left, Centre, Right and Bottom. It is drawn only when `display !== "compact"`.
- Pin and Place wire to P9. Until then pin calls `onMove` at the current region and size, which is already an override.

- [ ] **Step 1: Write the failing tests.**
  - `apps/web/src/workbench/display.test.ts`, or a new `panel-controls.test.ts` testing a pure `controlsFor(display): Array<"focus" | "pin" | "place" | "close">`: compact has no `place`, and standard and wide have all four.
  - `workbench.keyboard.test.mjs`: adapt `readCanvas` first, then run it red against the old frame, where no `data-surface-region` exists.
- [ ] **Step 2: Watch them fail.**
  - `npx.cmd vitest run apps/web/src/workbench`;
  - with the env block above, `node --test apps/web/e2e/workbench.keyboard.test.mjs`.
- [ ] **Step 3: Implement.** Use the `frontend-design` skill for the titles and the material, against `noctis-development-02` and `noctis-vinted-02`.
- [ ] **Step 4: Go green.**
  - `npx.cmd vitest run apps/web packages/ui`;
  - `node --test apps/web/e2e/workbench.keyboard.test.mjs`;
  - `node --test apps/web/e2e/approval.keyboard.test.mjs`;
  - typecheck and lint.
- [ ] **Step 5: Commit, once the owner says yes.** `feat(ui): panels in the glass language`.

### Task P6: Threads shows its panels beside the conversation (desktop)

**Files:**

- Modify: `apps/web/src/workbench/useComposition.ts`:
  - `useComposition(transport, owner: SurfaceOwner | undefined)`;
  - read `/objectives/:id/surfaces` or `/threads/:id/surfaces`;
  - spread the owner into `surface.compose`;
  - `attentionState` is `"active_canvas"` for any owner when nothing is focused. A thread never composes in `presence`, which would send every panel to overflow.
- Modify: `apps/web/src/pages/Command.tsx:82`: `useComposition(transport, active === undefined ? undefined : { objectiveId: active.id })`.
- Modify: `apps/web/src/conversation/useConversation.ts`. In `onEvent`, before `default:` at line 494, `surface.intent_upserted.v1` and `surface.lifecycle_changed.v1` whose `payload.threadId === state.thread?.id` increment `panelsRevision: number` in the state.
- Create: `apps/web/src/pages/ThreadPanels.tsx`. It takes `transport`, `conversation` and `mobile`. It calls `useComposition(transport, { threadId })`, calls `refresh()` when `panelsRevision` changes, and builds the `SurfaceContext` with `mediaUrl`.
- Modify: `apps/web/src/pages/Threads.tsx`:
  - when the plan has at least one slot and `!mobile`, the body becomes a two-column grid `minmax(340px, 420px) | 1fr`: the conversation and its sticky composer on the left, `ThreadPanels` on the right;
  - `Page` gets `maxWidth={hasPanels ? 1680 : 880}`;
  - with no panels the page is exactly as today.
- Create: `apps/web/e2e/panels.test.mjs`. Copy the setup of `chat.test.mjs` with the fake node, and use ports `CORE_PORT = 8809` and `WEB_PORT = 4189`. Grep `apps/web/e2e` first to confirm both are free.

**Behaviour:**

- **Display facts.** The display is the viewport, through the existing `displayFor`.
  - Mark it `// ponytail: viewport width, not the panel area's; measure the area if 1200 px misfits beside the conversation column`.
  - At 1440 px that is `standard`: a centre panel, a right panel and a bottom panel beside the conversation.
- **A new panel arrives** with a 180 ms fade and rise (`motion.durationMs.normal`, `motion.easing.standard`), and with no motion under `prefers-reduced-motion`.
- **The conversation column** keeps its follow-the-end behaviour and its `composer` core slot. The core therefore sits bottom-left beside the panels, with no dock change (answer 4).
- **Overflow** is the restyled `<details>`, at the foot of the panel area.

- [ ] **Step 1: Write the failing e2e.** In `panels.test.mjs`, at 1440 × 900, add "THE GATE (panels): an image a turn makes opens as a panel beside the conversation". It sends `IMAGE: a frame` in Threads, then asserts:
  - a `section[data-surface-region]` whose image `src` is the turn's output URL appears **without a reload** within 20 s;
  - its bounding box is to the right of the conversation `ul[aria-label="Conversation"]`;
  - exactly one `.noctis-intelligence` exists, and its box sits inside the conversation column.

  Add a second test, "a thread with no panels looks as it did": a plain `hello` turn leaves no `[data-surface-region]`, and the `<section>`'s content width stays ≤ 880 px.

- [ ] **Step 2: Write the failing unit test.** `apps/web/src/conversation/useConversation.test.ts`: "a surface event for this thread bumps panelsRevision; one for another thread does not".
- [ ] **Step 3: Watch them fail.** Run `npx.cmd vitest run apps/web/src/conversation`, then the env block and `node --test apps/web/e2e/panels.test.mjs`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Go green.** Run the unit tests and these e2e files, one per call:
  - `panels.test.mjs`;
  - `chat.test.mjs`;
  - `presence.test.mjs`;
  - `phone.test.mjs`.

  Then typecheck and lint.

- [ ] **Step 6: Commit, once the owner says yes.** `feat(web): a thread's panels beside the conversation`.

### Task P7: Panels on the phone: the tray, and a focused panel as a back layer

**Files:**

- Create: `apps/web/src/pages/PanelTray.tsx`.
- Modify: `apps/web/src/pages/Threads.tsx`:
  - on `mobile`, render `PanelTray` inside the sticky composer container, above `PromptForm`;
  - while a panel is focused, the page body shows that panel in place of the timeline, the way `listing` shows `Conversations`.
- Modify: `apps/web/src/pages/ThreadPanels.tsx`. It exposes the plan, focus and the overflow ids to the tray, and renders the focused panel full height.
- Test: `apps/web/e2e/panels.test.mjs` and `apps/web/e2e/phone.test.mjs`.

**Behaviour:**

- **The tray.** One row, `overflow-x: auto` with `scroll-snap-type: x mandatory` and `gap: spacing.xs`.
  - **Chips.** Each slotted panel in plan order is a 44 px chip, in glass, with the compact preview (a media thumbnail at 36 px, or a kind glyph) and the title, ellipsised at 160 px.
  - **Overflow.** A "+N" chip opens the overflow list as the same focused layer, showing the list.
  - **Empty.** No panels means no tray, and the composer is exactly as today.
  - **Attention.** An `overlay` slot is not a chip. It renders as a glass card with an amber rule at the top of the timeline.
- **Focus.** Tapping a chip:
  1. `composition.focus(id)`. The compositor moves to `focus.stage`, whose compact capacity is one centre panel.
  2. `panelLayer.pushed()`, where `panelLayer = useBackLayer("panel", focusedId !== undefined, () => composition.focus(undefined))`.

  The focused view is the frame at full page height with Pin and Close, and no Place on compact. The composer stays, so the core stays in the composer slot. Back, the phone gesture, Leave focus and Close all go through `panelLayer.dismiss()`. Closing a focused panel also dismisses it.

- [ ] **Step 1: Write the failing e2e.** In `panels.test.mjs`, at `PHONE = { width: 400, height: 860 }`, add "THE GATE (panels, phone): the image arrives as a chip, opens full height, and back returns to the conversation":
  - after `IMAGE: on the phone`, a chip named with the output appears above the composer and nothing else changes;
  - tapping it fills the page with the panel, so `ul[aria-label="Conversation"]` is not visible, and the composer is still visible;
  - `page.goBack()` restores the conversation with the chip still there;
  - document scroll overflow is ≤ 0, as A1 checks;
  - every control is ≥ 44 px.
- [ ] **Step 2: Extend the phone gate.** In `phone.test.mjs`, "THE GATE: every v1 page fits a phone" also runs once with a panel present. Seed one through `coreCommand(CORE_URL, "surface.upsert_intent", { threadId, kind: "detail", … })`.
- [ ] **Step 3: Watch them fail.** Use the env block, then run `node --test apps/web/e2e/panels.test.mjs` and `node --test apps/web/e2e/phone.test.mjs`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Go green.**
  - `npx.cmd vitest run apps/web`;
  - e2e `panels`, `phone`, `presence` and `chat`, one file per call;
  - typecheck and lint.
- [ ] **Step 6: Record evidence.** Make a Playwright `recordVideo` of the desktop gate and the phone gate. Save it under `.noctis/panels/` for the owner.
- [ ] **Step 7: Commit, once the owner says yes.** `feat(web): panels on the phone`.

---

# Slice 2: what agents propose, kept where the owner put it

### Task P8: Document panels, and agents know how to propose a panel

**Files:**

- Modify: `packages/contracts/src/surface-payloads.ts`. Add `DocumentPayloadSchema` and add `document` to `SURFACE_PAYLOAD_SCHEMAS` and `PANEL_PROPOSABLE_KINDS`.
- Create: `packages/ui/src/surfaces/document.tsx` (`DocumentSurface` and a pure `markdownLines(text): Line[]`) and `document.test.ts`.
- Modify:
  - `apps/web/src/surfaces/registry.ts` and `renderers.tsx`;
  - `packages/ui/src/index.ts`;
  - `apps/core/src/conversation/proposals.ts`: a model's document must be `content.from === "inline"`;
  - `apps/node-agent/src/runtimes/claude.ts:485` and `apps/node-agent/src/noctis-mcp.ts:38`: one shared description string, exported from `apps/node-agent/src/panel-tool.ts` (new);
  - `apps/node-agent/src/runtimes/fake.ts`: a `PANEL:` branch that proposes a document whose body is the text after `PANEL:`.
- Test:
  - `document.test.ts`;
  - `registry.test.ts`;
  - `conversation.integration.test.ts`;
  - `claude.test.ts` and `codex.test.ts`: the tool description contains each proposable kind;
  - `fake.test.ts`;
  - `panels.test.mjs`.

**Interfaces:**

```ts
export const DocumentPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    format: z.enum(["markdown", "text"]),
    content: z.discriminatedUnion("from", [
      z.object({ from: z.literal("inline"), text: z.string().max(50_000) }).strict(),
      FileSourceSchema,
    ]),
  })
  .strict();
```

**The markdown-lite renderer** handles only these. Everything is React text, so nothing is injected as HTML:

- `#` to `###` headings, drawn as the small tracked accent labels of mockup 02 ("OVERVIEW", "NEXT STEPS");
- `-` and `*` bullets;
- `- [ ]` and `- [x]` as read-only checkboxes, with `aria-checked`;
- blank-line paragraphs;
- `` `code` `` spans;
- fenced blocks, in the mono family.

Mark it `ponytail:` with the ceiling (no tables, links or emphasis) and the upgrade (a markdown library, if the owner agrees to the dependency).

**The tool description.** Keep it short; it is read on every turn:

> Propose a panel for Noctis to show beside this conversation. Noctis validates it and decides where it goes; you never choose position or size. Kinds: document {title, format: "markdown"|"text", content: {from: "inline", text}} for a plan, draft or notes; list {items: [{id, label, detail?}]} for choices; detail {fields: [{label, value}]} for facts about one thing; evidence {items: [{id, claim, source, status}]}; attention {headline, detail} for a blocker. role: primary for the main work, supporting or context for what sits beside it. Re-proposing the same kind in the same turn updates it.

- [ ] **Step 1: Write the failing tests.**
  - `markdownLines`: each line type above, and that `<script>` stays text.
  - The registry resolves a document.
  - Core: "a model's document with an inline body becomes a thread panel"; "a model's document pointing at a file is refused".
  - Runtimes: the description lists `document`, `list`, `detail`, `evidence` and `attention`.
  - `fake.test.ts`: `PANEL:` yields one proposal item.
  - e2e "an agent's plan opens as a document panel": send `PANEL: # Plan\n- [ ] first step`. Expect a panel with the heading "PLAN" and an unchecked "first step".
- [ ] **Step 2: Watch them fail.** Run `npx.cmd vitest run packages/ui/src/surfaces apps/web/src/surfaces apps/core/src/conversation apps/node-agent/src`, then `node --test apps/web/e2e/panels.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Go green.** Run the same commands, then typecheck and lint.
- [ ] **Step 5: Hand the live check to the owner.** After a deploy, ask Claude in free chat to "draft a plan as a panel". This needs the node restarted, so the owner runs it. Leave a note for the status log.
- [ ] **Step 6: Commit, once the owner says yes.** `feat: document panels that agents propose`.

### Task P9: Pin, place and close persist and restore

**Files:**

- Modify: `packages/domain/src/compositor/compose.ts`, step 4, the `ranked` map: `pinned: intent.persistence === "pinned" || overrides.has(intent.id)`.
- Modify: `apps/web/src/workbench/PanelControls.tsx` and `ThreadPanels.tsx`:
  - Pin calls `composition.move(id, slot.region, slot.size)`, and Unpin calls `composition.release(id)`;
  - `pinned` is "has a live override";
  - Place calls `move(id, region, slot.size)`.
- Test: `compose.test.ts` and `panels.test.mjs`.

- [ ] **Step 1: Write the failing tests.**
  - `compose.test.ts`: "a Surface the user placed outranks a newer unpinned rival for the last slot". This is the §5.5 rule. Also keep "keeps a pinned Surface placed when an unpinned rival outranks it" green.
  - e2e, desktop, "THE GATE (panels, restore): pinned stays, closed stays closed, after a reload":
    1. Make three panels (`IMAGE:` twice, `PANEL:` once).
    2. Pin the first and close the second.
    3. Send a fourth `IMAGE:` and check the pinned one is still placed.
    4. `page.reload()`, then check the same `data-surface-id` set is in the same regions, and the closed one is absent.
- [ ] **Step 2: Watch them fail.** Run `npx.cmd vitest run packages/domain/src/compositor`, then `node --test apps/web/e2e/panels.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Go green.** Run the compose tests, `npx.cmd vitest run apps/core/src/objectives` (the existing override tests), the e2e `panels` and `workbench.keyboard`, then typecheck.
- [ ] **Step 5: Commit, once the owner says yes.** `feat: pinned panels stay put`.

### Task P10: Vault recall as a panel

**Files:**

- Modify: `apps/core/src/objectives/proposed-surfaces.ts`. `proposeFor` gains a case for `identity.turn_started.v1`:
  1. Read the turn and its user message (`getTurn`, and the message by `turn.userMessageId`).
  2. Run `recallForPrompt(db, text, { vaultRoot })` from `apps/core/src/conversation/recall-context.ts`.
  3. If evidence came back, upsert a `vault_recall` panel on the thread: `role: "context"`, `persistence: "restorable"`, `priority: 30`, `sourceIds: [turn.id]`, `idempotencyKey: \`recall:${turn.id}\``. The payload is `{ query: first 120 chars, freshness, evidence }`.
- Modify: `ThreadPanels.tsx`. `onOpenInVault` goes to App's existing `openInVault`, passed down through Threads.
- Test: `proposed-surfaces.test.ts`, using the Vault fixture root that `apps/core/src/vault` tests use.

**Note for the owner.** Recall matches a whole prompt against entity names (`recall-context.ts`, its `ponytail:` note), so these panels will be rare until recall gets term extraction. The panel is still correct when it does appear. Term extraction is its own task and is not part of this plan.

- [ ] **Step 1: Write the failing tests.**
  - "a turn whose prompt names a Vault note gets a recall panel";
  - "no Vault, or no match, proposes nothing";
  - "Open in Vault on the panel lands on the entity", as an e2e in `vault.keyboard.test.mjs` style, only if its fixture already has a Vault. Otherwise make it a renderer unit test that the handoff is called with the entity.
- [ ] **Step 2: Watch them fail. Step 3: Implement. Step 4: Go green.** Run `npx.cmd vitest run apps/core/src/objectives apps/core/src/vault`, then typecheck.
- [ ] **Step 5: Commit, once the owner says yes.** `feat(core): Vault recall as a thread panel`.

### Task P11: A file a turn wrote opens as a panel

**Files:**

- Move: `locateInRoots` from `apps/web/src/pages/files-view.ts` to `packages/domain/src/files/locate.ts`, exported from `@noctis/domain`. `files-view.ts` re-exports it, so the web's callers are unchanged.
- Modify: `apps/core/src/objectives/proposed-surfaces.ts`. On `identity.turn_item.v1` with a completed `file_change`:
  1. Read the roots with `listRuntimeRoots(db, () => true, now)`. Grants are listed whether the PC is online or not, because a panel for an offline PC's file is still true; it just will not open until the PC is back.
  2. Locate each path, at most four per item.
  3. Upsert `document` (text extensions, using `viewerKind`'s list, moved with it) or `media` (image, video or audio extensions) with a `file` source.
  4. Give it `sourceIds: [fileSourceId(grantId, relativePath)]` and `idempotencyKey: \`file:${grantId}:${relativePath}\``.
     - `fileSourceId` (new, in `proposed-surfaces.ts`) is the first 16 bytes of `sha256(\`${grantId}/${relativePath}\`)`, formatted as a UUID with the version nibble set to 8.
     - Each file is then its own panel, and the same file written again updates its panel. `compose` and the database need no change.
- Modify: `ThreadPanels.tsx`:
  - `mediaUrl` for file sources is `transport.contentUrl?.(\`/files/content?${filesQuery(place, relativePath)}\`)`;
  - a document with a file source is read through `transport.request("GET", …)`, as `Viewer` does in `Files.tsx:471-505`. Extract that effect into `apps/web/src/pages/useFileText.ts` and use it in both places.
- Test: `packages/domain/src/files/locate.test.ts` (move the existing cases from `files-view.test.ts`), `proposed-surfaces.test.ts` and `panels.test.mjs`.

- [ ] **Step 1: Write the failing tests.**
  - "a markdown file a turn wrote becomes a document panel with a file source";
  - "a path outside every granted root proposes nothing";
  - "two files make two panels";
  - e2e "a written file opens as a panel and reads its text": send `WRITE: notes`, expect a document panel whose body includes "Written by the fake".
- [ ] **Step 2: Watch them fail. Step 3: Implement. Step 4: Go green.** Run `npx.cmd vitest run packages/domain apps/core/src/objectives apps/web/src/pages`, then the e2e `panels` and `files`, then typecheck and lint.
- [ ] **Step 5: Commit, once the owner says yes.** `feat: files a turn writes open as panels`.

---

# Slice 3: the mockup feel

### Task P12: Desktop focus: the companion column

**Files:**

- Modify: `apps/web/src/companion/dock.ts`:
  - `type CoreSlot = "hero" | "composer" | "companion"`;
  - `Dock.slot?` becomes `Dock.slots?: readonly CoreSlot[]`;
  - Threads returns `{ anchor: "slot", slots: ["companion", "composer"], size: 76 }`;
  - Presence and Command return `["hero"]`.
- Modify: `apps/web/src/companion/CompanionCore.tsx`. `measure` tries each `[data-core-slot="<slot>"]` in order and takes the first drawn, then the corner. The effect's dependencies become `[slots.join(), page]`. `place.at` stays the slot name, so the transition and the `ROUND` mask rules are unchanged; the mask is off only for `hero`.
- Create: `apps/web/src/pages/CompanionColumn.tsx`. It contains:
  - a `data-core-slot="companion"` box of 160 × 160;
  - the identity's name in its accent;
  - the first three lines of `lastExchange(conversation).reply`, or "thinking…" while a turn runs, in an `aria-live="polite"` region updated at most once per committed message, not per delta;
  - **Show conversation**, which calls `composition.focus(undefined)`;
  - the `PromptForm` with no `aside`.
- Modify: `apps/web/src/pages/Threads.tsx`. On the desktop with a focused panel, the grid becomes `300px | 1fr`, with `CompanionColumn` and the focused panel at `stage`. This is a back layer too, the same `panelLayer` as P7.
- Test: `dock.test.ts`, `CompanionCore.test.ts`, `panels.test.mjs` and `presence.test.mjs`.

- [ ] **Step 1: Write the failing tests.**
  - `dock.test.ts`: "Threads prefers the companion column and falls back to the composer"; "an approval is never hidden" stays green.
  - e2e, desktop, "THE GATE (panels, focus): focusing a panel shrinks the conversation to the companion, and the core follows":
    - focus an image panel;
    - the transcript `ul` is not visible;
    - the core's box is within 2 px of `[data-core-slot="companion"]`;
    - one `.noctis-intelligence`;
    - **Show conversation** and then `goBack()` each return to the split, with the core back in the composer slot.
- [ ] **Step 2: Watch them fail.** Run `npx.cmd vitest run apps/web/src/companion`, then `node --test apps/web/e2e/panels.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Go green.** Run the unit tests, then the e2e `panels`, `presence`, `phone`, `chat` and `jester`, one per call, then typecheck and lint.
- [ ] **Step 5: Record evidence.** Make a `recordVideo` of canvas, then focus, then Show conversation, at 1672 × 941, the mockups' size. Put it beside `02-active-canvas-shell-v2.png` and `noctis-vinted-02` in `.noctis/panels/` for the owner.
- [ ] **Step 6: Commit, once the owner says yes.** `feat(web): focus shrinks the conversation to the companion`.

### Task P13: Timeline and Verification panels

**Files:**

- Modify: `packages/contracts/src/surface-payloads.ts`. Add the two schemas to `SURFACE_PAYLOAD_SCHEMAS` and `PANEL_PROPOSABLE_KINDS`.
- Create: `packages/ui/src/surfaces/timeline.tsx` and `verification.tsx`, with tests for their pure helpers.
- Modify: the registry, the renderers, `packages/ui/src/index.ts` and the shared tool description in `apps/node-agent/src/panel-tool.ts`.

**Interfaces:**

```ts
export const TimelinePayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            start: z.string().max(32).optional(), // "09:00" or an ISO time, shown as given
            end: z.string().max(32).optional(),
            label: z.string().min(1).max(200),
            detail: z.string().max(400).optional(),
            due: z.boolean().optional(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export const VerificationPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            claim: z.string().min(1).max(300),
            status: z.enum(["verified", "partial", "required", "blocked"]),
            reason: z.string().max(120).optional(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
```

**Rendering:**

- **Timeline** follows today-plan-03: a time column, a rail with a ring per item, and a glass row per item. `due` shows in `semantic.warning`.
- **Verification** follows development-05. It groups items by status in a fixed order: Verified, Partially verified, Still required, Blocked. Each item has a status icon and the reason as a pill. Status is always spelled out, never colour alone (§5.2).

- [ ] **Step 1: Write the failing tests.**
  - `groupByStatus` keeps that order and drops empty groups;
  - the registry resolves both kinds;
  - the core accepts both from a model;
  - the tool description names both.
- [ ] **Step 2: Watch them fail. Step 3: Implement. Step 4: Go green.** Run `npx.cmd vitest run packages packages/contracts apps/web/src/surfaces apps/core/src/conversation apps/node-agent/src`, then typecheck and lint.
- [ ] **Step 5: Commit, once the owner says yes.** `feat(ui): timeline and verification panels`.

### Task P14: Evidence and the status entry

- [ ] Run each check once more, fresh:
  - `npx.cmd vitest run`;
  - `npm.cmd run typecheck`;
  - `npx.cmd eslint` and `npx.cmd prettier --check` on every changed file;
  - each e2e file on its own: `panels`, `phone`, `presence`, `chat`, `jester`, `files`, `workbench.keyboard`, `approval.keyboard`, `vault.keyboard` and `tokenless`.
- [ ] Add a dated section to `docs/acceptance/IMPLEMENTATION-STATUS.md` in the existing format:
  - what was built, by slice;
  - a gate table (clause, state, evidence);
  - the command table with exit codes and counts;
  - known edges.
- [ ] Update `docs/architecture/2026-10-07-v1-scope.md` §6. The "Adaptive Surface compositor" row becomes: "in v1 as thread panels (2026-10-09 plan); N of 15 Surfaces".
- [ ] List what stays with the owner:
  - backing up `core.db`, then the deploy that runs the migration;
  - the live P8 check;
  - approving the recordings in `.noctis/panels/`.

---

## Self-review

- **Question coverage:**

  | Question                       | Answered in        | Built by                 |
  | ------------------------------ | ------------------ | ------------------------ |
  | 1 Where panels live, ownership | Answers §1, D1     | P1, P2, P3, P6           |
  | 2 Missing kinds and restyle    | Answers §2, D5, D6 | P4, P5, P8, P13          |
  | 3 Phone                        | Answers §3         | P7                       |
  | 4 Core docking                 | Answers §4, D4     | P6 (no change), P12      |
  | 5 Dismiss, pin, reorder        | Answers §5, D3     | P5, P9                   |
  | 6 First slice and later        | Answers §6         | Slice 1 (P1 to P7), 2, 3 |

- **Safety at the trust boundary:**
  - models are bounded by `PANEL_PROPOSABLE_KINDS` (P3), with core-only `media`, `vault_recall`, `approval` and windows;
  - a model's document cannot name a file (P8);
  - file sources reject `..` (P4);
  - markdown is never HTML (P8).
- **Deliberate ceilings,** each marked `ponytail:` in code:
  - the viewport, not the panel area, as the display width (P6);
  - markdown-lite (P8);
  - recall's whole-prompt match, which is existing behaviour (P10).
- **Names used across tasks:**
  - `SurfaceOwner` and `ownerIdOf` (P1);
  - `MediaPayloadSchema`, `FileSourceSchema` and `PANEL_PROPOSABLE_KINDS` (P3);
  - `MediaSurface` and `mediaUrl` (P4);
  - `PanelControls` and `controlsFor` (P5);
  - `ThreadPanels` and `panelsRevision` (P6);
  - `PanelTray` and the `"panel"` back layer (P7);
  - `DocumentPayloadSchema`, `DocumentSurface`, `markdownLines` and `panel-tool.ts` (P8);
  - `useFileText`, `fileSourceId` and `@noctis/domain` `locateInRoots` (P11);
  - `CoreSlot`, `Dock.slots` and `CompanionColumn` (P12);
  - `TimelinePayloadSchema`, `VerificationPayloadSchema` and `groupByStatus` (P13).
