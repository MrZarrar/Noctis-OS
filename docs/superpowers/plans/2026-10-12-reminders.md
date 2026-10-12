# Reminders, to-dos and scheduled tasks: plan

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
   - **repeating** (D4): "every Monday at 9", "every weekday evening", "every time I'm home". A repeat is the next
     time worked out again after each firing, never a queue of copies, and ticking one off keeps the series.
3. **Confirmation in the thread.** Vesper's reply says what was recorded and when it will fire, for example "I'll
   remind you when zarrarpc is next on: renew the car tax." The thread shows a small card for it with **Undo**, so a
   misheard reminder is one tap to remove.
4. **Firing.** Deterministic core code, never the model:
   - A timer handles time triggers, the same way the daily digest is scheduled (`msUntilNext` in `notify`).
   - The owner's session being unlocked on a PC (D2) handles PC triggers.
   - A due reminder becomes `due`: it is pushed to the phone (`notify/push.ts`), and it shows in Presence until it is
     done or snoozed.
5. **Presence.** Due reminders sit under the greeting, each with **Done** and **Snooze** (an hour, this evening,
   tomorrow, or next time at this PC). They don't crowd the core: one line each, and "and 3 more" past three.
6. **The Reminders section.** Upcoming, due and done reminders, plus to-dos, with add, edit, tick and delete. After the
   adaptive panels, it opens as a panel next to the conversation, and it has its own side menu item (D1).

## Decisions (owner, 12 October 2026)

| #   | Question                               | Decided                                                                                                                                                                                                                                                  |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Where does the Reminders section live? | **Its own item on the side menu, and a panel.** The owner's rule for the adaptive panels: everything is a panel as well as its own page. Reminders, to-dos and notes like them each get a menu item.                                                     |
| D2  | What counts as "I'm home"?             | **The owner's own Windows account is unlocked on the home PC.** Not the node coming online, which happens at boot with nobody there, and not the other Windows user signing in. The screen helper runs in the owner's session, so it is what reports it. |
| D3  | Does Jester take reminders too?        | **Yes, into the same list**, marked with who took it.                                                                                                                                                                                                    |
| D4  | Repeating reminders?                   | **Yes, in the first version** ("every Monday at 9", "every time I'm home").                                                                                                                                                                              |
| D5  | Can something due start work?          | **Yes, as a scheduled task, not a reminder.** A reminder only reminds; a scheduled task runs an agent. Both share the same triggers. See "Scheduled tasks and routines" below.                                                                           |
| D6  | Vault?                                 | **Works with the Vault off.** Reminders and tasks live in the core.                                                                                                                                                                                      |

## Tasks (outline)

Each task is test-first, red then green, as `AGENTS.md` requires.

- **R1. Contracts.**
  - One `TriggerSchema` shared with scheduled tasks: `at` (a time), `repeat` (a small rule: days of the week, a time of
    day, or every N hours), `at_pc` (a PC, once or every time), or none.
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
- **R5. Firing.** One trigger engine in the core, used by reminders and scheduled tasks alike.
  - Time and repeat triggers survive a core restart: on start, a missed one fires once (the most recent, not every
    one missed), and a repeat then moves on to its next time.
  - PC triggers listen for the owner's session being unlocked on that PC (R9).
  - Both are deterministic and tested with the movable clock the integration tests already use.
- **R6. Push.** `pushFor` sends `reminder.due.v1` to the phone, worded as the reminder itself.
- **R7. Presence.** Due reminders show with Done and Snooze, and the e2e test covers due, done and snoozed.
- **R8. The section.** The Reminders side menu item, page and panel: list, quick add, tick, edit and delete. Phone and
  desktop e2e.
- **R9. "The owner is at this PC" (D2).** The screen helper, which runs in the owner's own Windows session, reports
  when that session is unlocked or locked (Windows session-change notifications, not screen capture). The node passes
  it to the core as `node.owner_present.v1`. Another Windows user signing in reports nothing, because their session
  has no helper. On the work PC the node runs in the owner's session already and reports it the same way.
- **R10. Evidence.** Add an entry in `IMPLEMENTATION-STATUS.md`, and run the live check from the phone: "remind me
  when I get home to test this" while at work, then confirm it shows on arriving home.

## Scheduled tasks and routines (D5)

A reminder tells the owner something; a **scheduled task** runs an agent. "When I get home, start the backup" and
"every weekday at 8, summarise my inbox into Presence" are scheduled tasks. They use the same triggers as reminders.

### What Claude and Codex already ship (research, 12 October 2026)

- **Claude Code routines** (`/schedule`, claude.ai):
  - A routine is a prompt, a model, repos and an environment.
  - It runs on a schedule (one hour minimum), from an API call, or on a GitHub event.
  - Runs happen in Anthropic's cloud with **no approvals at all**: safety comes from what the routine is given access
    to.
  - Each run is its own session, with run history, Run now and pause.
- **Claude Desktop local scheduled tasks**:
  - They run on the PC, with a one-minute minimum and a permission mode per task.
  - A run stalls on a permission prompt until someone answers, and "always allow" answers are saved per task.
  - History shows skipped runs and why (asleep, still running). Missed runs get one catch-up, for the latest missed
    time.
- **Codex scheduled tasks** (formerly automations):
  - A task is a prompt, a schedule, a project and a model. Each run happens in a fresh chat or back in the same one,
    locally, with the app open.
  - Unattended, a disallowed action fails rather than prompting.
  - Runs land in a "Scheduled" inbox with unread markers.
- **In-session loops** (`/loop`, the cron tools): tied to one open session and gone when it closes. Noctis's tasks live
  in the core instead, so they survive restarts.

### Noctis's version

- **A task** has:
  - a name and a prompt;
  - the identity (Vesper or Jester), the agent and the model;
  - the PC and shared folder;
  - a trigger;
  - whether each run gets a new thread (the default) or continues the same one;
  - a maximum run time (30 minutes by default).
- **Every run is a Noctis thread**, so it can be opened, read and continued from the phone like any other. Threads lists
  runs under their task.
- **The run log includes what did not run.** It records started, finished, failed, needs you, and skipped with the
  reason: PC offline, owner not present, previous run still going, or paused. "It ran" and "it did what it was asked"
  are shown separately.
- **Controls:** Run now, pause and resume, edit, delete. A one-off task turns itself off after it runs.
- **Rules the core enforces:**
  - runs of the same task never overlap;
  - one task run at a time per PC;
  - one catch-up run for the latest missed time within a day;
  - a task that fails three times in a row pauses itself and says so.
- **Approvals while nobody is watching:**
  - The agent's own auto mode decides the everyday steps, as it does now.
  - A consequential step (push, send, publish) still asks: the phone is notified and the run waits.
  - Answering **Always for this task** saves a standing permission scoped to that task, using the core's existing
    `standing_permissions`. The owner can revoke it.
  - If nobody answers before the approval times out, the run stops as "needs you". Nothing is ever approved by
    default.
- **Creating a task:**
  - The owner can create one on the page, or ask Vesper or Jester.
  - A task an agent proposes is born **paused** and needs the owner to press **Turn on**, the same way an Objective an
    agent proposes is only a suggestion. A model must not be able to start unattended work on its own.
  - Reminders skip that step, because a reminder can't do anything.
- **Results reach Presence.** A run that finishes or needs the owner shows in Presence and as a push, with its first
  line and a link to the thread.

### Tasks (outline, after R1 to R10)

- **S1. Contracts:** `ScheduledTaskSchema`, `TaskRunSchema` (status and skip reason), the commands (`task.create`,
  `task.update`, `task.pause`, `task.resume`, `task.run_now`, `task.delete`), the `task` proposal kind, and events.
- **S2. Core store** and a migration. Each run links to the thread it ran on.
- **S3. Runs:**
  - The trigger engine (R5) enqueues a `conversation.send` pinned to the task's PC, folder and agent, as the identity,
    on a new thread or the same one.
  - The core enforces the overlap, per-PC, catch-up and run-time rules.
- **S4. Unattended approvals:** "Always for this task" on an ask, standing permissions scoped to the task, and "needs
  you" on timeout.
- **S5. Proposals and the tool** (`noctis_propose_task`), with proposed tasks born paused.
- **S6. The page and panel:** its own side menu item (D1), the task list with the run log, and Run now, pause and edit.
- **S7. Presence and push** for runs that finished or need the owner.
- **S8. Evidence**, including a live check: "when I get home, list what changed in the repo today" said while at work.

### Still open

- Whether reminders and scheduled tasks are one side menu item with two tabs, or two items.
- Running each run in its own git worktree, as Claude Desktop and Codex offer. It is useful for code tasks, but it
  leaves folders behind. Recommendation: off by default, with a per-task switch later.
- Triggers from outside (a webhook, a GitHub event): not planned, because the core opens nothing to the internet.

## Already in place to build on

- Proposals and how they become commands: `apps/core/src/conversation/proposals.ts`.
- Push to the phone and the daily schedule: `apps/core/src/notify/` (`push.ts`, `triggers.ts`, `digest.ts`).
- Node online and offline events: `apps/core/src/nodes/registry.ts` (`node.connected.v1`, `node.status_changed.v1`).
- Presence's line under the clock: `apps/web/src/pages/Presence.tsx` (the digest line).
- Standing permissions in the authority model: `standing_permissions` (migration 0001), for "Always for this task".
- Pinned turns on a PC, folder and agent: `conversation.send` with `rootGrantId`, and pinned threads (0011).
- The owner's Windows session on each PC: the screen helper (`apps/node-agent/src/screen/helper.ts`), for R9.
