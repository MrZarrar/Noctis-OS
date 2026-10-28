import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BROWSER_SERVER,
  DESKTOP_SERVER,
  browserProfileDir,
  browserServer,
  desktopServer,
  refusedTool,
} from "./mcp-config.js";

const ENV = { NOCTIS_NODE_HOME: "C:\\noctis" };
const THREAD = "0199a000-0000-7000-8000-0000000000e1";
const OTHER = "0199a000-0000-7000-8000-0000000000e9";

function value(args: readonly string[] | undefined, flag: string): string | undefined {
  return args?.[args.indexOf(flag) + 1];
}

describe("the browser a runtime is lent", () => {
  it("attaches to the owner's own Chrome when its extension token is set", () => {
    const server = browserServer({ ...ENV, NOCTIS_BROWSER_EXTENSION_TOKEN: "tok" }, THREAD);

    expect(server?.command).toBe(process.execPath);
    expect(server?.args[0]).toMatch(/@playwright[/\\]mcp[/\\]cli\.js$/);
    expect(server?.args).toContain("--extension");
    expect(value(server?.args, "--browser")).toBe("chrome");
    expect(server?.args).not.toContain("--headless");
    expect(server?.args).not.toContain("--user-data-dir");
    // Without the token the extension waits for someone to click Allow in the browser.
    expect(server?.env).toMatchObject({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: "tok" });
  });

  it("takes another Chromium channel when the owner names one", () => {
    const server = browserServer(
      { ...ENV, NOCTIS_BROWSER_EXTENSION_TOKEN: "tok", NOCTIS_BROWSER_CHANNEL: "msedge" },
      THREAD,
    );

    expect(value(server?.args, "--browser")).toBe("msedge");
  });

  it("attaches to a running Firefox or Zen through Mozilla's server when it is named", () => {
    const entry = "C:\\npm\\node_modules\\@mozilla\\firefox-devtools-mcp\\dist\\index.js";
    const server = browserServer({ ...ENV, NOCTIS_FIREFOX_MCP: entry }, THREAD);

    expect(server?.command).toBe(process.execPath);
    expect(server?.args[0]).toBe(entry);
    expect(server?.args).toContain("--connect-existing");
    expect(value(server?.args, "--marionette-port")).toBe("2828");
  });

  it("otherwise keeps a headless browser with a profile per thread, so cookies do not cross", () => {
    const server = browserServer(ENV, THREAD);
    const profile = browserProfileDir(ENV, THREAD);

    expect(browserProfileDir(ENV, OTHER)).not.toBe(profile);
    expect(server?.args).toContain("--headless");
    expect(value(server?.args, "--user-data-dir")).toBe(profile);
    // Not `cwd`: a screenshot landing in a granted root is a write nobody asked about.
    expect(value(server?.args, "--output-dir")).toBe(join(profile, "output"));
  });

  it("refuses unrestricted script runners on both browser server names", () => {
    for (const server of [BROWSER_SERVER, "playwright"]) {
      for (const tool of ["browser_run_code_unsafe", "evaluate_script"]) {
        expect(refusedTool(`mcp__${server}__${tool}`)).toBe(true);
      }
    }

    for (const tool of [
      "browser_click",
      "browser_evaluate",
      "browser_tabs",
      "browser_select_option",
      "browser_press_key",
      "browser_file_upload",
    ]) {
      expect(refusedTool(`mcp__${BROWSER_SERVER}__${tool}`)).toBe(false);
    }

    expect(refusedTool("mcp__noctis__noctis_propose_surface")).toBe(false);
    expect(refusedTool("Bash")).toBe(false);
  });
});

describe("the desktop a runtime is lent", () => {
  function installed(): string {
    const dir = mkdtempSync(join(tmpdir(), "noctis-desktop-"));
    const exe = join(dir, "windows-mcp.exe");
    mkdirSync(dir, { recursive: true });
    writeFileSync(exe, "");
    return exe;
  }

  it("runs Windows-MCP without the tools that would step around Noctis's own asks", () => {
    const exe = installed();
    const server = desktopServer({ NOCTIS_WINDOWS_MCP: exe });

    expect(server?.command).toBe(exe);
    expect(server?.args[0]).toBe("serve");
    // The agent's own shell and file tools do these, and Noctis classifies those.
    expect(value(server?.args, "--exclude-tools")?.split(",").sort()).toEqual([
      "FileSystem",
      "PowerShell",
      "Process",
      "Registry",
    ]);
    expect(server?.env).toMatchObject({ ANONYMIZED_TELEMETRY: "false" });
  });

  it("finds it where pip puts it for the owner's Python 3.14", () => {
    const appData = mkdtempSync(join(tmpdir(), "noctis-appdata-"));
    const scripts = join(appData, "Python", "Python314", "Scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "windows-mcp.exe"), "");

    expect(desktopServer({ APPDATA: appData })?.command).toBe(join(scripts, "windows-mcp.exe"));
  });

  it("is absent on a PC without it", () => {
    expect(desktopServer({ APPDATA: join(tmpdir(), "no-such-appdata") })).toBeUndefined();
    expect(desktopServer({ NOCTIS_WINDOWS_MCP: join(tmpdir(), "missing.exe") })).toBeUndefined();
  });

  it("names its server so the classifier knows a desktop step", () => {
    expect(DESKTOP_SERVER).toBe("desktop");
    expect(BROWSER_SERVER).toBe("browser");
  });
});
