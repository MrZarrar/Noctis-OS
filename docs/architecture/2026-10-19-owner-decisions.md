# Owner decisions and discussion: 19 October 2026

Follows `2026-10-16-owner-decisions.md`. Each item is marked **Decided**, **Built**, **Open** or **Deferred**.

## 1. The agents act on the owner's PCs

**The complaint.** Asked to "open the vault" and "open my github in a new tab", Vesper replied that it had no tool
for either. The Jarvis dashboard's agents did both at once.

**What was actually wrong.** Nothing stopped Vesper. The work node runs in the owner's own session, Claude Code had
PowerShell, and `Start-Process <url>` was not confirm-level. But:

- Vesper's card never said it was on the owner's screen; it spoke only of panels. Jester's soul said it "prepares,
  does not commit" and "never changes anything outside this PC".
- The browser it was lent was a headless Playwright with an empty profile per thread and five allowlisted tools:
  invisible, signed in to nothing, unable to pick from a dropdown or switch tab.
- Every browser call classified `external_write`, so each click would have been an approval card.
- Noctis's own pages (Vault, Files and the rest) could be opened as panels by the owner but not by an agent.

Jarvis had named actions for these (`open_browser`, `navigate`, `open_panel`).

**Decided (owner):**

- Everything is assumed possible. The agents are told a stance, not a list of what they may do: work out how, never
  say "I can't" before trying, and go up to the last step that is the owner's, which is spending money, sending or
  posting as them, signing them up, or deleting what cannot be recovered. Stop there and ask. "Add it to the basket"
  is fine; buying is not.
- From the phone, "open X" opens on the PC. "My PC" means the PC the owner is at; "home" and "work" are the PCs'
  names.
- The agents use the owner's real browser, for its cookies and logins: Chrome at work, Zen at home.
- Jester is Hermes and acts too. Long multi-step PC work is Vesper's: nothing is routed through Jester.
- Desktop apps through Windows-MCP, for Claude, Codex and Jester.

**Built:**

- `ACTING_INSTRUCTIONS` in Vesper's card (Claude and Codex) and Jester's soul. A local model with no tools gets
  none of it.
- The PCs listed beside each message say which one the owner is at now (from the presence the node already
  reports), what "my PC" means, and to hand work to another PC with `noctis_delegate`.
- The browser server (`browser`): Chrome through Playwright's extension when `NOCTIS_BROWSER_EXTENSION_TOKEN` is set
  on the node, Firefox or Zen through Mozilla's `firefox-devtools-mcp` attached to the running browser when
  `NOCTIS_FIREFOX_MCP` names it, else the old headless profile per thread. Every tool is lent except the three that
  run raw code (`browser_evaluate`, `browser_run_code_unsafe`, `evaluate_script`).
- The desktop server (`desktop`): Windows-MCP 0.8.8 from the owner's Python 3.14, without its `PowerShell`,
  `FileSystem`, `Registry` and `Process` tools. The agents' own shell and file tools do those, and Noctis classifies
  those; Windows-MCP's would go round it.
- `classifyAsk` treats a step on `mcp__browser__*` or `mcp__desktop__*` as a local step, run without asking, unless
  the thing it presses is named like buy, place order, checkout, pay, card number, send, submit, post, delete or
  transfer. That is a backstop under the agent's own judgement. Its known ceiling: a desktop click by screen id, or
  an Enter that sends a chat, names nothing, so only the agent's judgement covers it.
- Claude: both servers lent and allowed in the CLI (otherwise its own permission system asks about every click),
  with the PreToolUse gate still in front.
- An agent can open a Noctis page as a panel (`page {page: "Vault"}`), but not the Files page pointed at a folder,
  which stays the owner's choice of grant.
- Windows-MCP is installed on the work PC (per-user Python 3.14.7 from winget, `pip install --user
windows-mcp==0.8.8`; 0.8.8 needs Python 3.14).
- Opening a terminal or the Run box through the desktop server (`App` with powershell, cmd, Terminal and the like, or
  `win+r`) asks: typing into one would be a command no command check saw. A terminal that was already open is not
  caught.
- Codex: both servers lent with `mcp_servers.<name>.default_tools_approval_mode="prompt"`, so Codex raises an
  approval before every step on them, and Noctis answers it by `classifyAsk`. Proven live against Codex 0.163:
  the approval arrives as `mcpServer/elicitation/request` with `_meta.codex_approval_kind: "mcp_tool_call"`, the
  arguments in `_meta.tool_params`, and the tool's name only in the message (`Allow the x MCP server to run tool
"y"?`); `accept`, `decline` and `cancel` all behave. Codex starts MCP servers with 20 standard Windows
  variables only, so the extension token is passed in the server's own `env`. Found on the way: the `noctis_*`
  proposal tools were also being asked about, and Noctis declined every such ask, so Codex's proposals were being
  refused until now.
- Hermes (Jester): Hermes never asks the client before a tool on a server the client lends. A Noctis plugin
  (`noctis-screen`, written into each Hermes home and enabled in its config) makes it ask before every step on
  the browser and desktop servers, with the step's input as the reason, and Noctis answers by `classifyAsk`. Read
  from Hermes 0.21.7's source, not yet run on the home PC. If the plugin failed to load, those steps would run
  without asking, so `HOME-SETUP.md` 6.2 checks it loads.

**Trade-off the owner chose.** A security review of this change flagged that a step on the owner's screen now runs
unless its target is named like a commitment, where it used to ask every time. That is the owner's decision ("assumed
possible", no approval per click). What keeps it bounded: raw-code tools are refused, Windows-MCP's shell, files,
registry and process tools are not lent, opening a terminal asks, buy/send/post/delete-named targets ask, and the
agents are told to stop before any of those. What does not: a click by screen position or an Enter that sends.

**Open:**

- The owner installs the Playwright extension in Chrome at work and sets its token (`work-pc-core.md`, "The agents'
  browser and desktop"). Until then the work PC's agents get the old headless browser.
- Zen at home is unverified: Mozilla's server documents Firefox, not forks, and needs Zen started with
  `--marionette --remote-debugging-port`. Marionette sets `navigator.webdriver`, which some shops treat as a bot.
- The home node runs in session 0 with no desktop (ADR-0036), so nothing it opens would appear on the screen.
  `HOME-SETUP.md` section 6 moves it to the owner's logon session.
- Jester has no `noctis_delegate`, so it says "ask Vesper" for another PC.

## 2. First live tests, and what they showed

**Found (owner's report and the turns' own items):**

- "Open the vault" launched Obsidian through the desktop server. "The vault in Noctis" then waited on Windows-MCP,
  which refuses to act while the owner is moving the mouse or typing and needs about ten seconds of quiet; the agent
  polled it with `sleep 11` for two minutes and clicked the Vault icon in Chrome. It never used the `page` panel.
- "Open health as a panel" looked for vault notes about health.
- Both for one reason: Claude Code shows the model only the names of MCP tools until it searches for one, so the
  page panel's description was never read. Asked for the Approvals panel, it searched first and got it right.
- A question the agent asked (AskUserQuestion) showed only in Threads; Presence showed nothing, so the owner did
  not know it was waiting.
- A panel the agent opened belongs to the chat's thread, and Presence showed only its own panels, so the Approvals
  panel appeared in Threads while the owner was on Presence.
- Vesper said the MindVault "lives on the home PC". It does not: OneDrive keeps the same folder on both PCs, and the
  core on the work PC already reads it for the Vault page, for recall above each message, and for inbox notes. Only
  the home node had it shared with its agents, so at work the agents could not open notes themselves.

**Decided (owner):**

- Share the MindVault with the work PC's agents, read only, and the work repos (Neckermann and Anex Tour).
- Playwriter and dassi are not used. Playwriter's one MCP tool, `execute`, runs whatever JavaScript the agent writes
  with Node's full access, so Noctis cannot see what a step presses and every check is bypassed. dassi is a separate
  paid AI agent in Chrome's side panel with its own models, which Noctis could neither see nor stop. Playwright MCP
  Bridge stays: the owner's real Chrome and logins, one checkable step at a time.
- The owner installed Playwright MCP Bridge and set `NOCTIS_BROWSER_EXTENSION_TOKEN` on the work PC.

**Built:**

- Work node grants: `work-vault` (`OneDrive\MindVault`, read), `neckermann-mobile`, `neckermann-customer`
  (`neckermann-customer copy`), `anex-tour-api`, `anex-tour-mobile`, `anex-main` (`anex-main-original`), all write.
- The agents' standing instructions name Noctis's pages and say "open the vault", "health as a panel" and the like
  mean that page, opened with `noctis_propose_surface` `page`, never by driving Noctis's window; Obsidian only when
  named.
- Presence shows the current chat's panels beside its own, and the agent's questions with their options, with
  "Waiting for your answer" while it waits.

**Kept:** Windows-MCP yields to the owner's own mouse and keyboard. That is its safety, and opening Noctis pages
directly removes the case that hit it.

## 3. Options panels: pick from what the agent found

**Asked (owner):** "find me a usb c cable under 10£ for my macbook and show me the best 3 options to add to my
basket" should end in a panel with the best three, as screenshots, where the owner clicks one to add it.

**Found:** a `list` panel could already carry "Add #1" buttons, but no pictures. Live listings cannot be embedded:
Amazon refuses to be framed, and the app only loads images from itself (`img-src 'self'`). Screenshots saved as files
on the PC can be served like any media panel.

**Decided (owner):** agents may supply links. The owner must be able to see the full address before opening one, on
hover at least.

**Built:**

- Surface kind `options`: a title and 1 to 8 options, each with a title, price, detail, a screenshot, an `http(s)`
  link and its own choice (a message back to the conversation). The agent names each screenshot by path; the core
  resolves it to the shared folder holding it and drops a picture from anywhere else, keeping the option.
- Screenshots go in `noctis-show/.shots/` in the working folder. Files in a hidden folder inside the show folder
  never open as panels of their own; the folder is already git-ignored with the rest of `noctis-show/`. Checked live
  that Playwright MCP may save there.
- The agents are told to use one options panel when the owner is choosing between things they found, with a
  progress panel while they search, and to wait for the pick.
- The card renderer was handed to Codex (`docs/handoffs/2026-10-19-options-panel-renderer.md`): the host is always
  visible, the full address on hover, focus and in the accessible name, opened in a new tab.

## 4. Claude and Codex usage limits on Presence

**Asked (owner):** see the 5-hour and weekly usage for Claude and Codex, and when each resets. Not calculated from
tokens or anything else Noctis counts.

**Found:** both providers report it directly, and neither read spends any allowance. Claude: the endpoint Claude
Code's own `/usage` reads, with Claude Code's sign-in (`five_hour`, `seven_day`). Codex: `account/rateLimits/read`
on `codex app-server` (300-minute and 10080-minute windows). Probed live on the owner's PC first.

**Decided (owner):** on Presence, not a page of its own.

**Built:**

- Node capability `usage.limits`, covered by the `runtime.turn` grant. The PC asks each provider and passes on
  exactly what it says. Claude's sign-in file is only read, never refreshed, so Noctis cannot sign Claude Code out.
  A lapsed sign-in says "open Claude Code once" instead of showing anything.
- `GET /limits` on the core asks both providers at once, and one failing leaves the other standing.
- Presence: a quiet two-row block left of the clock (under it on a phone). Each window has a bar, the percent, and
  a countdown, or the weekday and time when the reset is a day or more away. Amber from 80%, red from 95%. It reads
  every five minutes, since each read is a job on the PC.

**Caveat:** Claude's usage endpoint is not a published API. If Anthropic changes it, Presence shows Claude as
unavailable rather than a guess.

**Process (owner):** Claude does design and frontend work. Codex takes non-visual slices and image or mockup
generation. Codex built the core endpoint here; the Presence card was taken back from Codex part-way through.

## 5. Writing without AI tells

**Asked (owner):** Vesper uses a lot of em dashes though Claude and Codex are set never to. The same for other giveaways:
the eyebrow label, "it's not this, it's this", and the rest.

**Found:** the only em-dash rule in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` was for commit messages, and
Noctis loads both files as they are. A "never" rule in the Claude or ChatGPT apps' own settings does not reach Claude
Code, Codex or Noctis. Vesper's 126 replies so far: 19 em dashes per thousand words (AI text in general about 1.7,
people about 0.2), curly quotes at 8, arrows and "honestly/genuinely/actually/really" at 2.8 each, bold-first bullets
at 2. The list of tells came from Wikipedia's "Signs of AI writing" and tropes.fyi.

**Decided (owner):** the rules go in both global files and in Noctis's own instructions, so they hold on every runtime,
including the local model and Hermes, which read neither file.

**Built:**

- A "Writing style" section in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` on the work PC. The home PC gets the
  same block from `docs/operations/HOME-SETUP.md`, step 7.
- `WRITING_INSTRUCTIONS` in Vesper's card on every runtime and in Jester's soul. It names the tells without using any
  of the characters it bans, so it does not show the model what it forbids.
- The usage card's labels are now "Claude" and "Codex" in sentence case, not uppercase and letter-spaced.
- `/limits` asks the next PC running a provider when the first cannot answer, so the home PC on an older build does not
  leave Claude or Codex showing as unavailable.

## 6. DESTROY is enough

**Asked (owner):** a typed confirmation for an agent's `rm -rf` of its own temp folder asked for the whole shell command
to be typed back, and was clipped part way through it at that. "DESTROY" should have been sufficient.

**Decided (owner):** a destructive operation asks for `DESTROY` alone, case-sensitive. The card still shows the full
target above the box, which is what the phrase was making the owner re-read. Spend, deploy and credential phrases are
unchanged. An approval already waiting keeps the phrase it was issued with.
