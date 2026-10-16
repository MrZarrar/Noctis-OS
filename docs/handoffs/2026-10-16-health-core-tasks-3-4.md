# Health core: Plan 2 Tasks 3 and 4 (Codex)

Implement **Task 3** and **Task 4** of `docs/superpowers/plans/2026-10-16-glycolens-noctis-integration.md`
exactly as written there (tests first, see them fail, then the code). Read the plan's "Global Constraints"
and "Review Focus" first.

## Already done (on `main`)

- Task 1, commit `004f0a2`: `packages/contracts/src/health.ts`, `health-fixture.ts`, the `healthRunAt`
  setting (contracts and `apps/core/src/config/settings.ts`), `glucose` API segment, `"Health"` page panel.
- Task 2, commit `da8b83c`: the three capabilities are registered in `packages/contracts/src/node.ts`
  (classes and contracts) and in `apps/core/src/nodes/ws.ts` `FRAME_BUDGET`. The node adapters live at
  `apps/node-agent/src/health/glycolens.ts` (moved from the plan's `src/health.ts` because the node's
  no-listener test bans `spawn` in top-level files).

## Your files

Only these: `apps/core/migrations/0021_health.sql`, `apps/core/src/health/*`,
`apps/core/src/nodes/registry.ts` (grant constraints) and its grant test,
`apps/core/src/productivity/triggers.ts` and `triggers.test.ts`, `apps/core/src/server.ts`,
`apps/core/src/api/http.ts`, `apps/core/src/api/headless.integration.test.ts`.
Do not touch `apps/web`, `packages/`, `apps/node-agent`, `package.json` or the lockfile: Claude is
working there at the same time.

## Rules

- The plan's code is a draft. Check every "Before relying on..." and "Checks before committing" note
  against the real code (`startJob` / `completeJob` / lease in `apps/core/src/nodes/jobs.ts`,
  `RevokeStandingPermissionCommandSchema`, whether `Kernel` has a logger, `runCommand` replay) and fix the
  code to match the repo, not the other way round.
- If the migration number 0021 is taken, use the next free number.
- Health data never goes into a log line, event payload or error message (only a schema path and issue
  code, as `parseHealthReport` does).
- Before running tests, set `TEMP` and `TMP` to `<repo>\.noctis\tmp` (short 8.3 temp paths break some
  node tests on this PC).
- Run: `npx vitest run apps/core/src/health apps/core/src/productivity/triggers.test.ts apps/core/src/api/headless.integration.test.ts apps/core/src/db apps/core/src/nodes`,
  then `npm run typecheck`, `npx eslint apps/core/src`, `npx prettier --check apps/core`.
- **Do not commit or push.** Claude reviews and commits.

## Report back

Files changed, every place you departed from the plan and why, and the exact test / typecheck / lint
results (counts).
