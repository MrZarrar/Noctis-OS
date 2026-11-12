# LARP: one scripted turn that opens progress, reference and result panels

## Task

LARP mode (demo mode for filming, `apps/web/src/larp/`) can script Hardware, options, recall and page
panels, but none of the panels the owner sees during real longer work. Add one scripted Vesper turn so
the owner can record them.

Trigger: a message containing "launch ready" or "get paperbird" (any case), for example "get the
Paperbird launch ready". Paperbird is an existing fictional project in `fixtures/files.json`.

What it does, in order:

1. Vesper replies with one short line (from a cycling `replies` list, like `options`).
2. A progress panel opens: kind `timeline` (`TimelinePayloadSchema` in
   `packages/contracts/src/surface-payloads.ts`), about five steps such as "Read the brief", "Check the
   store listing", "Draft release notes", "Size the screenshots", "Write the launch post". Steps tick
   to done one at a time a few seconds apart, by re-upserting the same panel (same `sourceIds`), so
   it updates in place rather than opening new panels.
3. Partway through, a reference panel opens with the sources Vesper used: pick whichever existing
   kind fits sources best (`evidence`, `list` or `artifact` with `external_reference`; read the
   schemas and the web renderers in `apps/web/src/surfaces/` and choose the one that looks best).
   Three or four fictional but plausible sources. Any links must be on example domains or the
   fictional world, never a real company's site.
4. When the last step ticks, a result panel opens: kind `document` with an inline markdown launch
   brief (a heading, a short release-notes section, a launch post draft). Then Vesper says one closing
   line.

Total run about 20 to 30 seconds so it films well.

## Constraints

- Extend fixtures, not pages: the text, steps, sources, timings and match phrases live in
  `apps/web/src/larp/fixtures/script.json` under a new key next to `options` and `recall`; update the
  `_readme` line there (script order and what the new key does).
- Follow how `openOptionsPanel` and `openRecallPanel` in `apps/web/src/larp/core.ts` build and upsert
  intents, and how the `options` branch near line 319 matches and schedules with `later(...)`. Put the
  new branch in the same chain so earlier scripts still win.
- Every payload must parse with its contract schema. No personal data, no real people.
- Writing in every string: no em dashes or spaced en dashes, straight quotes, plain sentences, British
  spelling, no "seamless", "robust", "leverage" and similar filler.
- Write a focused failing test first (add to `apps/web/src/larp/DemoTransport.test.ts`, alongside
  "opens one options panel when asked to find something"): the phrase yields exactly one timeline
  panel that ends with every step done, one reference panel, and one document panel, all schema
  valid, using fake timers. See it fail, then pass.
- Run only `npx vitest run src/larp` and `npx tsc --noEmit -p .` in `apps/web`. No broad suites, no
  browser.
- Do not touch `apps/node-agent/`, `docs/operations/HOME-SETUP.md`,
  `docs/handoffs/2026-10-30-video-editor-page-wiring.md` or `debug.log` (other unfinished work).
- Do not commit. Leave the changes in the working tree.

## Report back

Files changed, the phrases that trigger the turn, which kind you chose for the reference panel and
why, the test and typecheck output lines, and anything you were unsure of.
