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

**Decided (owner):** build it.

**Built:** a message sent to a thread whose turn is still working goes into that turn. The core sends the node a
`steer` frame instead of opening a turn. Claude gets it on the CLI's input queue with `priority: "next"`, so the
agent folds it in between tool rounds, and the turn stays open until the CLI says it has answered that message.
Codex gets `turn/steer` on the active turn. The node always replies `steered`. When the turn has ended, the agent
cannot be steered (local models, Hermes), or the message picks another model or folder or brings a file, it runs as
its own turn next, as before. While a turn works, the composer says "Add to what Vesper is doing...".

## 5. Usage limits and the time in Threads

**Decided (owner):** the usage meters are more needed in Threads than on Presence, and Threads shows the time too.

**Built:** above Threads' composer, beside the core: the time and date, and the 5-hour and weekly meters of the agent
the picker is set to (Claude or Codex; none for local agents).

## 6. The four-panel limit

**Asked (owner):** new panels went into "+N more" once four were open. The newest should show and the oldest
should go into the more list. Showing a panel from the more list should ignore the limit, so the owner can open as
many as they want by hand.

**Cause.** Any click or focus on a panel marked it "touched", and touched panels were never tucked. Once the open
four had all been clicked, every new arrival went straight into the more list, and Show refused with "Pin or close
an open panel to make room".

**Built:** the limit tucks the oldest arrivals, whether or not they were used. A panel shown from the more list is
marked shown, stays open past the limit, and keeps that mark across reloads. Pinned panels stay outside the limit
as before. The "touched" mark is gone.

## 7. Approvals Claude Code would not ask for

**Asked (owner):** Noctis asks for approval on simple reads and file writes.

**Found.** The approvals table shows today's asks were nearly all `python -c` reading a JSON fixture, a quoted
heredoc writing a file whose text contained backticks, and `powershell -File scripts\deploy\work-pc.ps1`. The
classifier calls all three "hides what it runs" and makes them external writes. `git push` asks too, by design.

**Open:** a classifier change (treat `python -c` and `node -e` like any script, ignore backticks inside a quoted
heredoc body, let `powershell -File` run like any script) is written as tests but not applied. Claude Code's own
safety check refused to run them because the change loosens Noctis's approval gate, so it waits for the owner.

**Decided (owner, later the same day):** apply it. **Applied:** the classifier change is in
`packages/domain/src/runtime/classify.ts`. Claude Code's safety check again refused to run the classifier tests
in-session, so the owner runs `npx vitest run packages/domain/src/runtime/classify.test.ts` before it is committed.

## 8. LARP options and recall content for the reveal video

Commit 5565490 added an options panel and a recall panel to LARP mode with content nobody had approved.

**Decided (owner):**

- Options panel: keep the mechanical keyboards, the four boards, their prices and reason lines, the title "Mechanical
  keyboards under GBP 200", Vesper's reply and the trigger phrases (find me, shortlist, compare options, pick one for
  me).
- Recall panel: a new fictional subject, Peter Parker. His basic details show, and anything to do with his other
  identity shows as redacted, because a spell made the world forget it (a No Way Home nod). Vesper's reply and the
  trigger phrases stay.
- Product pictures: realistic photos, generated by Codex.

**Built:** four notes in the fixture Vault (`people/peter-parker.md`, `inbox/peter-parker-photo-invoices.md`,
`reference/peter-parker-timeline.md`, `reference/peter-parker-spell.md`), linked to each other. "What do I know about
Peter Parker?" returns all four, and each quote carries a redaction. The keyboard pictures are Codex photos, stored
as JPEG inside an SVG so the files area serves them unchanged. The recording brief (R2 and R7) needs the subject
changed from Mira Tallow to Peter Parker.

## 9. Approval cards a person can read, and Vault links

**Asked (owner):** an approval card showed a whole shell command with an inline Python script as its "Requested
action", with "Some effects may not be undone", for a command that only read files. Cards should outline what the
action does with the code collapsed, and the same goes for other raw text in Noctis, such as links in the Vault.

**Found:** the card asked because of section 7's `python -c` rule. The summary was the raw command, clipped to
2,000 characters. Vault notes are Markdown, which does not know Obsidian's `[[Name]]`, so the brackets showed.

**Decided and built:**

- An ask's headline is what the agent said the command is for: Claude's Bash `description`, or Codex's `reason`.
  When neither exists, a plain outline built from the command (`Runs git show and an inline Python script`).
- The exact command is kept on the approval (`consequenceDetail`, migration 0024) and shown under a collapsed
  "Command" on the card, in Threads and on the Approvals page.
- Command rows in a turn's Details show the description with the command and its output folded away.
- In a Vault note, `[[Name]]` opens that note in the sphere, `[[Name|text]]` shows only the text, and a name with no
  note is plain text. Recall quotes stay verbatim.

**Not done (owner):** no restart of the work PC and no home PC step. The owner is using Noctis and restarts it
themselves.

## 10. Vesper on the agent's own auto mode

**Asked (owner):** Claude's and Codex's auto modes are good at deciding when approval is needed. Vesper should
inherit them and only ask when the agent itself would have asked; Noctis's approval system stays for Jester.

**Found:** Vesper on Claude already ran in Claude Code's auto mode, with Noctis's classifier stopping anything it
called confirm-level before auto mode saw it. Codex already only asked when Codex asked, but Noctis turned its
network off every turn although the owner's `~/.codex` turns it on, so every networked command asked. Jester always
runs on Hermes, which has no auto mode. Codex's own auto-review (`approvals_reviewer = "auto_review"`) would also take
MCP prompts, which is where the browser and desktop checks live, so Noctis leaves the reviewer to the owner's config.

**Decided (owner):** do it, and keep the browser and desktop checks. Recorded as ADR-0037.

**Built:**

- Claude: the gate only stops a browser or desktop step that commits the owner (buy, pay, send, post, opening a
  shell) and a write into a read-only folder. Everything else is Claude's auto mode; its own asks still arrive as
  cards.
- Codex: the network follows the owner's `sandbox_workspace_write.network_access`, read with `config/read` when the
  app-server starts, and stays off when that cannot be read.
- Hermes (Jester and local models): unchanged.
- Vesper's card no longer says every action that leaves the PC needs an approval.

## 11. Still too many asks, sent screenshots, and panel names (26 October)

**Asked (owner):** Noctis still asked too often. A screenshot sent with a prompt could not be seen in the chat. The
panel overflow list called every panel "document" instead of its title.

**Found:**

- The work PC's core and node had run since 23 October 13:53, before ADR-0037 was built, so the old checks were live.
- Every ask that day was Vesper writing song drafts and edits straight into the MindVault, which is lent read-only.
  That check stays after ADR-0037, so a restart alone would not have stopped them.
- Sent attachments reached the core and the agent, but the thread never showed them.
- The overflow list printed the panel's kind. The panel header and the tray already resolved its title.

**Decided (owner):** option B of three: new notes in the MindVault `inbox/` go in without asking; existing notes only
through the Vault tools. Rejected: writes anywhere in the MindVault (no undo through Noctis), and keeping it fully
read-only (drafts would live outside the Vault).

**Built:**

- Claude and Codex add a new file under the MindVault `inbox/` without asking. Vesper's card says so and points to
  `noctis_propose_vault_fact` and `noctis_propose_vault_revision` for existing notes. Local models still ask.
- A turn carries the files sent with it. Threads shows them under the owner's message, and Presence under the latest
  line: images as thumbnails, other files as a link.
- The overflow list names panels by their titles.

**Open:** the owner restarts the work PC core and node to pick this up, and the home PC from its own steps.

## 12. Copy buttons on boxes of text (26 October)

**Asked (owner):** a lyric sheet has its lyrics and its style prompt in separate boxes, and copying either one meant
selecting it by hand. They wanted a copy button like VS Code's.

**Built:** every fenced block in a reply, document panel, file panel or Vault note has a Copy button in its top
corner that copies that block's text and says "Copied" for a moment. Inline code and diagrams have none.

## 13. Why the MindVault inbox still asked (26 October)

**Asked (owner):** after the deploy, Vesper creating `inbox/2026-10-26-the-dreamer-draft-i.md` still asked.

**Found:** the work node's folder grants from 19 October were saved with their backslashes stripped
(`C:Usersmushaf.zarrarOneDriveMindVault`). The node skips a folder that does not exist, so `work-vault` and the five
Neckermann and Anex Tour folders never reached a turn. To Noctis the MindVault was outside every folder, so the inbox
exception could not apply.

**Built:** a new folder grant must name an absolute path, or the core answers 400 and stores nothing.

**Open:** the six grants need sharing again with their real paths. Claude Code's safety check refused to change
grants in-session, so the owner does it.
