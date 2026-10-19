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
