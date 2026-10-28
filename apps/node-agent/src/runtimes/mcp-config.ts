import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The browser and desktop Noctis lends a runtime: the owner's own screen.
 *
 * - **The browser** is the owner's real one when this PC names it, so the agent
 *   works in their tabs with their logins: Chrome (or another Chromium) through
 *   Playwright's extension, or Firefox and Zen through Mozilla's server attached
 *   to the running browser. A PC that names neither gets a headless Playwright
 *   with one profile per thread, so a session signed in inside one thread is not
 *   one another thread inherits.
 * - **The desktop** is Windows-MCP, minus its shell, file system, registry and
 *   process tools: the agent's own shell and file tools already do those, and
 *   Noctis classifies every one of them. Windows-MCP's would go round that.
 *
 * Every server takes its whole toolset but the few that run raw code. What a step
 * on these servers may do without asking is decided by `classifyAsk`, which knows
 * them by these server names.
 */

export const BROWSER_SERVER = "browser";
export const DESKTOP_SERVER = "desktop";

/** Unrestricted script runners stay unavailable; page evaluations pass through classification. */
const RAW_CODE_TOOLS = new Set(["browser_run_code_unsafe", "evaluate_script"]);
const BROWSER_PREFIX = /^mcp__(?:browser|playwright)__/;

/** A tool this node does not lend: refused outright, never asked about. */
export function refusedTool(toolName: string): boolean {
  const prefix = BROWSER_PREFIX.exec(toolName)?.[0];

  return prefix !== undefined && RAW_CODE_TOOLS.has(toolName.slice(prefix.length));
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
  env?: Record<string, string>;
}

const resolve = createRequire(import.meta.url).resolve;

function named(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * The browser server for one thread, or nothing when Playwright is not
 * installed on this node and no other browser is named.
 *
 * Resolved through `package.json` because the package exports only `.`, so
 * `require.resolve("@playwright/mcp/cli.js")` is refused by the exports map.
 */
export function browserServer(env: NodeJS.ProcessEnv, threadId: string): StdioServer | undefined {
  const firefox = named(env.NOCTIS_FIREFOX_MCP);
  const token = named(env.NOCTIS_BROWSER_EXTENSION_TOKEN);

  if (token === undefined && firefox !== undefined) {
    // Firefox and Zen have to be started with --marionette --remote-debugging-port for this.
    return {
      command: process.execPath,
      args: [
        firefox,
        "--connect-existing",
        "--marionette-port",
        named(env.NOCTIS_FIREFOX_MARIONETTE_PORT) ?? "2828",
      ],
    };
  }

  let cli: string;

  try {
    cli = join(dirname(resolve("@playwright/mcp/package.json")), "cli.js");
  } catch {
    return undefined;
  }

  const profile = browserProfileDir(env, threadId);
  const output = ["--output-dir", join(profile, "output")];

  if (token !== undefined) {
    return {
      command: process.execPath,
      args: [
        cli,
        "--extension",
        "--browser",
        named(env.NOCTIS_BROWSER_CHANNEL) ?? "chrome",
        ...output,
      ],
      env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: token },
    };
  }

  return {
    command: process.execPath,
    args: [cli, "--headless", "--user-data-dir", profile, ...output],
  };
}

/** Where `pip install --user windows-mcp` puts it for the owner's Python 3.14. */
function installedWindowsMcp(env: NodeJS.ProcessEnv): string | undefined {
  const chosen = named(env.NOCTIS_WINDOWS_MCP);

  if (chosen !== undefined) {
    return existsSync(chosen) ? chosen : undefined;
  }

  const appData = named(env.APPDATA);
  const exe =
    appData === undefined
      ? undefined
      : join(appData, "Python", "Python314", "Scripts", "windows-mcp.exe");

  return exe !== undefined && existsSync(exe) ? exe : undefined;
}

/** Windows-MCP for this PC's desktop, or nothing when it is not installed. */
export function desktopServer(env: NodeJS.ProcessEnv): StdioServer | undefined {
  const exe = installedWindowsMcp(env);

  return exe === undefined
    ? undefined
    : {
        command: exe,
        args: ["serve", "--exclude-tools", "PowerShell,FileSystem,Registry,Process"],
        env: { ANONYMIZED_TELEMETRY: "false" },
      };
}
