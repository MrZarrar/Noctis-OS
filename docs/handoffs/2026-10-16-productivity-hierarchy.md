# Productivity pages: clearer hierarchy (Codex brief)

Owner, 2026-10-16: implement the app motion audit's top five. This brief is rank 2 of
`docs/handoffs/2026-10-16-app-motion-audit-report.md` (read its rank 2 row, the "Keyed list
arrival/result transition" shared piece, and section 4). ranks 1, 3, 4 and 5 are being done in
the same working tree at the same time.

## Task

Rework the look of Reminders, To-dos, Notes and Scheduled tasks in
`apps/web/src/pages/Productivity.tsx` so they read like the today-plan mockup
(`docs/Mockups/noctis-today-plan-03-shape-the-day.png`): time-led, with a clear due label and
different emphasis for what is due, snoozed and done. Right now every record and the editor use the
same `card` style, the large editor sits before the list, reminder state is mostly text and
strike-through, and run history is a plain list.

What done looks like:

- **Reminders**: an agenda ordered by when they are next due (`nextDueAt`, then trigger), each row
  led by a clear time/due label (overdue and due-soon stand out). Snoozed and done are visibly
  separate (a "Done" group, or a quieter treatment with a word plus an icon/shape, never colour alone).
- **To-dos**: compact actionable rows. Completing one is acknowledged (a brief checked state that
  then settles into a quieter "done" treatment), not just a strike-through. Only after the core
  confirms the command; never optimistic.
- **Notes**: stronger title/body hierarchy (title weight, clamped body preview, quieter meta line).
  Editing a note keeps it in context rather than only filling the editor at the top.
- **Scheduled tasks**: distinct paused / on / suggested-changes labels with a word and a shape. Run
  history becomes a readable strip or compact list with status words (`replaceAll("_", " ")` today),
  start time, and the Open thread action. Do not imply progress percentages.
- **Editor**: less visual weight than the list; the list is the page's primary content. A collapsed
  "Add a reminder" style entry that expands is fine, as long as every label and button below still
  exists when it is expanded and the draft is preserved (drafts already live in a module-level cache).
- New records arrive with a short entrance, once. Use the shared helpers in
  `apps/web/src/layout/motion.tsx`: `useArrivals(keys)` returns the keys that just arrived,
  `entrance(fresh, key)` gives `initial`, `SETTLED` is `animate`. Render rows as `motion.article`
  (import `motion` from `motion/react`). Do not pass your own `transition`: the app-wide
  `MotionPolicy` sets timing and makes it instant under reduced motion. Removals can use
  `AnimatePresence` from `motion/react` with an exit fade, but disable the row's buttons first.

## Constraints

- Only edit `apps/web/src/pages/Productivity.tsx` (and `SnoozeChoices.tsx` / `TaskPermissions.tsx`
  if needed). Do not touch `index.css`, `layout/`, `App.tsx`, `Threads.tsx`, `Files.tsx`,
  `workbench/` or `packages/ui/` (another session is editing those). Do not install packages.
- Styling is inline React style objects using tokens from `@noctis/ui` (`material`, `corner`,
  `semantic`, `spacing`, `typography`, `identityAccent`) and `buttonStyle`, `fieldStyle`, `glass`,
  `SectionHeading` from `../layout/Page.js`. No CSS files, no inline `<style>` (CSP forbids it).
- Never meaning by colour alone. 44 px controls. Readable at 390 px wide and inside a narrow page
  panel (the page also renders inside panels).
- Keep every behaviour: commands, expected revisions, focusId editing, error text, drafts.
- Keep these working exactly, since e2e tests depend on them: the labels "Reminder", "To-do",
  "When", "Title", "Note", "Search notes", "Task name", "Prompt", "Capability", "Target type"; the
  buttons "Add reminder", "Add to-do", "Save note", "Save changes", "Snooze 1 hour", "Done", "Edit",
  "Delete", "Create paused task", "Turn on", "Pause", "Run now", "Add permission", "Open thread";
  the tab "Scheduled tasks"; note titles as headings; "Standing permissions (N)". The phone test
  waits for text matching `/snoozed/` and `/^done /` after Snooze and Done; if you change the status
  wording, update `apps/web/e2e/productivity.test.mjs` to the new wording in the same change and say so.
- TDD per `AGENTS.md`: for any new pure logic (agenda ordering, due labels), add a failing test in
  `apps/web/src/pages/productivity-view.test.ts` first (put the logic in `productivity-view.ts`).
- Do not commit or push. The work is reviewed and committed separately.

## Verify

Use the pinned Node in the repo. Run:

- `npx vitest run apps/web/src/pages`
- `npx tsc -b --pretty false` (errors in files being edited at the same time are not yours;
  mention them but do not fix them)
- `node --test apps/web/e2e/productivity.test.mjs` (starts Vite on its own port with a fake core)
- `npx eslint apps/web/src/pages/Productivity.tsx apps/web/src/pages/productivity-view.ts`
- `npx prettier --check` on the files you changed

## Report back

Files changed, what each page now looks like, the verification output, and anything left open.
