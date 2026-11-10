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

/** The shape `~/.claude/cache/model-catalog` really holds, trimmed to what is read. */
function catalogFile(fetchedAt: number, surface = "cc"): string {
  return JSON.stringify({
    version: 2,
    fetchedAt,
    staleAt: fetchedAt + 3_600_000,
    catalog: {
      surface,
      config: {
        id: surface,
        models: [
          { id: "claude-opus-5-5", name: "Opus 5.5", section: "main", quick_select: true },
          // A floor the installed CLI does not meet on paper, offered anyway.
          {
            id: "claude-fable-5-2",
            name: "Fable 5.2",
            section: "main",
            min_claude_code_version: "2.1.290",
          },
          { id: "claude-sonnet-5", name: "Sonnet 5", section: "overflow" },
        ],
      },
    },
  });
}

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

interface Scripted {
  /** `loginOn` because the real CLI prints its answer on stderr and exits 0. */
  codex?: { login: string; loginOn?: "stdout" | "stderr"; version?: string };
  claude?: string;
  claudeVersion?: string;
  cache?: string;
  /** Files in the Claude CLI's model-catalog cache, by name. */
  catalog?: Record<string, string>;
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
        const isLogin = args[0] === "login";
        const text = isLogin ? script.codex.login : (script.codex.version ?? "");
        const onStderr = isLogin && script.codex.loginOn === "stderr";

        return Promise.resolve({
          stdout: onStderr ? "" : text,
          stderr: onStderr ? text : "",
          code: 0,
        });
      }

      if (file === "claude" && script.claude !== undefined) {
        const text = args[0] === "--version" ? (script.claudeVersion ?? "") : script.claude;

        return Promise.resolve({ stdout: text, stderr: "", code: 0 });
      }

      return Promise.reject(new Error(`spawn ${file} ENOENT`));
    },
    readFile: (path) => {
      if (script.cache !== undefined && path.endsWith("models_cache.json")) {
        return Promise.resolve(script.cache);
      }

      const held = Object.entries(script.catalog ?? {}).find(([name]) => path.endsWith(name));

      return held === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(held[1]);
    },
    readDirectory: (path) =>
      script.catalog === undefined || !path.endsWith("model-catalog")
        ? Promise.reject(new Error("ENOENT"))
        : Promise.resolve(Object.keys(script.catalog)),
  };
}

const LOGGED_IN_CLAUDE = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  email: "someone@example.com",
});

describe("probeProviders", () => {
  it("reports the installed CLIs, each parsing as a probe, when nothing is installed", async () => {
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

  it("advertises the effort levels from each provider's model catalog", async () => {
    const catalog = JSON.parse(catalogFile(1)) as {
      catalog: { config: { models: Array<Record<string, unknown>> } };
    };
    catalog.catalog.config.models[0]!.runtime = { effort_levels: ["low", "high", "max"] };
    const d = deps({
      codex: { login: "Logged in using ChatGPT" },
      claude: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      cache: JSON.stringify({
        models: [
          {
            slug: "gpt-6.1-sol",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
          },
        ],
      }),
      catalog: { "test.json": JSON.stringify(catalog) },
    });
    const [codex, claude] = await probeProviders(d);
    expect(codex?.models[0]?.supportedEfforts).toEqual(["low", "ultra"]);
    expect(claude?.models[0]?.supportedEfforts).toEqual(["low", "high", "max"]);
  });

  it("THE GATE: reads the login line from stderr, which is where the CLI prints it", async () => {
    // codex-cli 0.154 prints "Logged in using ChatGPT" on stderr and exits 0.
    // A probe reading stdout alone reports a signed-in subscription as logged
    // out, and the router then refuses every turn on a machine that was fine.
    const [codex] = await probeProviders(
      deps({
        codex: { login: "Logged in using ChatGPT\n", loginOn: "stderr" },
        cache: MODELS_CACHE,
      }),
    );

    expect(codex).toMatchObject({ available: true, authMode: "chatgpt" });
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
        { providerId: "claude", model: "claude-opus-5-5", label: "Claude Opus 5.5" },
        { providerId: "claude", model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
        { providerId: "claude", model: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      ],
    });
  });

  it("offers what the Claude CLI's own catalog lists, newest cache file winning", async () => {
    const [, claude] = await probeProviders(
      deps({
        claude: LOGGED_IN_CLAUDE,
        claudeVersion: "2.1.322 (Claude Code)",
        catalog: {
          "old-cc.json": catalogFile(1),
          "current-cc.json": catalogFile(2),
          "other-surface.json": catalogFile(3, "api"),
          "half-written.json": "{nope",
        },
      }),
    );

    expect(claude).toMatchObject({
      available: true,
      version: "2.1.322 (Claude Code)",
      models: [
        { providerId: "claude", model: "claude-opus-5-5", label: "Claude Opus 5.5" },
        { providerId: "claude", model: "claude-fable-5-2", label: "Claude Fable 5.2" },
        { providerId: "claude", model: "claude-sonnet-5", label: "Claude Sonnet 5" },
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
