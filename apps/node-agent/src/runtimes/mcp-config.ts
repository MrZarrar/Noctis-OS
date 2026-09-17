import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The browser Noctis lends a runtime, and the boundary around it (Slice 3.1).
 *
 * Playwright MCP is spawned as an ordinary stdio server, but two things are
 * decided here rather than by the server:
 *
 * - **Where its cookies live.** `--user-data-dir` is one directory per thread
 *   under `%NOCTIS_NODE_HOME%\browser`, so a session signed in inside one
 *   thread is not a session another thread inherits. Screenshots and traces go
 *   to a sibling `output` directory for the same reason a granted root is not
 *   the right place for them: a file written under `cwd` is a file written
 *   without a file_change ask.
 * - **Which tools exist.** The server ships some seventy, including
 *   `browser_evaluate` and `browser_run_code_unsafe`, and it has no per-tool
 *   flag — `--caps` only adds groups. So the five the master plan names are
 *   the allowlist, and anything else on this server is refused at the
 *   `canUseTool` boundary without an ask. Asking would imply it was a choice.
 *
 * ponytail: attached on the Claude route only. Verified against the Codex
 * 0.154 protocol schema (`codex app-server generate-json-schema`): its
 * `ServerRequest` set raises approvals for commands, file changes and
 * permissions — and nothing at all for an MCP tool call, which would put a
 * browser behind Codex that no ask ever sees. Upgrade path: register the five
 * as Codex *dynamic* tools and serve `item/tool/call` by proxying to this
 * server with an ask in between.
 */

export const PLAYWRIGHT_SERVER = "playwright";

/** `mcp__<server>__<tool>`, which is how both the SDK and `classifyAsk` see them. */
const PREFIX = `mcp__${PLAYWRIGHT_SERVER}__`;

export const BROWSER_TOOLS: readonly string[] = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_take_screenshot",
];

/** A browser tool this node does not lend: refused outright, never asked about. */
export function refusedBrowserTool(toolName: string): boolean {
  return toolName.startsWith(PREFIX) && !BROWSER_TOOLS.includes(toolName.slice(PREFIX.length));
}

/** The node's own home. The same fallback the proposals directory takes. */
export function nodeHome(env: NodeJS.ProcessEnv): string {
  const home = env.NOCTIS_NODE_HOME?.trim();

  return home === undefined || home === "" ? join(tmpdir(), "noctis") : home;
}

/** One browser profile per thread. A thread id is a UUID, so it is already a safe directory name. */
export function browserProfileDir(env: NodeJS.ProcessEnv, threadId: string): string {
  return join(nodeHome(env), "browser", threadId);
}

export interface StdioServer {
  command: string;
  args: string[];
}

const resolve = createRequire(import.meta.url).resolve;

/**
 * The Playwright MCP server for one thread, or nothing when the package is not
 * installed on this node — a node without it simply has no browser tools.
 *
 * Resolved through `package.json` because the package exports only `.`, so
 * `require.resolve("@playwright/mcp/cli.js")` is refused by the exports map.
 */
export function playwrightServer(
  env: NodeJS.ProcessEnv,
  threadId: string,
): StdioServer | undefined {
  let cli: string;

  try {
    cli = join(dirname(resolve("@playwright/mcp/package.json")), "cli.js");
  } catch {
    return undefined;
  }

  const profile = browserProfileDir(env, threadId);

  return {
    command: process.execPath,
    args: [cli, "--headless", "--user-data-dir", profile, "--output-dir", join(profile, "output")],
  };
}
