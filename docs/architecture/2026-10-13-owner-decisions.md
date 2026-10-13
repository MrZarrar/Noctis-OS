# Owner decisions and discussion: 13 October 2026

Follows section 5 of `2026-10-09-owner-decisions.md` (connectors and skills for the agents). Each item is marked
**Decided**, **Built**, **Open** or **Deferred**.

## 1. Connectors installed on the home PC

**Decided:** Gmail and YouTube run on servers we host, with our own OAuth apps. Composio is not used. No paid social
posting connector (Blotato) until there is a real posting workflow.

**Built (outside the repo, in each agent's own config):**

| Connector                         | Claude | Codex | Hermes (default home) | Notes                                                                                   |
| --------------------------------- | ------ | ----- | --------------------- | --------------------------------------------------------------------------------------- |
| REA MCP + `reverse-engineer-anything` skill | Yes    | Yes   | Yes                   | `rea-agents` 6.4.0, MIT. Native binaries need Ghidra 12.1, not installed               |
| Windows-MCP 0.8.8                 | Yes    | No    | No                    | `ANONYMIZED_TELEMETRY=false`                                                            |
| Google Workspace MCP 2.1.0        | Yes    | No    | No                    | `--permissions gmail:drafts calendar:readonly`: the send tool is not registered at all |
| yt-dlp, Jina Reader               | Shell  | Shell | Shell                 | `python -m yt_dlp`; `https://r.jina.ai/<url>`                                           |

The Python servers run on a per-user Python 3.14 with no venv, because Smart App Control blocks venv launchers.

Because Noctis runs Claude on the owner's real setup, the Claude rows are live in Noctis on this PC. That is safe
there: an MCP tool whose name is not a read verb classes as external and asks (`classifyAsk`).

**Codex gets nothing that acts outside the PC.** Codex's app-server raises no approval for an MCP tool call, and an
MCP server runs outside Codex's network-off sandbox, so a Noctis Codex turn could send or click with no ask.

## 2. Open

- **Gmail OAuth client.** The owner creates a Google Cloud OAuth client (Desktop app) and saves it as
  `%USERPROFILE%\.workspace-mcp\client_secret.json`. First use opens Google's consent page.
- **Hermes connectors.** Noctis's Vesper and Jester homes get MCP servers from the list `runtimes/hermes.ts` sends at
  session start, not from the default home's `config.yaml`. Adding Windows-MCP there waits on the fix that stops a
  desktop action that sends being classed as a local edit.
- **Codex MCP asks.** Register outside-acting tools as Codex dynamic tools with an ask in between, the upgrade path
  already noted in `runtimes/mcp-config.ts`.
- **Social and video skills** (`coreyhaines31/marketingskills`, `vyralcontent/content-skills`) and a YouTube
  outlier-analysis workflow: researched, not installed.
