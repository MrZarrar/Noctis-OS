# Owner decisions and discussion: 9 October 2026

This records the owner's discussions on 9 October 2026 and what was decided, so none of it is lost between
sessions. It is the companion to `docs/superpowers/plans/2026-10-09-owner-list.md`, which has the plan.
`docs/acceptance/IMPLEMENTATION-STATUS.md` has the evidence for what was built.

Each item is marked **Decided**, **Built**, **Open** (still being discussed) or **Deferred**.

## 1. What was built today

At the time of the initial write-up, all of this was on `origin/main` and none of it was deployed yet:

| Commit    | What it did                                                                |
| --------- | -------------------------------------------------------------------------- |
| `8c3ad03` | The page shell                                                             |
| `ebe94e1` | Back navigation                                                            |
| `7292e42` | The glass Picker                                                           |
| `2292e05` | The clock, outputs on Presence, and pasting screenshots                    |
| `cecda00` | Previewing attachments                                                     |
| `af5a680` | Picker polish                                                              |
| `772717f` | The Vault: generated notes skipped, the agent brain kept out of the sphere |
| `1bd0ba7` | Identity cards                                                             |
| `1ee1aa0` | The companion core                                                         |
| `a2c8976` | Fixes for dead back presses, plus review minors                            |
| `b0a0c0b` | The screen mirror                                                          |
| `b105eb3` | Hermes remembers and learns again                                          |

The status log has the detail.

**Initial deployment instructions.** Run `scripts/deploy/work-pc.ps1` (core first), restart the nodes, reindex the
Vault, and allow mirroring on each PC under Nodes → Mirror.

### Latest owner report and outstanding work

The handoff reports that the work-PC core was deployed and the node restarted. The owner confirmed that mirroring
works, Vault reindexing removed the junk, and Haiku 5.5 appears in the model picker. These are handoff/owner reports;
the live services have not been checked again during this discussion.

- **Mirror, requested:** add a monitor switch and make the view large enough to use clearly on a phone. The current
  UI has a browser Fullscreen button only when `document.fullscreenEnabled` is true, but no monitor picker. A view
  that fills the app when browser fullscreen is unavailable remains proposed, not implemented.
- **Vault, unresolved:** the owner still finds it cluttered and visually worse than the Jarvis dashboard. The supplied
  screenshot shows overlapping bright clusters. Compare spacing, node sizes and glow with the read-only donor before
  choosing a fix. Removing junk has not settled this separate visual issue; no further Vault changes were made.
- **Haiku 5.5, intended role:** the owner wants to use it for adaptive-panel proposals and desktop work through
  Windows-MCP. Current code offers `claude-haiku-5-5`; that does not itself enable desktop control or adaptive panels.
  Models propose validated intent; deterministic code retains authority, state transitions, layout and placement.
- **Panel cost, proposed:** displaying, navigating or laying out existing panels should run in deterministic code.
  Model calls should serve new tasks or meaningful semantic decisions rather than every UI update. This is a design
  recommendation, not a verified measurement or an implemented change.
- **Work authorised now:** document the discussion, then commit and push the pending changes in this Noctis checkout.
  No implementation, deployment, plugin installation or quota-consuming tests have been requested.

The graphify code graph (8,812 files) was moved out of MindVault to
`C:\Users\mushaf.zarrar\Documents\MindVault-archive\jarvis-dashboard\codegraph`, with the owner's approval.

## 2. How work is split between Claude and Codex

**Decided.** Both subscriptions are used together, to spread usage and move faster:

- Claude takes one or two tasks and Codex takes one or two at a time. Neither should sit idle waiting for the other.
- Codex is run with the codex binary bundled in the VS Code extension. The CLI on `PATH` is older and cannot use the
  configured model.
- Running three heavy Codex jobs at once exhausted the ChatGPT allowance in about 30 minutes.
- Commit and push as work goes along, always, without asking. That is a standing yes for this repo (confirmed by the
  owner again on 9 October). Asking before consequential actions is a safeguard for Noctis's own agents (§7), not
  for development of this repository.

## 3. eBay listing

**Paused for discussion.** Partial work is uncommitted in the worktree `../Noctis-OS-ebay`, on branch `ebay-listing`.

**Where eBay access would live.** The owner does not want personal access on the work PC if avoidable.

| Option                    | eBay keys live on                      | Noctis code                                  |
| ------------------------- | -------------------------------------- | -------------------------------------------- |
| A. In the core            | The core's machine (the work PC today) | Calls eBay after approval                    |
| B. A home-node capability | The home PC only, DPAPI-encrypted      | The core asks the home node to publish       |
| C. Agent only             | The home PC, inside an eBay MCP server | Little or none; agents list, Noctis approves |

**Other platforms.** Vinted, Depop and the rest will be done by Hermes as an agent, not by Noctis adapter code.

**A developer account.** It is free, at developer.ebay.com, separate from the normal eBay account (the same email works):

1. Create an app keyset.
2. Choose the account-deletion opt-out.
3. Set up a RuName for sign-in.
4. Create the payment, postage and returns business policies in Seller Hub.

The normal seller account is the one used to grant Noctis access.

**Still open:**

- option A, B or C;
- pricing: the API gives live asking prices, not sold prices;
- whether the draft lives on its own page or as an adaptive panel.

## 4. Adaptive panels and the Tauri shell

**Decided:** defer reviving Tauri. Implement adaptive panels in the web app next, after the deploy.

**What exists for panels:**

- the deterministic compositor (`packages/domain/src/compositor`);
- surface intents in the core;
- 11 of the 15 surface kinds;
- the Workbench, which is reachable only through the Command page behind `VITE_NOCTIS_ALL_PAGES`, still in its old look.

The plan is in `docs/superpowers/plans/2026-10-09-adaptive-panels.md`.

### Adaptive-panel discussion continued

**Reference direction.** The owner asked to ground the discussion in the Vinted and trainers mockups in
`docs/Mockups`, rather than a generic daily-plan example. All four stages of each journey were reviewed:

- Trainers: define requirements, explore candidates, inspect one shoe, then decide from a shortlist.
- Vinted: show photos, shape a listing draft, continue in the real Vinted form, then show the listing reference/status.

These references show the workspace changing with the task: the current work gets the main area, relevant supporting
information appears alongside it, and Vesper's position and size adapt. Interactive drafts, comparisons and evidence
views need discussion beyond the existing media and read-only document proposal.

**Decided: replace revised result sets together.** Keep the current candidates visible with an "Updating..." indicator
while replacements are prepared. Replace the whole set once it is ready, rather than changing candidates as partial
results arrive. The owner prefers this to frequent live updates.

**Decided: preserve the view the owner is using.** If revised recommendations become ready while the owner is
inspecting a shoe, keep that shoe open until the owner navigates back. Show "Updated recommendations ready" without
taking over the screen. The same principle applies to an open listing draft or photo.

**Open.** Failure/retry behaviour, independent updates to supporting panels, interactive panel capabilities, and phone
layouts remain proposals to discuss. The six decisions in the existing implementation plan have not been accepted as
a group. These design decisions alone do not authorise implementation, deployment, commits or pushes.

**What Tauri would add.** It only adds things native code can do on the PC the owner is sitting at:

- arranging real windows such as VS Code, the emulator and a browser on the monitors (`crates/noctis-windows`);
- a core floating over native apps;
- a global hotkey and a tray icon.

It adds nothing on the phone or remotely.

**What reviving it would cost:**

- an HTTPS client in Rust;
- an installer and signing, for Smart App Control;
- the Rust toolchain on the work PC.

**Windows-MCP instead of Tauri (Open, leaning to drop the Tauri revival).** Windows-MCP gives agents the window and
app control Tauri's native shell was for. To keep "deterministic code owns physical window placement", layouts go
through a Noctis tool that the node executes with the existing placement code (`crates/noctis-windows`) or a
PowerShell helper, while ad-hoc app tasks ("open Teams, say hi to Tolga") go through Windows-MCP. No Tauri shell is
needed for either. Only an always-on-top floating core, a global hotkey and a tray remain Tauri-only. Model: Haiku 4.5
(the current small model) can do simple desktop steps; Sonnet for long multi-step work; Noctis's Claude probe offers
only Sonnet and Opus today, so adding Haiku is a small change. Desktop actions that send something must never be
classed as a local edit (same fix as Hermes computer use).

## 5. Connectors and skills for the agents

**Decided:** the owner considers the researched set mostly good. Nothing is installed yet.

**Principle.** Connectors belong to the agents on a node, as MCP servers or skills, not in the core:

- Noctis's Claude loads the owner's own Claude Code setup on that PC.
- Codex reads `~/.codex/config.toml`.
- Hermes needs them added to the home Noctis manages.
- Skills use one `SKILL.md` format across all three. Hermes installs from Anthropic's and OpenAI's skill repos with
  `hermes skills install`.

**The starter set, by value:**

| #   | Tool                           | Purpose                                                   | Notes                                                                                       |
| --- | ------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | Windows-MCP (CursorTouch)      | Drive desktop apps, e.g. "open Teams and say hi to Tolga" | Full system access. Needs the owner's desktop session. Turn telemetry off                   |
| 2   | Playwright MCP                 | Browser research and forms                                | Noctis's Claude has it with 5 tools. Extend it to Codex and Hermes, with a separate profile |
| 3   | google_workspace_mcp           | Gmail and Calendar: job tracking, outreach drafts         | Own Google OAuth client. Start read and draft only                                          |
| 4   | ms-365-mcp-server              | Outlook                                                   | Own Entra app. The work tenant may block it                                                 |
| 5   | yt-dlp + Jina Reader           | Video metadata, transcripts, pages as markdown            | No accounts                                                                                 |
| 6   | A YouTube Data + Analytics MCP | Own channel analytics                                     | Audit it before giving it a token                                                           |
| 7   | PRAW                           | Reddit research within Reddit's rules                     | Free script credential                                                                      |

**Researched and not recommended as defaults:**

- **Agent Reach.** It routes to cookie-based X and Reddit tools with ban risk. Its own README says to use throwaway
  accounts.
- **Crawlee.** A scraping library for sites that block Playwright. Agents write scripts with it.
- **Apify's hosted actors and Firecrawl cloud.** Both are metered.

**Platform limits.**

- **LinkedIn** has no usable API for messages or applications, and automating it breaks its terms.
- **TikTok** has no free analytics API, so use a TikTok Studio CSV export.
- **Reddit and Facebook** are fine to read for research. Automated outreach is treated as spam.
- **Recruiter emails** can be personalised, throttled, and sent as an approved batch of drafts.

## 6. Hermes: keep it powerful

**Built (`b105eb3`).** Hermes's native memory, user profile, `session_search` and background learning review are back
on for Vesper's and Jester's homes, each with separate memories. Only cron stays off, until scheduling runs through
Noctis. It takes effect when the home node restarts. The background review adds LM Studio load.

**The audit** (Hermes v0.21.6, MIT licence; a port is not needed) found:

- Noctis's replacements were weaker or missing. The agent brain is written to and never read back. Vault recall
  matches the whole prompt.
- Skill creation was never removed.
- Scheduling and computer use are lost today.

**Open: computer use.** Enabling it needs four things:

1. `hermes computer-use install` on the home PC.
2. The `computer_use` toolset added to Noctis's generated ACP config.
3. Running in the owner's desktop session.
4. **A classification fix first.** Hermes reports desktop actions as shell commands, and Noctis could class an
   unrecognised one as a local edit, which an active Objective can auto-allow. A desktop action that sends a message
   must never be auto-allowed.

Jester's soul also forbids sending, and it would need changing for approved sends.

**Follow-ups:**

- Bridge Hermes memory with the Vault: read the agent brain back, and give the agents a Noctis recall tool.
- Route Hermes scheduling through Noctis.

### Subscription-backed Hermes: research on 9 October 2026

**Open; researched, not enabled.** The owner initially asked about using existing ChatGPT/Codex or Claude subscriptions
inside Hermes, the new Claude subscription plugin, and reports of headless Claude consuming quota at three times the
rate. The owner then clarified that subscription-backed Hermes is not planned now; the concern is Claude quota
consumption through Noctis itself.

- **ChatGPT/Codex as Hermes's model provider:** Hermes documents a "ChatGPT or Codex Subscription" OAuth option.
  Hermes retains its own agent loop. Its provider guide does not establish exact plan eligibility or quota weighting.
  OpenAI documents subscription sign-in for Codex and a ChatGPT-plan app-server integration.
- **Codex app-server inside Hermes:** an optional beta hands execution to Codex. The documented limitations include
  unavailable in-turn `delegate_task`, `memory`, `session_search` and `todo` tools. Background memory/skill reviews
  remain supported through Hermes's own loop. It needs evaluation against the owner's desired Hermes capabilities.
- **Claude Subscription DirectSDK:** NousResearch's experimental plugin was added on 20 September and its catalog was
  updated on 7 October. It uses the official Claude Code CLI with Pro/Max subscription login, preserving Hermes's
  tools, approvals and compaction. Despite the name, it uses stream-json rather than the Python Agent SDK package.
  It requires Hermes 0.21.4 or newer; its documented Haiku 5.5 CLI minimum is 2.1.293. This is distinct from Hermes's
  direct Anthropic OAuth provider, which its provider guide describes as requiring Max plus purchased extra usage.
- **The three-times claim:** the original first-person report compares six runs of one coding task on one Pro account
  using Opus 5. Headless runs consumed about 5.2 percentage points of the five-hour allowance per dollar of
  API-equivalent usage, versus about 1.7 interactively. This is a reported measurement, not a confirmed universal
  multiplier. It does not establish the same rate for Haiku 5.5, Max plans, weekly limits, or perfect cache hits.
  Anthropic's current subscription/SDK notice permits subscription usage but does not specify a three-times rate.
- **Noctis exposure:** the current Claude runtime calls the Agent SDK's `query()` and keeps a process per thread.
  It is therefore in the headless SDK category; persistent processes do not establish exemption from provider quota
  weighting. Noctis's reported usage retains input/output token counts, not cache reads/writes or the subscription
  allowance delta, so those records alone cannot validate the claim. API-key authentication is refused.
- **Noctis's Hermes integration:** `hermesConfig()` currently writes `provider: lmstudio` before process startup, and
  the probe exposes only local models. Installing a plugin or manually editing that generated config would not
  complete subscription integration. Provider selection, authentication, approvals, cancellation and auxiliary-model
  routing need explicit integration and verification before changing the live route.
- **Separate API credits:** Anthropic's 7 October notice adds monthly API credits for Max/Team. With Console API-key
  authentication these are separate from subscription limits; subscription login still consumes plan limits.
  Purchased credits or auto-reload can continue paid usage after the included balance runs out. Noctis currently
  refuses API-key authentication, so this is a separate option requiring approval and integration, not an automatic
  benefit of its existing Claude route.

**Conflicting community observations.** The owner shared a report that both native Hermes Claude Pro OAuth and the
official experimental plugin worked without API keys or extra credits, with no noticeable difference in quota use.
That report attributes the practical difference to configurable native cache TTL versus the plugin's fixed one-hour
TTL. This is a report shared by the owner, not a test performed in Noctis. It conflicts with the native-provider credit
requirements described in Hermes's guide. Neither it nor the earlier six-run report establishes a universal quota
multiplier.

**Noctis follow-up, not yet implemented or run.** Keep the existing official Claude SDK route while measuring actual
allowance consumption. The installed SDK 0.3.270 declares an experimental structured usage method returning plan
utilization percentages and reset times when available; Noctis does not currently call it. Record before/after
five-hour and weekly usage, model/effort, cache reads/writes and outputs for comparable interactive and Noctis tasks,
with no other account activity. Account-wide utilization cannot attribute simultaneous sessions to one turn, and SDK
dollar estimates are not authoritative subscription-quota measurements.

Anthropic's cost-tracking guide documents a one-hour cache default for subscription-backed main turns within included
usage. Actual Noctis cache hits and effective TTL remain unmeasured; changing a cache setting does not prove that a
quota multiplier has been removed. The current SDK help notice permits subscription-backed usage, while the SDK
developer overview separately restricts third-party products offering subscription login unless approved. The scope
of that product-distribution restriction should not be inferred from community quota tests.

Research involved reading sources and code and documenting the findings. No model calls, plugin installation,
authentication changes or deployment were performed. Documentation publication was authorised separately.

**Sources checked:**

- [Hermes model providers](https://hermes-agent.nousresearch.com/docs/integrations/providers/)
- [Hermes Codex app-server runtime](https://hermes-agent.nousresearch.com/docs/user-guide/features/codex-app-server-runtime)
- [Claude Subscription DirectSDK catalog](https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk)
- [DirectSDK source and qualification notes](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk)
- [Original headless-quota measurement report](https://www.reddit.com/r/ClaudeAI/comments/1wsijnv/measured_it_headless_claude_code_agent_sdk_claude/)
- [Anthropic subscription/SDK notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Anthropic monthly API credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)
- [Anthropic SDK usage accounting and cache TTL](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- [Anthropic SDK overview and product-authentication restriction](https://code.claude.com/docs/en/agent-sdk/overview)
- [OpenAI subscription authentication](https://learn.chatgpt.com/docs/auth)
- [OpenAI ChatGPT-plan app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

## 7. Safeguards for agents

**Open; nothing is built yet, by the owner's choice.** The owner wants Hermes powerful and rejected:

- **A separate Windows user.** It can't drive the owner's desktop, for example Teams, without switching sessions.
- **Per-turn limits and an away mode.** Both work against an agent being useful.

**Under discussion,** none of which costs capability:

- **Checkpoints before each turn:** git snapshots, or OneDrive and File History versions, so anything can be undone.
- **What the owner asked for counts as approved:** "say hi to Tolga" doesn't need a second approval, but an action the
  owner did not ask for that leaves the PC still asks.
- **A daily digest** of what the agents did. **Decided: yes.**

## 8. Stop-everything, evicting a PC, and passcodes

**Decided, to be built after the deploy.**

- **Stop everything.** It cancels every job on every node, kills the agent processes, and suspends agent grants until
  they are re-enabled. It is behind a passcode.
- **Evict a PC.** One action revokes its node credential and grants. Also behind the passcode.
- **`evict-work-pc.ps1`.** Run on the PC itself, it:
  - stops the node and core;
  - exports the database and keys;
  - removes the `NOCTIS_*` variables, `%LOCALAPPDATA%\Noctis`, the Codex rules and the scheduled tasks;
  - unlinks MindVault;
  - logs out of Tailscale.
- **A passcode for "sensitive" Vault notes.** Port it from the Jarvis donor. The donor is read-only; read it from
  `github.com/MrZarrar/Jarvis-Sub-Agent-Dashboard` or the home PC copy, and record it in `DONOR-PORT-LEDGER.md` before
  copying.

## 9. Where the core runs, the Pi, and waking the home PC

**Decided:** the work PC stays the core for now, because it is always on and has MindVault through OneDrive, so quick
Vault questions are fast.

**Pi notes, if the core ever moves off the work PC:**

- A Pi 5 (about £60–80, with an SSD) could run the core plus a Claude and Codex node on Linux. Models run in the cloud,
  so chat is not slower.
- It would keep its own MindVault copy with `rclone`, which syncs OneDrive (no official Linux client), so Vault
  questions don't need the home PC.
- A Pi Zero 2 W (about £20) is only big enough to send wake packets.

**Wake-on-LAN** stays deferred until the owner is home. The owner is considering the £20 Pi as the LAN wake sender.

**Waking and signing in, with two Windows users on the home PC:**

- **No sign-in needed for node work.** The node starts at boot as a scheduled task for one account (`mmush`) without a
  sign-in. That covers Claude, Codex, Hermes, the local model and Files, whichever user is on screen.
- **A desktop session is needed** for the screen mirror, computer use and anything with a window.
  - Waking from sleep returns to the existing session, but **locked**.
  - Waking from shutdown signs nobody in.
- **Options to get a usable desktop:**
  1. Don't require sign-in after sleep. The physical-access trade-off.
  2. Sysinternals Autologon for one chosen user, for shutdown. The same trade-off.
  3. Sign in through Noctis's remote desktop, then move the session to the console with `tscon`, which Noctis could
     automate. This keeps sign-in strong.

## 10. Small items

- **The PWA zoom fix. Decided, queued:** 16px inputs, `touch-action: manipulation`, viewport `maximum-scale=1`.
- **The daily digest. Decided.**
- **Final review before the deploy.**
  - The Codex final review found two mirror blockers: a grant or session expiring mid-stream, and cancelling during
    helper startup. Both are fixed and land with the deploy.
  - Should-fix items being handled: identity model ids sanitised, stale mirror diagnostics, and a long mirror exhausting
    the node's frame budget.
