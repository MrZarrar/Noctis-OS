# Health: "Allow health on this PC" on the Nodes page (Codex)

Part of Plan 2 Task 6 in `docs/superpowers/plans/2026-10-16-glycolens-noctis-integration.md` (read its
"Nodes allow" bullets and Global Constraints).

## Done already

The core serves `GET /glucose` (a `HealthStatus`, see `packages/contracts/src/health.ts`) and the commands
`POST /commands/health.allow` `{ idempotencyKey, nodeId, repo, home? }` and
`POST /commands/health.disallow` `{ idempotencyKey, nodeId }`. Allowing grants the three health
capabilities plus standing permissions; Stop revokes all of it.

## What to build

In `apps/web/src/pages/Nodes.tsx` only, next to the existing screen-view `allow` control (search for
`screen.view`):

- A "Health (glycolens)" row for each online node.
- A text field labelled "glycolens folder", placeholder `C:\Users\you\Documents\glycolens`, required to
  allow (an absolute folder; the core validates and refuses anything else).
- "Allow health on this PC" posts `health.allow`; "Stop" posts `health.disallow`.
- Read `GET /glucose` (parse with `HealthStatusSchema`) to show "Allowed" when `granted && nodeId === node.id`,
  and offer Stop then instead of Allow.
- Reuse the page's own `nextKey`, `setProblem`, refusal text and button/field styles exactly as the
  screen-view control does. Re-read `/glucose` after each command.
- One short line under it: "Runs glycolens on this PC weekly and when you press Run now. The report stays
  on your machines."

## Rules

- Only `apps/web/src/pages/Nodes.tsx` (and a focused test beside it if the page already has a testable
  helper pattern). Claude is editing `apps/web/src/App.tsx`, `apps/web/src/health/*` and `packages/ui` right
  now: do not touch them.
- Set `TEMP` and `TMP` to `<repo>\.noctis\tmp` before running anything.
- Run `npx tsc -p apps/web --noEmit`, `npx eslint apps/web/src/pages/Nodes.tsx`, `npx prettier --check apps/web/src/pages/Nodes.tsx`.
- **Do not commit or push.**

## Report back

What you changed, and the check results.
