# Handoff: times, a live activity line and an agent map in Threads

The owner cannot tell what an agent is doing. A turn card says only "Working" for minutes while everything the agent
does is folded under Details, messages carry no time, and there is no overview of sub-agents. The owner's decisions:

1. **Times on messages**, clock time like Claude: "14:32" today, "Yesterday 14:32", then "16 Oct 14:32", with the
   full local date and time on hover (`title`) and in a `<time dateTime>` element. Each message bubble
   (`entry.message.createdAt`) shows it beside the role label.
2. **Turn duration**: each turn card shows "Worked 7m 30s" from `startedAt` to `completedAt`, and while it runs
   counts up live ("Working · 2m 10s"), ticking once a second only while some turn is running.
3. **A live activity line** in a running turn card: what the agent is doing right now, derived from the turn's
   items, newest first, ignoring `agent_message` items. For the newest `in_progress` item: a command shows
   "running <command, first line, ~80 chars>", a file change "editing <file name>", a tool call "using <tool>", a
   sub-agent "<label>: <activity or working>". If nothing is in progress, the last completed step ("ran ...",
   "edited ..."). Items with `parentItemId` belong to a sub-agent; the line names the main agent's own work first
   and falls back to "N sub-agents working" when only sub-agents are busy.
4. **An agent map**: a button in the Threads page header actions (beside "Conversations"), labelled like
   "Agents · 3" with a small pulsing dot while any is running. It opens an overlay like Claude's agent map:
   - One card for the main agent (the identity, e.g. Vesper, and the model from the newest turn): status, the live
     activity line, elapsed time.
   - One card per sub-agent (`sub_agent` items across the thread's turns, the newest item per `itemId` wins), linked
     visually to the main agent: label, status dot (purple running, green done, red failed), activity while
     running, `durationMs` and `tokens` when present ("2m 30s · 82.3k tokens"), `toolUses`.
   - One card per delegated thread (`conversation.children`), with a button that opens it (`onOpenThread`).
   - Clicking a sub-agent card shows its details: `task` (what it was asked), its steps (the turn items whose
     `parentItemId` is that sub-agent's `itemId`, rendered with the existing `ItemRow`), and its `report` as
     Markdown. Not its full output.
   - Close with a close button, Escape, or clicking outside. Keyboard reachable. Solid background (the app's
     `depth`/`material` tokens), readable, not see-through glass.
   - On a phone it fills the screen.
   - When there are no sub-agents or delegated threads the button still shows the main agent ("Agents · 1").

The contract already carries what this needs (`packages/contracts/src/runtime.ts`): every item may have
`parentItemId`; a `sub_agent` item may have `activity`, `task`, `report`, `tokens`, `toolUses`, `durationMs`. Turns
carry `startedAt`, `completedAt`, `status`, `items`, `model`.

## Where things are

- `apps/web/src/pages/Threads.tsx`: the page, `TurnRow`, `ItemRow`, the header actions, the existing sub-agent
  list in the turn card (keep it as the quick view).
- `apps/web/src/conversation/useConversation.ts`: `ConversationState`, `Turn`, `children`.
- `apps/web/src/layout/Page.tsx`: `buttonStyle`, `Page`.
- `packages/ui` tokens: `depth`, `material`, `typography`, `identityAccent`, `semantic`, `spacing`, `corner`.
- Tests: `apps/web/src/pages/Threads.test.ts` (renders with `renderToStaticMarkup`).

Put the agent map in a new file `apps/web/src/pages/AgentMap.tsx`, and the formatting and activity rules in pure
functions (e.g. `apps/web/src/pages/turn-activity.ts`) so they are tested without a DOM.

## Rules

- TDD: failing tests first for the time format, the duration, the activity line and the agent map's content, then
  make them pass. There is no DOM test library; use pure functions and `renderToStaticMarkup`.
- Times are the browser's local time zone. Tests must not depend on the machine's zone: pass a `now` and a
  `timeZone` (or a formatter) into the pure functions.
- Match the surrounding code and comment style. Comments explain a non-obvious why, never cite files or docs,
  never sound machine-generated. No AI attribution anywhere.
- Files you own: `apps/web/src/pages/Threads.tsx`, `Threads.test.ts`, the new `AgentMap.tsx`, `turn-activity.ts`
  and their tests. Another agent is editing everything under `apps/web/src/workbench/` and `PanelTray.tsx` at the
  same time, and I am editing the node, core and contracts, so do not touch those and do not run repo-wide
  formatting.
- Do not commit, stage or push.

## Checks

`npx vitest run apps/web` (with `--configLoader native --pool threads` if spawn fails on Windows),
`npm run typecheck`, `npx eslint` and `npx prettier --check` on the files you changed.

## Report back

Files changed, test and check results, and anything you were unsure about.
