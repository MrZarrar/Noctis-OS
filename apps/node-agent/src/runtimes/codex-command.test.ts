import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCodexCommand } from "./codex-command.js";

const WINDOWS = process.platform === "win32";
const BINARY = WINDOWS ? "codex.exe" : "codex";

const scratches: string[] = [];

afterEach(() => {
  while (scratches.length > 0) {
    const directory = scratches.pop();

    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "noctis-codex-cmd-"));

  scratches.push(directory);

  return directory;
}

function binary(directory: string, name = BINARY): string {
  mkdirSync(directory, { recursive: true });

  const file = join(directory, name);

  writeFileSync(file, "", { mode: 0o755 });

  return file;
}

/** An environment that sees none of this machine: an empty PATH and empty install roots. */
function isolated(overrides: NodeJS.ProcessEnv = {}): {
  env: NodeJS.ProcessEnv;
  home: string;
  localAppData: string;
} {
  const base = scratch();

  return {
    env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD", ...overrides },
    home: join(base, "home"),
    localAppData: join(base, "local"),
  };
}

describe("resolveCodexCommand", () => {
  it("returns undefined when nothing on this machine is Codex", () => {
    expect(resolveCodexCommand(isolated())).toBeUndefined();
  });

  it("takes NOCTIS_CODEX_PATH as given", () => {
    expect(resolveCodexCommand(isolated({ NOCTIS_CODEX_PATH: " C:\\x\\codex.exe " }))).toBe(
      "C:\\x\\codex.exe",
    );
  });

  it("finds a binary on PATH", () => {
    const options = isolated();
    const found = binary(join(scratch(), "bin"));

    options.env.PATH = join(found, "..");

    expect(resolveCodexCommand(options)).toBe(found);
  });

  it.skipIf(!WINDOWS)("prefers the PATHEXT match and never returns the npm shim or .cmd", () => {
    const options = isolated();
    const bin = join(scratch(), "bin");

    // npm's layout: an extensionless shell shim plus a .cmd wrapper. Neither
    // can be spawned. Add the real exe and it wins; remove it and nothing does.
    binary(bin, "codex");
    binary(bin, "codex.cmd");
    // The real variable is spelled `Path` on Windows; one key, not two.
    delete options.env.PATH;
    options.env.Path = bin;

    expect(resolveCodexCommand(options)).toBeUndefined();

    const exe = binary(bin, "codex.exe");

    expect(resolveCodexCommand(options)).toBe(exe);
  });

  it("finds the standalone install under LOCALAPPDATA, newest hash directory first", () => {
    const options = isolated();
    const bin = join(options.localAppData, "OpenAI", "Codex", "bin");
    const older = binary(join(bin, "aaaa"));
    const newer = binary(join(bin, "bbbb"));

    utimesSync(join(bin, "aaaa"), new Date(1_000_000_000_000), new Date(1_000_000_000_000));
    utimesSync(join(bin, "bbbb"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    expect(resolveCodexCommand(options)).toBe(newer);
    expect(older).not.toBe(newer);
  });

  it("falls back to the VS Code extension binary, newest extension first", () => {
    const options = isolated();
    const extensions = join(options.home, ".vscode", "extensions");
    const platformDir = process.platform === "darwin" ? "macos-arm64" : `${process.platform}-x64`;

    binary(join(extensions, "openai.chatgpt-0.9.0", "bin", platformDir));

    const newest = binary(join(extensions, "openai.chatgpt-0.10.0", "bin", platformDir));

    expect(resolveCodexCommand(options)).toBe(newest);
  });

  it("prefers PATH over the standalone install, and that over the extension", () => {
    const options = isolated();
    const onPath = binary(join(scratch(), "bin"));

    binary(join(options.localAppData, "OpenAI", "Codex", "bin", "hash"));
    options.env.PATH = join(onPath, "..");

    expect(resolveCodexCommand(options)).toBe(onPath);
  });
});
