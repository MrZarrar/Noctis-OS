# Reminders, scheduled tasks, to-dos and notes implementation

> Execute the owner's 2026-10-12 reminders design, now that adaptive panels are complete. The owner requested implementation on 2026-10-14 and chose notes stored in Noctis.

**Goal:** Capture through Vesper/Jester or the UI, persist in the core, show each feature as a page and panel, fire reminders and safely dispatch owner-enabled scheduled tasks.

**Architecture:** Reuse command transactions, SQLite, proposal tools, runtime dispatch, authority decisions, push and page panels. One deterministic trigger engine serves reminders and tasks. No paid APIs, dependencies, donor ports, deployment or live workers.

**Spec:** `docs/superpowers/plans/2026-10-12-reminders.md` plus the owner's Noctis notes choice.

## Global constraints

- Node.js 22.23.2 and the exact package lock; preserve unrelated `debug.log`.
- Write focused failing tests before production changes and record red/green evidence.
- Models propose; owner commands activate tasks and grant authority. Task execution is default-off at core configuration.
- Work in the current checkout to preserve the existing installed dependencies; agents have disjoint file ownership. Commit and push reviewed changes to origin/main under the standing authorization.

## Shared interfaces

- `productivity.ts` in contracts exports Trigger, Reminder, Note, ScheduledTask and TaskRun schemas/types and command schemas.
- Triggers: null (to-do), `{kind:'at',at}`, `{kind:'repeat',rule:{kind:'weekly',daysOfWeek,timeOfDay,timeZone}}`, `{kind:'repeat',rule:{kind:'interval',hours}}`, `{kind:'at_pc',nodeId,repeat}`.
- Reminder: id, text, note, trigger, status (pending/due/done/snoozed), identityId, optional threadId, revision, createdAt, updatedAt, optional nextDueAt.
- Note: id, title, body, identityId, optional threadId, revision, createdAt, updatedAt.
- ScheduledTask: id, name, prompt, identityId, model, nodeId, rootGrantId, trigger, threadMode (new/continue), maxRunMinutes, paused, revision, createdAt, updatedAt, optional nextDueAt/threadId.
- TaskRun: id, taskId, status (running/completed/failed/needs_you/skipped), optional reason/threadId/turnId, startedAt, optional completedAt/result.
- GET /reminders => {reminders}; /notes => {notes}; /tasks => {tasks}; /tasks/:id/runs => {runs}. CoreTransport.read/command are unchanged.
- Commands: reminder.create/update/complete/snooze/delete, note.create/update/delete, task.create/update/pause/resume/run_now/delete. Mutations use idempotencyKey and expectedRevision for existing records.
- `createReminder`, `updateReminder`, `completeReminder`, `snoozeReminder`, `deleteReminder`, `listReminders`, `getReminder`, equivalent note functions live in core/productivity/service.ts.
- Root owns core/productivity/triggers.ts and tasks.ts, config/server.ts, server.ts, authority integration and notify/triggers.ts. Storage agent owns contracts, productivity/service.ts, API routes, migrations and proposals. Runtime agent owns node-agent and core/nodes presence handling. Frontend agent owns web and UI package.

## Tasks

### 1. Contracts, persistent records and capture API
- [ ] Write tests for invalid triggers, CRUD, optimistic revision, idempotency, identity provenance, paused proposals and authenticated API routing.
- [ ] Run targeted Vitest tests; confirm new behavior fails.
- [ ] Implement schemas, migrations, transactional commands, list reads and validated proposal handling.
- [ ] Run targeted tests and report exact red/green results.

### 2. Trigger engine, scheduled dispatch and authority
- [ ] Write movable-clock tests for one-shot/repeat/DST/restart, owner-presence edges, run overlap/offline/catch-up/timeout and three-failure pause.
- [ ] Confirm failing tests before implementing each slice.
- [ ] Reuse conversation send/cancel and scoped authority; deny agent activation and scope widening. Preserve the existing runtime permission gates.
- [ ] Integrate polling, cleanup and push; execution default-off.
- [ ] Run focused tests and integration tests, record evidence.

### 3. Runtime tools and owner presence
- [ ] Write failing tests for reminder/task/note tools, identity time context, unlocked owner session signals and authenticated node forwarding.
- [ ] Add tools to Claude, Codex, Hermes and applicable local tool paths, using existing proposal mechanisms.
- [ ] Implement session state reporting from the existing owner's helper; node-online alone never fires PC triggers.
- [ ] Run targeted runtime/node tests and record evidence.

### 4. Pages, panels and Presence
- [ ] Write failing browser tests for add/edit/complete/snooze/delete, notes search, task activate/pause/run history and panel mounting.
- [ ] Implement Reminders with Scheduled tasks tab, separate To-dos and Notes nav entries, page panels and due reminder/task result cards in Presence.
- [ ] Verify desktop and mobile using isolated local fixtures and no live agents.
- [ ] Run focused tests, typecheck and web build.

### 5. Review and delivery
- [ ] Review actual diffs and test security/trust boundary findings with red/green regressions.
- [ ] Record fresh verification and unverified live hardware/push checks in an acceptance checkpoint and implementation status.
- [ ] Commit only owned changes and push to origin/main. Leave production deployment to explicit approval.

## Review focus

- Model-originated task updates/activation and standing permissions cannot bypass owner authorization.
- Lock/unlock and reconnect events must not confuse node availability with the owner's account being present.
- DST and long shutdowns should yield at most one current firing, without replay floods.
- Runtime failures, unanswered approvals and process restart cannot leave an overlapping orphan run.
- Pages/panels preserve unsaved input across remounts and report rejected mutations clearly.

## Evidence and rulings

- Ruling: use the approved existing reminders design and proceed with implementation as requested, without repeating design approval. Notes are the owner's confirmed core-local notebook.
