import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeProbeSchema } from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { ProbeDeps } from "./probe.js";
import { probeProviders } from "./probe.js";

const BINARY = process.platform === "win32" ? "codex.exe" : "codex";

const MODELS_CACHE = JSON.stringify({
  fetched_at: "2026-09-12T22:47:46Z",
  models: [
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", extra: 1 },
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
    { slug: "gpt-reserve", display_name: "Reserve", visibility: "hide" },
  ],
});

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

interface Scripted {
  codex?: { login: string; version?: string };
  claude?: string;
  cache?: string;
}

/** A machine described entirely by the script: a real codex.exe on PATH only if `codex` is set. */
function deps(script: Scripted): ProbeDeps & { calls: string[] } {
  scratch = mkdtempSync(join(tmpdir(), "noctis-probe-"));

  const bin = join(scratch, "bin");
  const calls: string[] = [];

  if (script.codex !== undefined) {
    mkdirSync(bin);
    writeFileSync(join(bin, BINARY), "", { mode: 0o755 });
  }

  return {
    calls,
    env: { PATH: bin, PATHEXT: ".EXE", OPENAI_API_KEY: "must-not-leak" },
    home: join(scratch, "home"),
    exec: (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);

      if (file.endsWith(BINARY) && script.codex !== undefined) {
        return Promise.resolve({
          stdout: args[0] === "login" ? script.codex.login : (script.codex.version ?? ""),
          code: 0,
        });
      }

      if (file === "claude" && script.claude !== undefined) {
        return Promise.resolve({ stdout: script.claude, code: 0 });
      }

      return Promise.reject(new Error(`spawn ${file} ENOENT`));
    },
    readFile: (path) =>
      script.cache !== undefined && path.endsWith("models_cache.json")
        ? Promise.resolve(script.cache)
        : Promise.reject(new Error("ENOENT")),
  };
}

const LOGGED_IN_CLAUDE = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  email: "someone@example.com",
});

describe("probeProviders", () => {
  it("reports all three providers, each parsing as a probe, when nothing is installed", async () => {
    const probes = await probeProviders(deps({}));

    expect(probes.map((probe) => RuntimeProbeSchema.parse(probe))).toEqual([
      {
        providerId: "codex",
        available: false,
        authMode: "unknown",
        reason: "codex_not_found",
        models: [],
      },
      {
        providerId: "claude",
        available: false,
        authMode: "unknown",
        reason: "claude_not_found",
        models: [],
      },
      { providerId: "hermes", available: false, authMode: "local", reason: "slice_4", models: [] },
    ]);
  });

  it("finds a ChatGPT-logged-in Codex with its version and listed models", async () => {
    const d = deps({
      codex: { login: "Logged in using ChatGPT\n", version: "codex-cli 0.154.0-alpha.6.2\n" },
      cache: MODELS_CACHE,
    });

    const [codex] = await probeProviders(d);

    expect(codex).toEqual({
      providerId: "codex",
      available: true,
      authMode: "chatgpt",
      version: "codex-cli 0.154.0-alpha.6.2",
      models: [
        { providerId: "codex", model: "gpt-6-astra", label: "GPT-6-Astra" },
        { providerId: "codex", model: "gpt-5.5", label: "GPT-5.5" },
      ],
    });
    expect(d.calls.some((call) => call.endsWith("login status"))).toBe(true);
  });

  it("refuses an API-key login as metered, while still reporting what it found", async () => {
    const [codex] = await probeProviders(
      deps({ codex: { login: "Logged in using an API key\n", version: "codex-cli 1.0.0" } }),
    );

    expect(codex).toMatchObject({
      providerId: "codex",
      available: false,
      authMode: "api_key",
      reason: "api_key_login_is_metered",
      version: "codex-cli 1.0.0",
    });
  });

  it("marks a Codex that is installed but not logged in as unknown", async () => {
    const [codex] = await probeProviders(deps({ codex: { login: "Not logged in\n" } }));

    expect(codex).toMatchObject({
      available: false,
      authMode: "unknown",
      reason: "codex_not_logged_in",
    });
  });

  it("reports a claude.ai login as claude_ai and available", async () => {
    const [, claude] = await probeProviders(deps({ claude: LOGGED_IN_CLAUDE }));

    expect(claude).toEqual({
      providerId: "claude",
      available: true,
      authMode: "claude_ai",
      models: [
        { providerId: "claude", model: "sonnet", label: "Claude Sonnet" },
        { providerId: "claude", model: "opus", label: "Claude Opus" },
      ],
    });
  });

  it("reports a Claude that is installed but not logged in as unknown", async () => {
    const [, claude] = await probeProviders(
      deps({ claude: JSON.stringify({ loggedIn: false, authMethod: "none" }) }),
    );

    expect(claude).toMatchObject({ authMode: "unknown", reason: "claude_not_logged_in" });
  });

  it("never carries a token or an email", async () => {
    const probes = await probeProviders(
      deps({ codex: { login: "Logged in using ChatGPT" }, claude: LOGGED_IN_CLAUDE }),
    );
    const text = JSON.stringify(probes);

    expect(text).not.toContain("must-not-leak");
    expect(text).not.toContain("example.com");
  });
});
