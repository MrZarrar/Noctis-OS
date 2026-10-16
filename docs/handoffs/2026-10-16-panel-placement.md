# Handoff: panels never land on each other, and only a few stay open

## The problem the owner saw

During one agent turn, seven panels opened (a build script, two pages, four screenshots). Each new image panel
opened exactly on top of the previous image panel, so the page the owner wanted was buried under empty image
panels. The cause is in `apps/web/src/workbench/arrange.ts`: saved window geometry is keyed by panel kind, "so a
new panel of a kind opens where the last one was left". Every new panel of that kind lands on the same spot.

The owner's decisions:

1. A new panel must never open on top of an open panel. Remembering where the owner last left a kind is fine,
   but only when that spot is free. Otherwise the panel takes the next free spot (`defaultRect` already finds one).
2. Only a few panels stay open at once: at most **4** floating panels opened by agents. When another opens, the
   oldest-opened one that the owner has not pinned, moved, resized or focused goes into a **"+N more"** control,
   where the owner can see the hidden panels by title and bring any one back. Bringing one back counts as a new
   opening, so it goes on top and something else may tuck away. Pinned panels never tuck away, and do not count
   towards the 4.

## Where things are

- `apps/web/src/workbench/arrange.ts`: `defaultRect`, `fitRect`, `readWindows` / `writeWindows`, `stackOpened`.
- `apps/web/src/workbench/Workbench.tsx`: floating windows, stacking order, pin, sizes, pop out.
- `apps/web/src/workbench/PanelControls.tsx`, `reconcile.ts`, `display.ts`, `useComposition.ts`.
- `apps/web/src/pages/ThreadPanels.tsx` and `apps/web/src/pages/PanelTray.tsx` (mobile tray, a possible model for
  the "+N more" control).
- Tests beside each file (`arrange.test.ts`, `reconcile.test.ts`, `panel-controls.test.ts`...).

Read how a panel is opened, pinned and dismissed before choosing where the tuck-away state lives. Keep it in the
web, per browser, like window geometry. Do not change the core, the contracts or how the core decides which
panels exist. A tucked-away panel is not dismissed: it reappears in the "+N more" list, and if the agent updates
it, it shows a small "updated" mark there rather than jumping back open.

On a phone, panels already stack in the page or sit in the tray. Leave that behaviour as it is.

## Rules

- TDD: a focused failing test first for the placement rule (`arrange.test.ts`) and the 4-open rule, then make them
  pass. Pure functions where possible so they can be tested without a DOM. Tests in this repo use vitest and
  `renderToStaticMarkup`; there is no DOM test library.
- Match the surrounding code and comment style. Comments explain a non-obvious why, never cite files or docs, and
  never sound machine-generated. No AI attribution anywhere.
- The "+N more" control uses the app's existing button style and tokens from `@noctis/ui`, readable on the dark
  background (solid, not see-through), with keyboard access.
- Files you own: everything under `apps/web/src/workbench/`, plus `apps/web/src/pages/PanelTray.tsx` if you reuse
  it. Another agent is editing `apps/web/src/pages/Threads.tsx`, `apps/web/src/conversation/*` and the node, core
  and contracts at the same time, so do not touch those, and do not run any repo-wide formatting.
- Do not commit, stage or push.

## Checks

`npx vitest run apps/web` (with `--configLoader native --pool threads` if spawn fails on Windows),
`npm run typecheck`, and `npx eslint` plus `npx prettier --check` on the files you changed.

## Report back

Files changed, how the 4-open rule decides what tucks away, test and check results, and anything you were unsure
about.
