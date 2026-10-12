# Owner decisions and discussion: 12 October 2026

This records the owner's discussion on 12 October 2026, following on from `2026-10-09-owner-decisions.md`. Each item is
marked **Decided**, **Built**, **Open** or **Deferred**.

## 1. Where a Noctis session runs, and whose CLAUDE.md it reads

**Built (explained):**

- A Claude or Codex turn runs on the PC that holds a `runtime.turn` grant, with the working folder set to one granted
  root. The composer's **PC and folder** picker chooses it. Left on **Wherever Noctis chooses**, the core takes the
  chosen PC's first writable root. On the work PC that is `work-noctis` (`Documents\Noctis-OS`); `work-documents` and
  `work-downloads` are granted as well.
- The Claude route loads user, project and local settings, so the session gets `~/.claude/CLAUDE.md`, the folder's own
  `CLAUDE.md`/`AGENTS.md`, its `.claude/` settings, skills, plugins, hooks and MCP servers, as VS Code would. Codex reads
  the folder's `AGENTS.md` the same way.
- Neckermann (`Documents\neckermann-mobile`, `Documents\neckermann-customer copy`) has no grant of its own. Picking
  `work-documents` starts the session in `Documents`, so Neckermann's `CLAUDE.md` and project settings would not load as
  the starting context.

**Open:** grant each project folder the owner works in (Neckermann first) as its own write root, so it appears in the
picker. Granting is the owner's call. There is no UI for `runtime.turn` grants yet (Nodes only grants `screen.view`);
today it is the `node.grant_capability` request in `docs/operations/nodes.md`. A folder picker on Nodes is proposed.

## 2. VS Code, the Codex app and Remote Control

**Built (explained):** Noctis and VS Code share Claude Code's session store, which is keyed by folder. A Noctis thread
can adopt a session started in VS Code or the Codex app in a granted folder (Conversations, "Before Noctis"). The first
Noctis turn continues it in a fork, so a session still open in VS Code is not written to twice. The other way round, a
session Noctis started can be opened in VS Code with `claude --resume <id>` from that folder; it should not be driven
from both sides at once.

**Is forking wasteful? (owner's question)** Not in context: a fork sends the same history VS Code would send to
continue, and a compacted session stays compacted. Pasted images are stored in the transcript and carry over. The
costs are elsewhere:

- The first Noctis turn misses the prompt cache, because Noctis's system prompt and tools differ from VS Code's, so the
  whole history counts as fresh input once. A session idle for over an hour has lost its cache anyway.
- VS Code's own context does not come across: the open file, the selection, IDE diagnostics, and any `--add-dir` or
  `--mcp-config` the session was started with.
- The two copies then diverge.

**Open: a live bridge instead of a copy.** Research on 12 October 2026:

- **Claude Code hooks** fire in the VS Code extension. `http` hooks can POST `session_id`, `transcript_path`, `cwd`
  and the prompt or tool call to the core. A `PermissionRequest` hook can wait for an answer (600s default) and return
  allow or deny. No answer gives VS Code's own prompt.
- **Claude Code mods** run their hooks in the VS Code chat panel but draw nothing there, so they add nothing over plain
  hooks for VS Code. Channels, the only way to push a message into a running session, are CLI-only and set at launch.
- **Codex hooks** exist (`~/.codex/hooks.json`), with the same events including `PermissionRequest`. They are
  command-only, so a small script posts to the core. They must be trusted with `/hooks`, and they fire in the VS Code
  extension (seen in local rollouts). The desktop app is unverified. `notify` is already used by the desktop app's
  computer-use helper and must not be replaced.
- **Remote Control** (Claude) and **Codex Remote** already continue a session from the phone. Neither has a
  third-party API.
- **Proposed shape:** user-level hooks for both agents report each session's start, prompts, turn ends and end to the
  core, so Noctis lists live VS Code and Codex sessions and mirrors them read-only from their transcripts. A
  `PermissionRequest` hook asks the owner in Noctis and falls back to the native prompt on timeout. It is off by
  default, never approves on its own, and authenticates to the core.

## 3. Vesper's identity does not survive on old sessions

**Finding:** the owner asked a Vesper thread on Claude "what's your name" and got "I'm Claude ... Sonnet 5". The thread
was Vesper's, the node was running the build with the identity card, and the turn ran on `claude-haiku-5-5`.

Reproduced through the Agent SDK with the node's own options:

| Session                                                   | Card sent as `systemPrompt.append` | Answer      |
| --------------------------------------------------------- | ---------------------------------- | ----------- |
| New session                                               | yes                                | Vesper      |
| Born with the card, then resumed                          | yes                                | Vesper      |
| Born without the card, then resumed                       | yes                                | Claude (x2) |
| Born without the card, resumed, card in the first message | n/a                                | Vesper      |

So the card works only on sessions that started with it. Every thread whose session predates the card (9 October), and
every adopted VS Code session, stays plain Claude. The wrong model name came from the old session's history, which still
says "You are powered by Sonnet 5".

**Not recommended (owner to confirm):** putting Vesper in the global `CLAUDE.md`/`AGENTS.md` behind a "noctis" prefix on every prompt. It
loads in every VS Code session too, it puts the prefix in every message and session title, and it depends on the model
choosing to obey a condition.

**Open (proposed fix):** when the node opens a CLI on a resumed session, send the card as a separate text block in that
first message, beside the owner's prompt. It goes once per process, not per turn, and the history reader already drops
reminder blocks, so the owner's prompt is unchanged in the transcript. Jester is unaffected: its identity is a Hermes
`SOUL.md`.

## 4. A new chat from Presence

**Built:** Presence talks on the identity's one free-chat thread, which had grown old. **New chat** under the Presence
composer (`conversation.start_fresh`) turns the current free thread into an ordinary conversation on the list, with its
history and agent sessions, and the next message starts a new free thread on new agent sessions. So it also gives
Vesper back its identity card. It is hidden while a turn runs.
