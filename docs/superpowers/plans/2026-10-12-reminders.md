# Reminders and to-dos: plan

> **Not started.** It waits for the adaptive panels (`2026-10-09-adaptive-panels.md`) to be built first (owner, 12
> October 2026). Use superpowers:writing-plans to turn the task list below into step-by-step tasks when work starts,
> and settle the decisions first.

## What the owner asked for

"After doing the adaptive panels, add reminder and to-do list functionality where I can dump something into Vesper,
like 'remind me when I get home to do this', and it records it, adds it to the reminders section and shows me in
Presence when relevant, like at the appointed time or when the home PC comes online."

## How it works

1. **Capture.** The owner says it to Vesper in any thread, from the phone or a PC, in ordinary words. Vesper calls a new
   proposal tool, `noctis_propose_reminder`, with the wording, an optional note, and a trigger. Like every proposal,
   it is data until the core validates it. The model never writes the reminder itself (`AGENTS.md`: models propose,
   deterministic code owns state). A quick-add box on the Reminders view does the same without a model.
2. **Triggers** (one per reminder):
   - **at a time**: an ISO time the model resolved from "tomorrow at 9" or "in two hours". It is validated as in the
     future, and the owner's time zone comes from the core's clock settings.
   - **when a PC is next in use**: "when I get home" means `zarrarpc`, and "when I'm at work" means `work`. See D2 for
     what "in use" means.
   - **none**: a plain to-do, kept on the list until it is ticked off.
3. **Confirmation in the thread.** Vesper's reply says what was recorded and when it will fire, for example "I'll
   remind you when zarrarpc is next on: renew the car tax." The thread shows a small card for it with **Undo**, so a
   misheard reminder is one tap to remove.
4. **Firing.** Deterministic core code, never the model:
   - A timer handles time triggers, the same way the daily digest is scheduled (`msUntilNext` in `notify`).
   - The node connection events (`node.connected.v1`, or the D2 signal) handle PC triggers.
   - A due reminder becomes `due`: it is pushed to the phone (`notify/push.ts`), and it shows in Presence until it is
     done or snoozed.
5. **Presence.** Due reminders sit under the greeting, each with **Done** and **Snooze** (an hour, this evening,
   tomorrow, or next time at this PC). They don't crowd the core: one line each, and "and 3 more" past three.
6. **The Reminders section.** Upcoming, due and done reminders, plus to-dos, with add, edit, tick and delete. After the
   adaptive panels, it opens as a panel next to the conversation (D1). It is also reachable on its own from the rail or
   the More sheet.

## Decisions to settle before building

| #   | Question                                                             | Recommendation                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Where does the Reminders section live?                               | A **Reminders panel** the owner can open in any thread (built on the adaptive panels), plus a plain page in the More sheet for the phone. Not a new rail item.                                                                                                                                     |
| D2  | What counts as "I'm home"?                                           | **The home PC's desktop is unlocked and in use**, not just "the node connected": the home node starts at boot and can be online all day with nobody there. This needs the screen helper to report lock and idle state. Until that exists, fall back to the node coming online after being offline. |
| D3  | Does Jester take reminders too?                                      | **Yes, into the same list**, marked with who took it. A reminder is the owner's, not the identity's.                                                                                                                                                                                               |
| D4  | Repeating reminders ("every Monday")?                                | **Not in the first version.** One-off and to-dos first; repeats are a later field on the same row.                                                                                                                                                                                                 |
| D5  | Can a due reminder start work ("when I get home, start the backup")? | **No.** A reminder only reminds. Starting work is an Objective or a delegation, with its own approvals, so a reminder can never trigger an action nobody confirmed.                                                                                                                                |
| D6  | Is the list kept in the Vault as well?                               | **No, the core only**, so it works with the Vault off. Export to the Vault can come later.                                                                                                                                                                                                         |

## Tasks (outline)

Each task is test-first, red then green, as `AGENTS.md` requires.

- **R1. Contracts.**
  - The `ReminderSchema` (id, text, note, trigger, status `pending | due | done | snoozed`, identity, thread, times),
    the proposal kind `reminder`, and the commands: `reminder.create`, `reminder.update`, `reminder.complete`,
    `reminder.snooze`, `reminder.delete`.
  - Events: `reminder.created.v1`, `reminder.due.v1`, `reminder.done.v1`.
- **R2. Core store and commands.** A migration for `reminders`, then the commands through `runCommand`, and
  `GET /reminders?status=`. Add `reminders` to `API_SEGMENTS`: a missing segment is how `/digest` went blank.
- **R3. Proposals.**
  - `applyProposal` handles `kind: "reminder"` by validating it and calling `reminder.create` as the identity.
  - A time in the past, or a PC that doesn't exist, is refused and logged, never guessed.
- **R4. The tool.**
  - Add `noctis_propose_reminder` to the Noctis MCP servers on every runtime (`claude.ts`, `noctis-mcp.ts` for Codex,
    and Hermes).
  - Add one line to Vesper's identity card on when to use it.
  - Give the card the owner's local time and time zone, so "tomorrow at 9" resolves correctly.
- **R5. Firing.**
  - A scheduler for time triggers that survives a core restart: on start, anything overdue fires once.
  - A node-online listener for PC triggers.
  - Both are deterministic and tested with the movable clock the integration tests already use.
- **R6. Push.** `pushFor` sends `reminder.due.v1` to the phone, worded as the reminder itself.
- **R7. Presence.** Due reminders show with Done and Snooze, and the e2e test covers due, done and snoozed.
- **R8. The section.** The Reminders page and panel: list, quick add, tick, edit and delete. Phone and desktop e2e.
- **R9. The "in use" signal (D2).** The screen helper reports locked or unlocked and idle time to the node, and the
  node passes it to the core. A PC trigger then waits for "unlocked and active" rather than "connected".
- **R10. Evidence.** Add an entry in `IMPLEMENTATION-STATUS.md`, and run the live check from the phone: "remind me
  when I get home to test this" while at work, then confirm it shows on arriving home.

## Already in place to build on

- Proposals and how they become commands: `apps/core/src/conversation/proposals.ts`.
- Push to the phone and the daily schedule: `apps/core/src/notify/` (`push.ts`, `triggers.ts`, `digest.ts`).
- Node online and offline events: `apps/core/src/nodes/registry.ts` (`node.connected.v1`, `node.status_changed.v1`).
- Presence's line under the clock: `apps/web/src/pages/Presence.tsx` (the digest line).
