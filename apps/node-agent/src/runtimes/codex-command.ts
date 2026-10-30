/**
 * Ported from Jarvis-Sub-Agent-Dashboard `server/lib/providers/codex-command.js`
 * at commit ee7b4527af2500fd9bf423c9efaad7fe2384a87a (MIT, Copyright (c) 2026 -
 * Now, Son Nguyen). See docs/architecture/DONOR-PORT-LEDGER.md for what changed.
 *
 * Resolve the local Codex CLI even when a GUI-launched agent has a sparse PATH.
 */

import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface CodexCommandOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  localAppData?: string;
}

const WINDOWS = process.platform === "win32";
const BINARY = WINDOWS ? "codex.exe" : "codex";

/** Windows environment names are case-insensitive; `Path` and `PATH` are one variable. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);

  return key === undefined ? undefined : env[key];
}

function executable(file: string): boolean {
  try {
    if (!WINDOWS) {
      accessSync(file, constants.X_OK);
    }

    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Everything named `codex` on PATH that Windows can actually CreateProcess.
 *
 * An npm global install puts BOTH an extensionless Unix shim and a `.cmd`
 * wrapper on PATH. The shim is a shell script, so spawning it fails with
 * ENOENT — and Windows ignores the execute bit, so access(X_OK) would not
 * reject it. Only PATHEXT entries are candidates, and `.cmd`/`.bat` are
 * dropped from those: Node refuses to spawn them without `shell: true`
 * (CVE-2024-27980), and a shell would put model text on a cmd.exe command line.
 */
function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  const directories = (envValue(env, "PATH") ?? "").split(delimiter).filter((d) => d !== "");

  if (!WINDOWS) {
    return directories.map((directory) => join(directory, "codex"));
  }

  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext !== "" && ext !== ".cmd" && ext !== ".bat");

  return directories.flatMap((directory) =>
    extensions.map((ext) => join(directory, `codex${ext}`)),
  );
}

/** The standalone installer: `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, newest first. */
function standaloneCandidates(localAppData: string | undefined): string[] {
  if (localAppData === undefined || localAppData === "") {
    return [];
  }

  const bin = join(localAppData, "OpenAI", "Codex", "bin");

  try {
    return readdirSync(bin, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(bin, entry.name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .map((directory) => join(directory, BINARY));
  } catch {
    return [];
  }
}

/** The ChatGPT VS Code extension ships a CLI binary per platform. Newest extension first. */
function extensionCandidates(home: string): string[] {
  const roots = [join(home, ".vscode", "extensions"), join(home, ".vscode-insiders", "extensions")];
  const platformHint = process.platform === "darwin" ? "macos" : process.platform;
  const candidates: string[] = [];

  for (const root of roots) {
    let extensions: string[];

    try {
      extensions = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {
      continue;
    }

    for (const extension of extensions) {
      const binRoot = join(root, extension, "bin");
      let platformDirs: string[];

      try {
        platformDirs = readdirSync(binRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        continue;
      }

      platformDirs.sort(
        (a, b) => Number(b.includes(platformHint)) - Number(a.includes(platformHint)),
      );

      for (const platformDir of platformDirs) {
        candidates.push(join(binRoot, platformDir, BINARY));
      }
    }
  }

  return candidates;
}

/**
 * The first spawnable Codex binary, or `undefined` so a probe can say
 * `codex_not_found` rather than spawning a guess. `NOCTIS_CODEX_PATH` is the
 * operator's word and is returned as given.
 */
export function resolveCodexCommand(options: CodexCommandOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const override = envValue(env, "NOCTIS_CODEX_PATH")?.trim();

  if (override !== undefined && override !== "") {
    return override;
  }

  return [
    ...pathCandidates(env),
    ...standaloneCandidates(options.localAppData ?? envValue(env, "LOCALAPPDATA")),
    ...extensionCandidates(options.home ?? homedir()),
  ].find(executable);
}
