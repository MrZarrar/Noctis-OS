# Video editor page wiring (apps/web)

This is a fresh-session handoff: nobody is watching this run. Complete the
whole task below yourself, including verification and the commit, and do not
stop to ask — this repo's `AGENTS.md` already gives standing permission to
commit and push once your own tests pass (see "Commit, verify, report" at the
bottom). A previous attempt at this same brief stopped short because it hit a
real contracts gap; that gap is now explicitly unblocked below (see Step 0).
If you hit a genuinely new blocker not covered here, stop and write it into
your final report rather than guessing, the same way the previous attempt did
— that was the right call, this update just closes the one gap it found.

## Task

Add a new rail page, "VideoEditor", to the Noctis web app. It is an `<iframe>`
pointing at an externally-running video editor server (a separate Node process
on the home PC, not part of this monorepo). The backend side of this is
already done and merged on this branch:

- `GET /video-editor` (session-authenticated, same auth gate as every other
  read route) returns `{ "origin": string | null }`: the configured editor
  server's bare origin (e.g. `"http://100.70.27.11:7700"`), or `null` when
  unconfigured. See `apps/core/src/api/http.ts`, the `handleRead` function,
  the block right after the `"remote" && "hosts"` case.
- The Content-Security-Policy already opens `frame-src <that origin>` when it
  is configured, so the iframe will actually load once this origin is set.
  See `pageSecurityPolicy` in `apps/core/src/api/static.ts` — nothing to
  change there, just context for why the iframe will or won't load.
- `GET /video-editor` only ever returns a configured origin when the owner
  set `NOCTIS_VIDEO_EDITOR_ORIGIN` in the core's environment; in dev it will
  be `null` unless you set that env var yourself when starting the core.

Your job is the frontend half only: the page component, its registration, and
making the companion column hide beside it.

## What to build

0. **Unblock contracts (the one exception to "don't touch packages/contracts").**
   `packages/contracts/src/surface-payloads.ts` has `PAGE_PANEL_PAGES` (around
   line 82), the allowlist that types `renderPage`'s payload (`PagePanelPayloadSchema`,
   `z.enum(PAGE_PANEL_PAGES)`). It does not include `"VideoEditor"`, so the
   `case "VideoEditor":` arm required in Step 2 below will not typecheck until
   you add it there. Add `"VideoEditor"` to that array (anywhere in the list
   is fine — it is not alphabetised, just read the existing order first and
   match it) and nothing else in that file or anywhere else under
   `packages/contracts/`. Run `npx vitest run packages/contracts` after this
   one change, before touching anything else, to confirm nothing there broke.

1. **`apps/web/src/pages/VideoEditor.tsx`** — a new page component. Look at
   an existing simple page for the house style (how other pages fetch from
   the core, loading/error states, props shape) — `apps/web/src/pages/Vault.tsx`
   and `apps/web/src/pages/Threads.tsx` are the two named as the precedent to
   match in the design doc at
   `docs/superpowers/specs/2026-10-30-video-editor-noctis-integration.md`
   (read that file first, it has the full design reasoning). Behavior:
   - On mount, `fetch("/video-editor")` (same pattern as however the other
     pages call the core's REST API — check how an existing page issues a
     `fetch` for a GET and reuse that, including credentials/cookie handling;
     do not invent a new fetch wrapper if one already exists in
     `apps/web/src/` for this).
   - If `origin` is `null` or the fetch fails: render a plain, calm message
     that the video editor is not configured (or not reachable) and nothing
     else fancy — no retry loop, no polling, this is a config-gated feature
     and the owner will set the env var and restart the core when they want
     it on.
   - If `origin` is a string: render `<iframe src={origin} />` filling the
     page's content area (no project parameter in the URL — the editor's own
     built-in project picker is the landing page at its root, by design).
   - No border/chrome around the iframe beyond whatever the page's own layout
     wrapper already gives other full-bleed pages (check if Vault or another
     page already does a "no padding, fill available height" layout and reuse
     that pattern rather than inventing new CSS).

2. **Register the page** in `apps/web/src/App.tsx`:
   - Import `VideoEditor` the same way `Vault` and `Threads` are imported.
   - Add `{active === "VideoEditor" && (<VideoEditor .../>)}` alongside the
     existing per-page conditional blocks (see how the `Vault` block passes
     `transport` or other props — VideoEditor likely needs none, since it
     talks to the core directly via `fetch`, not through whatever `transport`
     carries, but check first rather than assuming).
   - There is a second switch, `renderPage` (a `switch (payload.page)` used
     when a page is opened from inside another surface, e.g. linked from a
     thread) — add a `case "VideoEditor":` arm there too for consistency with
     every other page, even though nothing will deep-link to it yet.

3. **Rail entry** in `packages/ui/src/primitives/rail-items.ts`:
   - Add `"VideoEditor"` to the `NAV_ITEMS` array (not `HIDDEN_ITEMS` — the
     owner wants this reachable the same way Threads or Vault are, a
     permanent rail destination, not a flag-gated legacy page).
   - Find wherever `RailItem` values get a nav icon (grep for `NavIcon` or
     similar in `packages/ui/src/primitives/Rail.tsx` — there is a switch or
     lookup mapping each `RailItem` to an icon component) and add a case for
     `"VideoEditor"`. Pick an icon from whatever icon library/set the other
     entries already use (do not add a new icon dependency) — something like
     a film strip, clapperboard, or video-camera glyph if the existing set
     has one; otherwise the closest sensible existing icon.

4. **Companion dock** in `apps/web/src/companion/dock.ts`:
   - Add a case: `if (page === "VideoEditor") return { anchor: "hidden", size: 0 };`
     placed the same way the existing `"Vault"` special case is (before the
     default `return { anchor: "corner", ... }`). The editor already uses its
     own full width, the same reasoning as a full-screen remote desktop page
     if there's a similar precedent — check `dock.ts` for one before writing
     this, since the exact shape of the `Dock` type and existing cases should
     be read first rather than guessed.

## Tests (required — this repo does strict TDD, write the failing test before the code)

- `packages/ui/src/primitives/rail-items.test.ts` already exists and tests
  `NAV_ITEMS`/`railItems()`. Add a test asserting `"VideoEditor"` is present
  in `railItems(false)` (i.e. it's a v1 item, not gated behind the all-pages
  flag). Write it, run it, confirm it fails, then make `rail-items.ts` pass.
- `apps/web/src/companion/dock.ts` already has `apps/web/src/companion/dock.test.ts`.
  Add a test asserting `dockFor("VideoEditor", <any state>, false)` returns
  `{ anchor: "hidden", size: 0 }`, matching the existing test style in that
  file for the `"Vault"` case. Red, then green.
- There is no existing unit/component test file for `App.tsx` or individual
  simple pages like `Vault.tsx`/`Threads.tsx` — match that precedent and do
  not add one for `VideoEditor.tsx` either; don't invent test infrastructure
  that doesn't exist elsewhere in this app. (If you find one does exist for
  some page, follow it — check first.)

## Constraints

- Do not touch `apps/core/**`. That side (config, CSP widening, the
  `GET /video-editor` route) is already done and merged on `main`
  (commit `e3cdb8b`).
- The only change allowed under `packages/contracts/**` is the one-line
  `PAGE_PANEL_PAGES` addition in Step 0. Nothing else there.
- Do not add new npm dependencies.
- Follow this repo's existing TypeScript/React conventions exactly as they
  appear in the files you're editing — no new patterns, no refactors of
  surrounding code.
- Keep the diff tight. This is wanted quick and cheap: match existing
  patterns rather than designing anything new, and don't add polish (retry
  loops, animations, extra states) beyond what Step 1-4 ask for.

## Commit, verify, report

1. Run `npx tsc -b apps/web packages/ui packages/contracts` and
   `npx vitest run apps/web packages/ui packages/contracts`. Both must be
   clean before you commit.
2. Commit the changes yourself (`git add` the specific files you touched —
   never `git add -A`, there is an unrelated untracked `debug.log` in this
   repo root that is not yours to commit) and push to `origin/main`. This
   repo's `AGENTS.md` gives standing permission for this once your tests
   pass: do not wait for approval. Do not force-push, do not amend an
   existing commit, do not touch git history.
3. Write your final message as a report (nobody is watching the session
   live): every file changed or created, the full text of the new test(s),
   the tsc and vitest summaries, the commit hash you pushed, and anything you
   decided as a judgment call (e.g. which icon you picked and why, what the
   fetch call ended up looking like).
