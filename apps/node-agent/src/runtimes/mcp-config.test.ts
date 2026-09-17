import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BROWSER_TOOLS,
  browserProfileDir,
  playwrightServer,
  refusedBrowserTool,
} from "./mcp-config.js";

const ENV = { NOCTIS_NODE_HOME: "C:\\noctis" };
const THREAD = "0199a000-0000-7000-8000-0000000000e1";
const OTHER = "0199a000-0000-7000-8000-0000000000e9";

describe("the browser a runtime is lent", () => {
  it("gives each thread its own profile under the node home, so cookies do not cross", () => {
    expect(browserProfileDir(ENV, THREAD)).toBe(join("C:\\noctis", "browser", THREAD));
    expect(browserProfileDir(ENV, OTHER)).not.toBe(browserProfileDir(ENV, THREAD));
  });

  it("points the server at that profile and keeps its output out of the granted roots", () => {
    const server = playwrightServer(ENV, THREAD);
    const profile = browserProfileDir(ENV, THREAD);
    const value = (flag: string): string | undefined => server?.args[server.args.indexOf(flag) + 1];

    expect(server?.command).toBe(process.execPath);
    expect(server?.args[0]).toMatch(/@playwright[/\\]mcp[/\\]cli\.js$/);
    expect(server?.args).toContain("--headless");
    expect(value("--user-data-dir")).toBe(profile);
    // Not `cwd`: a screenshot landing in a granted root is a write nobody asked about.
    expect(value("--output-dir")).toBe(join(profile, "output"));
  });

  it("refuses every tool on that server but the five, and nothing on any other server", () => {
    for (const tool of BROWSER_TOOLS) {
      expect(refusedBrowserTool(`mcp__playwright__${tool}`)).toBe(false);
    }

    for (const tool of ["browser_evaluate", "browser_run_code_unsafe", "browser_file_upload"]) {
      expect(refusedBrowserTool(`mcp__playwright__${tool}`)).toBe(true);
    }

    expect(refusedBrowserTool("mcp__noctis__noctis_propose_surface")).toBe(false);
    expect(refusedBrowserTool("Bash")).toBe(false);
  });
});
