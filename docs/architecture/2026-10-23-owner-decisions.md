# Owner decisions and discussion: 23 October 2026

Follows `2026-10-19-owner-decisions.md`. Each item is marked **Decided**, **Built**, **Open** or **Deferred**.

## 1. Continue a session: what it does

The owner continued a VS Code Claude Code session (started on Opus) from Threads and it ran on Sonnet with no way
to change it.

**How it works.** Continue a session makes a conversation pinned to that PC, folder and agent. Its first turn
resumes the VS Code session with `forkSession: true`, so the work happens in a copy and VS Code's file is never
written to. Later turns resume the copy. The two then diverge.

**Why Sonnet.** The composer hid the agent picker on a pinned thread and sent no model. The core picked the
thread's last model, else Vesper's Settings default if it was a Claude model (Sonnet), else the first Claude model.
Nothing reads which model the original session used. Noctis offers the `opus` alias, not `claude-opus-5-5[1m]`, so
a continued session may not get the 1M context window.

**Owner's workaround (used):** a fresh conversation on Opus with a handoff file written by the continued thread.

**Built:** a pinned thread shows the model picker, limited to its own agent's models. The folder stays fixed.

## 2. The picker must stick

The owner picked Opus and Noctis-OS on home in a new conversation; a later turn ran on Sonnet and "wherever".

**Cause.** The picks lived only in the composer's on-screen state, which reset whenever the composer remounted
(opening the Conversations list, leaving Threads, reloading, another device). With nothing sent, the core used the
Settings default and its own folder choice. The composer also sent no model when the pick equalled the default, and
a pick made in one conversation carried into the next.

**Decided (owner):** the picker always works mid-conversation, and a pick holds until the owner changes it.

**Built:**

- The core runs a message that names no model on the conversation's last model. Only a first turn uses the default.
- Each turn records its folder (migration `0023_turn_folders.sql`).
- The composer shows the conversation's last model and folder, sends exactly what it shows, and loads each
  conversation's own when another is opened. "Wherever Noctis chooses" is offered only before a conversation's
  first turn.

## 3. Changing folder mid-conversation

Claude Code files a session under the folder it ran in, so a turn in another folder cannot resume it.

**Decided (owner): option (a).** Changing folder starts a fresh agent session, and the conversation says so.
Locking the folder after the first turn was the alternative.

**Built:** sessions record their folder. A turn in a different folder starts fresh and adds a system line: "This
message runs in a different folder, so the agent starts a fresh session there, without the earlier conversation."
Going back to the first folder also starts fresh, because one session is kept per agent and PC.

## 4. Steering a running turn

**Asked:** does a message sent while a turn runs reach the agent mid-turn, as in VS Code?

**Answer: no.** Each message is its own turn and job. The node runs one turn per thread at a time, so a second
message waits until the first finishes (the "Waiting to start" card). Both agents could support it: the Claude
runtime already feeds the CLI through a streaming input queue that a mid-turn message could join, and Codex's
app-server has a steer call for a running turn.

**Open:** whether to build steering.

## 5. Usage limits and the time in Threads

**Decided (owner):** the usage meters are more needed in Threads than on Presence, and Threads shows the time too.

**Built:** above Threads' composer, beside the core: the time and date, and the 5-hour and weekly meters of the agent
the picker is set to (Claude or Codex; none for local agents).
