# Productivity handoff — 15 October 2026

**Stopped at the owner's request. Implementation is substantial but unfinished. Nothing from this task was committed, pushed or deployed.** All changes are in the current checkout, including untracked files. Preserve unrelated work and `debug.log`; HEAD at handoff is `0da4fe0` (`docs(glycolens): implementation plan`), an unrelated commit.

## Implemented

- Core-local reminders, to-dos and notes: contracts, migration `0019_productivity.sql`, transactional CRUD, revision/idempotency checks, authenticated API routes, notes search and identity provenance.
- Shared trigger engine: one-time, weekly/time-zone, interval and owner-at-PC triggers; repeating reminders, missed-time catch-up, Done and time/next-PC snooze.
- Scheduled tasks: paused creation, owner activation/editing, proposed edits held for owner review, pinned runtime threads, history/results, offline catch-up, overlap checks, timeouts and pause after three failures. Execution defaults off (`NOCTIS_TASKS_ENABLED`).
- Task-scoped standing permissions, revocation and the Approvals page's “Always for this task” action. Models can propose changes, run an enabled task or pause it; they cannot activate tasks or grant permissions.
- Claude/Codex/Hermes capture tools and fresh owner clock context. Local runtime remains text-only.
- Authenticated owner-presence reporting through the existing Windows helper; defaults off. Both helper and node need `NOCTIS_OWNER_PRESENCE=1` when eventually deployed.
- Reminders/Scheduled tasks, To-dos and Notes pages and adaptive panels; Presence cards; capture receipts; task permission controls; task-result links that switch to the correct identity.
- Node-side scheduled-job queue waits for the previous adapter promise to finish cancellation cleanup. Ordinary conversations keep existing concurrency.

## Still needs finishing

**Open after the 15 Oct first pass: items 3, 4 and 6.**

1. ~~**Threads grouping:**~~ **Done 15 Oct:** `conversationGroups` in `conversations-view.ts`, used by the Conversations drawer. backend `ConversationSummary.taskId/taskName` exists, but frontend grouping was interrupted. `apps/web/src/pages/conversation-groups.test.ts` imports `conversationGroups`, which was not implemented at stop. Finish the existing Conversations drawer grouping.
2. ~~**Task-action receipts:**~~ **Done 15 Oct (Codex).** `Threads.tsx` handles the new `task_action` label, but `ProductivityReceipt.tsx` still ignores that variant. Add a truthful result/link without offering activation.
3. **Natural-language target discovery:** tools require node UUIDs, shared-folder grant IDs and task IDs. No current catalogue was added to runtime context. Wire deterministic discovery/context so “when I get home” can resolve the correct PC without inventing identifiers. This was identified but not implemented.
4. **Cancellation guarantee:** the queue proves adapter cleanup serialization, not OS process-tree exit. Existing Codex/Hermes process close sends `kill()` without awaiting OS exit. Review/fix this before claiming physical execution can never overlap, including restart recovery.
5. ~~**Final integration checks:**~~ **Done 15 Oct**, see `IMPLEMENTATION-STATUS.md`. rerun typecheck, scoped lint/formatting, focused tests and both browser suites after finishing the partial edits. The last combined typecheck failed on task-action narrowing in `Threads.tsx`; that line was subsequently fixed, but the final state was not rechecked.
6. Browser-check the new “Always for this task” action and its failure path. Helper unit tests pass; this action has not had a browser verification.
7. ~~Update acceptance evidence~~ **Done 15 Oct.** Update acceptance evidence and `docs/acceptance/IMPLEMENTATION-STATUS.md`, review the final diff, then commit/push under the repo's standing authorization. Do not deploy or enable production capabilities without explicit approval.

## Verification already observed

These are separate checkpoints, **not a final combined green result**:

- Root focused backend/domain/approval run: **136 tests passed across 10 files**.
- Latest root task tests: **16 passed**, including offline catch-up, scoped authority, result persistence, next-PC snooze and proposed edits.
- Runtime agent reported **414 passed across 35 files**, including scheduled-job serialization; node-agent typecheck and scoped ESLint passed.
- Storage agent reported **47 focused conversation/task-action tests passed** after adding model Run now/Pause.
- Frontend agent reported desktop 1280px and phone 390px checks passing for the actual app against an isolated core, plus a strict contract fixture. Screenshots are under `.noctis/productivity/`. Grouping was started afterwards and remains unfinished.
- No real phone push, live agent execution, Windows lock/unlock/other-account test, production restart or deployment was performed.

## Resume pointers

- Original decisions: `docs/superpowers/plans/2026-10-12-reminders.md`.
- Working plan: `docs/superpowers/plans/2026-10-14-productivity-implementation.md` (checkboxes were not kept current; use this handoff).
- Main code: `apps/core/src/productivity/`, `packages/contracts/src/productivity.ts`, `apps/web/src/pages/Productivity*.tsx`, `apps/node-agent/src/proposal-tools.ts` and `screen/{owner,presence}.ts`.
- Browser suites: `node --test apps/web/e2e/productivity.test.mjs apps/web/e2e/productivity-app.test.mjs` (build core first; use Node **22.23.2**, existing lock/dependencies).

All subagents were stopped. No remaining matching productivity/Vitest test processes or listeners on test ports 4283, 4284 and 8898 were found during shutdown. Unrelated Node processes were left alone. No further tests were started after the stop request.
