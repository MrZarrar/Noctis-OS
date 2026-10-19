# Handoff: draw the new `options` panel in the web app

## Why

The owner asks an agent things like "find me a USB-C cable under £10 for my MacBook and show me the best 3 options to
add to my basket". The agent searches in the owner's real Chrome and should then show the options as a panel with a
screenshot of each, so the owner can look and pick one with a button. The owner's words: a panel "showing the best
3 … screenshots and i can click and choose which one to add to the basket".

The contract and the core are done. Your part is the renderer.

## The contract (already built; read it)

`OptionsPayloadSchema` in `packages/contracts/src/surface-payloads.ts`, registered as surface kind `options` in
`SURFACE_PAYLOAD_SCHEMAS`:

- `title`
- `options`: 1 to 8, each `{ id, title, price?, detail?, image?, url?, action? }`
  - `image` is a `FileSource` (`from: "file"`, nodeId, grantId, relativePath) the core resolved from a path the agent
    gave. Load it the way the `media` panel loads a file: see `apps/web/src/surfaces/FileMedia.tsx` and the
    `mediaUrl` handoff in `apps/web/src/pages/ThreadPanels.tsx`.
  - `url` is an `http`/`https` link to the listing.
  - `action` is `{ label, message }`, e.g. `{ label: "Add to basket", message: "Add option anker to my basket" }`.
- `actions`: optional panel-level choices, like every other panel kind.

## What to build

1. Register `options` in `apps/web/src/surfaces/registry.ts` and render it in `apps/web/src/surfaces/renderers.tsx`,
   following how `list`, `media` and the other proposable kinds are registered (size, title, gates).
2. Each option is a card: the screenshot on top (contained, not cropped badly; a calm placeholder when there is no
   image or it fails to load), then title, price (prominent), detail, the link, and the option's own button.
3. **The link.** The owner decided agents may supply links as long as the owner can inspect the address before
   opening. So:
   - Always show the link's host visibly on the card (e.g. `amazon.co.uk`).
   - Show the full URL on hover (a `title` tooltip is the minimum; a nicer hover reveal is welcome) and keep it
     available without hover too, because the phone has no hover: e.g. the full address in the link's accessible name
     and revealed on focus or tap.
   - Open in a new tab with `rel="noopener noreferrer"`. Only render the link if it parses as `http:`/`https:` (the
     schema already enforces it; check again at the edge).
4. **The button.** Pressing an option's button sends its `message` to the conversation through the same handoff the
   other panels' actions use (`onPanelAction(message, owner)`), honouring `panelActionsDisabled` and showing
   `panelActionsError` the same way. Panel-level `actions` render as the other kinds do.
5. Layout: cards side by side on desktop (wrap to rows), stacked on the phone. Match the existing panel look
   (`@noctis/ui` tokens, `glass`, typography); it should look premium. The owner welcomes a well-known library if it
   genuinely helps, installed with `--save-exact`, but nothing that loads from the network: the app's CSP allows images
   only from itself (`img-src 'self'`), which is why pictures are files served by the core.

## Rules

- Follow `AGENTS.md`: a focused failing test first (unit tests beside the code, e.g. `registry.test.ts`, and one e2e
  case in `apps/web/e2e/panels.test.mjs` or a new e2e file using `apps/web/e2e/harness.mjs` fakes), see it fail, then
  pass. Run e2e files one at a time (`--test-concurrency=1`): run together they rebuild `apps/web/dist` and fail on a
  locked file. Some existing tests in `panels.test.mjs` and `phone.test.mjs` already fail on unchanged code; do not
  fix those, just make sure you add no new failures.
- Edit only `apps/web/`. Another engineer is editing `apps/node-agent/` and `apps/core/` at the same time.
- Do not commit, push, stage, or run any git command that changes state. No deploys, no restarting Noctis.
- Code comments: only a non-obvious why, written like a human engineer. Never cite docs, specs or file paths; never
  sound machine-generated.

## Checks before you finish

From the repo root: `npx tsc -b --pretty false`, `npx vitest run apps/web`, your e2e file(s), `npx eslint` and
`npx prettier --check` on every file you changed.

## Report back

Files changed, what the card looks like (and a screenshot path from the e2e run if you took one), red → green
evidence, check results, anything not verified.
