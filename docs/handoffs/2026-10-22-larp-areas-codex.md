# LARP mode: fixture areas for Codex

Read `AGENTS.md` and `docs/handoffs/2026-10-22-larp-mode.md` (the full LARP mode brief) first. Claude is
building `DemoTransport`, the scripted conversation engine, the Settings toggle and the Hardware panel.
You build **one fixture area**, named in your prompt. Several Codex runs work at once, one per area, so
touch only the files your area lists.

## The seam

`apps/web/src/larp/area.ts` defines `LarpArea` (`request` and `contentUrl`), `ok`, `parsePath` and
`rebase`. `apps/web/src/larp/ids.ts` holds fixed UUIDv7 ids every area shares (nodes, folder grants,
threads). Your area module exports one `LarpArea` constant. `DemoTransport` calls each area's
`request(method, path, body)` and takes the first answer that is not `undefined`; `path` is exactly what
the page passed (it may carry a query string). Return `undefined` for anything you do not own.

To learn what a real response looks like, read the core's GET routing (`handleRead` in
`apps/core/src/api/http.ts`, and the `COMMANDS` table) and the page that reads it. Every response must
parse with the schema the page parses it with: a `packages/contracts` schema where the page uses one,
otherwise the page's own local schema. If that local schema is not exported, add `export` to it and
nothing else, and say so in your report.

A POST `/commands/<name>` for your area answers like the real command would (read its handler under
`apps/core/src`) and changes only in-memory state, so the page sees its effect (a reminder ticked, a
suggestion accepted). Nothing is ever sent anywhere and nothing is written to disk or storage.

## Rules

- Fixtures are plain JSON files in `apps/web/src/larp/fixtures/`, easy for the owner to edit by hand.
  A larger set (the Vault) may come from a small generator script kept beside it (`make-<area>.mjs`,
  run with `node`), but the JSON it writes is committed and is what the app imports.
- Write timestamps as ISO UTC strings around the anchor day `2026-10-22` (that day is "today"). The area
  passes its fixture through `rebase()` once at module load, so the dates always look current.
- The fictional world: nodes "Home PC" and "Work PC" (online) and "Phone"; agents Claude, Codex, Hermes and
  a local model; no real people, places, emails, file paths, hostnames, IPs or health values. Invented
  names only. Believable content: small software projects, research, a bug fix, a side business.
- Test first: write `apps/web/src/larp/<area>.test.ts` that imports your area, calls `request` for every
  endpoint you serve and parses each body with the real schema. Run it red, then make it green:
  `npx vitest run apps/web/src/larp/<area>.test.ts`. Run only your own test, plus
  `npx eslint apps/web/src/larp` and `npx tsc -b --pretty false` at the end.
- UTF-8 without BOM. Match the repo's style (see neighbouring files). No new dependencies.
- Do not commit, stage or push. Claude reviews and commits.
- Owner writing style for any visible text: no em dashes, no "not X but Y" framing, plain sentences.

## Areas

### vault

Files: `larp/vault.ts`, `larp/vault.test.ts`, `larp/fixtures/vault.json`, optional
`larp/fixtures/make-vault.mjs`. May add `export` in `pages/Vault.tsx`, `pages/VaultLock.tsx`,
`pages/vault-lock.ts`, `pages/VaultEdits.tsx`.

Serve everything the Vault page and its lock read and do: `/vault` status, `/vault/graph`,
`/vault/edits`, `/vault/notes/<id>`, recall (find how `pages/Vault.tsx` asks), `vault.reindex` and the
other `vault.*` commands it sends, `/passcode` (unlocked, or a lock the passcode `1234` opens). Also the
`VaultRecallPayloadSchema` shape in `packages/contracts` so Claude can show a recall panel in a thread:
export `recallVault(query: string)` returning a valid recall result over the fictional notes.

The sphere must look rich: about 300 to 400 notes across `projects/`, `people/` (invented names),
`reference/`, `daily/` (the last few weeks), `inbox/` and `agent/`, with plenty of links (several per
note, some hubs), titles and bodies that read like a real second brain. Recall matches by words in
title and body and returns sensible results for queries like "hardware panel", "glucose", "Codex",
"pricing".

### health

Files: `larp/health.ts`, `larp/health.test.ts`, `larp/fixtures/health.json`. May add `export` in
`health/*.ts(x)` and `pages/Health.tsx`.

Serve everything `pages/Health.tsx`, `health/useHealth.ts`, `health/health-view.ts` and the Health status
read in `pages/Nodes.tsx` ask for (`/glucose` and the rest), plus the `health.*` commands they send
(accept a suggestion, dismiss, and so on) as in-memory changes. Start from
`packages/contracts/src/health-fixture.ts` and the real report schema in `packages/contracts/src/health.ts`.
Look at `docs/Mockups/health/*.png` for what a strong report shows. Content: a full fictional glucose day
(5-minute readings), time in range, findings and suggestions that show what glycolens is good at:
meal patterns, overnight corrections, a basal suggestion, and a past change marked as having helped.
Plausible values, entirely invented.

### productivity

Files: `larp/productivity.ts`, `larp/files.ts`, their tests, `larp/fixtures/productivity.json`,
`larp/fixtures/files.json`. May add `export` in `pages/Productivity.tsx`, `pages/productivity-view.ts`,
`pages/ProductivityPresence.tsx`, `pages/AutomationSettings.tsx`, `pages/Files.tsx`,
`pages/files-view.ts`, `pages/useFileText.ts`, `pages/folders-view.ts`, `surfaces/FileMedia.tsx`,
`surfaces/FileDocument.tsx`.

- Productivity: `/reminders`, `/tasks`, `/tasks/<id>/runs`, notes, the Presence digest
  (`pages/Presence.tsx` around line 112 reads one), and the commands those pages send (create, tick,
  snooze, delete) as in-memory changes. A populated week of reminders, to-dos and notes.
- Automations: `/places` and `/places/link` for places "Home", "Work" and "Gym" with a few recent visits.
- Files: `/files/list` and file content for the two folder grants in `ids.ts` (Home PC Projects, Work PC
  Documents): a believable tree with a few folders, source files, Markdown documents, a PDF-like
  document if the viewer supports one, and several images. `contentUrl` must return a `data:` URL
  (images drawn as generated SVG, text as text), never a network URL, because LARP mode sends no request
  to the core. Text previews go through `request` (`pages/useFileText.ts`). Writes, uploads and deletes
  answer as refused or as an in-memory no-op, whichever the page handles gracefully.

### world

Files: `larp/world.ts`, `larp/world.test.ts`, `larp/fixtures/world.json`. May add `export` in
`pages/Nodes.tsx`, `pages/Settings.tsx`, `pages/CoreSettings.tsx`, `pages/UsageLimits.tsx`,
`pages/LiveSessions.tsx`, `pages/Conversations.tsx`, `pages/Artifacts.tsx`, `pages/AgentQuestions.tsx`,
`pages/BeforeNoctis.tsx`, `pages/TaskPermissions.tsx`.

Serve the static world: `/nodes` and `/nodes/<id>` (and any per-node read the Nodes page makes: grants,
root ids, hosts) for Home PC and Work PC online and Phone connected, with Claude, Codex, Hermes and a
local model ready where it makes sense; `/models` (including `roots` for the two folder grants in
`ids.ts`, which the composer and Files use); `/permissions` and `authority.revoke_permission`;
`/configuration`; `/limits` (healthy usage values); `/remote/hosts` (none, or ones that cannot open);
`/live-sessions` and its entries; `/sessions`; `/artifacts`; the agent questions list; the
"before Noctis" history; `/push/key` and `/push/subscribe` (answer so the page believes it is
subscribed); `/session/logout`; and the `node.*` commands those pages send (`node.grant_capability`,
`node.unshare_folder`) as in-memory changes. Leave out `/identities`, `/conversations`, `/threads`,
`/turns`, `/approvals`, `/events` and `conversation.*`, `surface.*`, `identity.activate`: Claude owns
those. `contentUrl` for the Nodes screen mirror returns `undefined` (the page then shows no live
mirror) unless you can draw a convincing static desktop as an SVG `data:` URL.

## Report back

Files changed (including any `export` added to a page), every endpoint and command you serve, anything a
page does that bypasses the transport, and the test, lint and typecheck output.
