import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigurationError, DEFAULT_PORT, loadCoreConfig } from "./server.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

/** A directory that looks like `apps/web/dist` does after a build. */
function builtPage(): string {
  const root = mkdtempSync(join(tmpdir(), "noctis-web-"));

  writeFileSync(join(root, "index.html"), "<!doctype html>");

  return root;
}

function env(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    NOCTIS_CORE_TOKEN: TOKEN,
    NOCTIS_DATABASE_PATH: ":memory:",
    ...overrides,
  };

  return Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

describe("loadCoreConfig", () => {
  it("binds loopback on the Noctis port by default", () => {
    const config = loadCoreConfig(env());

    expect(config.bindAddress).toBe("127.0.0.1");
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.allowedOrigins).toEqual([]);
  });

  it.each([
    ["a missing token", env({ NOCTIS_CORE_TOKEN: undefined })],
    ["a blank token", env({ NOCTIS_CORE_TOKEN: "   " })],
    ["a short token", env({ NOCTIS_CORE_TOKEN: "tooshort" })],
    ["a missing database path", env({ NOCTIS_DATABASE_PATH: undefined })],
    ["a non-numeric port", env({ NOCTIS_CORE_PORT: "eight" })],
    ["a fractional port", env({ NOCTIS_CORE_PORT: "80.5" })],
    ["an out-of-range port", env({ NOCTIS_CORE_PORT: "70000" })],
    ["an unknown log level", env({ NOCTIS_LOG_LEVEL: "chatty" })],
    ["an origin with a path", env({ NOCTIS_ALLOWED_ORIGINS: "https://a.example/app" })],
    ["an origin that is not a URL", env({ NOCTIS_ALLOWED_ORIGINS: "a.example" })],
    ["a legacy Jarvis variable", { ...env(), JARVIS_API_KEY: "x" }],
  ])("refuses to start with %s", (_label, values) => {
    expect(() => loadCoreConfig(values)).toThrow();
  });

  it("refuses a non-loopback bind without an explicit opt-in", () => {
    expect(() => loadCoreConfig(env({ NOCTIS_CORE_BIND: "0.0.0.0" }))).toThrow(ConfigurationError);
  });

  it("allows a non-loopback bind only when it is asked for by name", () => {
    const config = loadCoreConfig(
      env({ NOCTIS_CORE_BIND: "0.0.0.0", NOCTIS_ALLOW_NON_LOOPBACK: "true" }),
    );

    expect(config.bindAddress).toBe("0.0.0.0");
  });

  it.each(["1", "yes", "TRUE", "true-ish"])(
    "does not accept %s as an opt-in to a non-loopback bind",
    (value) => {
      expect(() =>
        loadCoreConfig(env({ NOCTIS_CORE_BIND: "0.0.0.0", NOCTIS_ALLOW_NON_LOOPBACK: value })),
      ).toThrow(ConfigurationError);
    },
  );

  it("accepts port 0 so the OS can choose one", () => {
    expect(loadCoreConfig(env({ NOCTIS_CORE_PORT: "0" })).port).toBe(0);
  });

  it("parses a comma-separated origin allowlist", () => {
    const config = loadCoreConfig(
      env({ NOCTIS_ALLOWED_ORIGINS: "https://a.example, http://localhost:5173" }),
    );

    expect(config.allowedOrigins).toEqual(["https://a.example", "http://localhost:5173"]);
  });

  it("defaults the session lifetime to thirty days and rejects a fractional one", () => {
    expect(loadCoreConfig(env({})).sessionTtlHours).toBe(720);
    expect(() => loadCoreConfig(env({ NOCTIS_SESSION_TTL_HOURS: "1.5" }))).toThrow(
      ConfigurationError,
    );
  });

  it("serves no page unless a web root is named, so the dev loop is unchanged", () => {
    expect(loadCoreConfig(env()).webRoot).toBeUndefined();
    expect(loadCoreConfig(env({ NOCTIS_WEB_ROOT: "   " })).webRoot).toBeUndefined();
  });

  it("resolves the web root absolute, so it does not move with the working directory", () => {
    const root = builtPage();

    try {
      const config = loadCoreConfig(
        env({
          NOCTIS_WEB_ROOT: ` ${relative(process.cwd(), root)} `,
          NOCTIS_ALLOWED_ORIGINS: "https://noctis.example",
        }),
      );

      expect(config.webRoot).toBe(root);
      expect(isAbsolute(config.webRoot ?? "")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a web root with no index.html rather than 404ing every request", () => {
    const empty = mkdtempSync(join(tmpdir(), "noctis-empty-"));

    try {
      expect(() =>
        loadCoreConfig(
          env({ NOCTIS_WEB_ROOT: empty, NOCTIS_ALLOWED_ORIGINS: "https://noctis.example" }),
        ),
      ).toThrow(/index\.html/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("refuses to serve a page with no origin allowlist, which would load and do nothing", () => {
    const root = builtPage();

    try {
      // The page loads (no Origin on a same-origin GET navigation) and then
      // cannot log in or stream, because both the POST and the EventSource do
      // send Origin. Failing at startup beats a front door that silently works
      // for exactly one request.
      expect(() => loadCoreConfig(env({ NOCTIS_WEB_ROOT: root }))).toThrow(
        /NOCTIS_ALLOWED_ORIGINS/,
      );
      expect(() => loadCoreConfig(env({ NOCTIS_WEB_ROOT: root }))).toThrow(ConfigurationError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadCoreConfig: web push", () => {
  const VAPID = {
    NOCTIS_VAPID_PUBLIC_KEY: "BPublicKey",
    NOCTIS_VAPID_PRIVATE_KEY: "PrivateKey",
    NOCTIS_VAPID_SUBJECT: "mailto:owner@example.com",
  };

  it("has no push configuration when none of the three is set", () => {
    expect(loadCoreConfig(env()).vapid).toBeUndefined();
  });

  it("reads all three together", () => {
    expect(loadCoreConfig(env(VAPID)).vapid).toEqual({
      publicKey: "BPublicKey",
      privateKey: "PrivateKey",
      subject: "mailto:owner@example.com",
    });
  });

  it.each([
    ["only the public key", { NOCTIS_VAPID_PUBLIC_KEY: VAPID.NOCTIS_VAPID_PUBLIC_KEY }],
    ["only the private key", { NOCTIS_VAPID_PRIVATE_KEY: VAPID.NOCTIS_VAPID_PRIVATE_KEY }],
    ["only the subject", { NOCTIS_VAPID_SUBJECT: VAPID.NOCTIS_VAPID_SUBJECT }],
    ["a missing subject", { ...VAPID, NOCTIS_VAPID_SUBJECT: undefined }],
    ["a blank private key", { ...VAPID, NOCTIS_VAPID_PRIVATE_KEY: "   " }],
  ])("refuses %s, because a typo and a deliberate absence look identical", (_case, overrides) => {
    expect(() => loadCoreConfig(env(overrides))).toThrow(ConfigurationError);
    expect(() => loadCoreConfig(env(overrides))).toThrow(/all three/);
  });

  it("refuses a subject that is not a mailto: or https:// URL", () => {
    expect(() =>
      loadCoreConfig(env({ ...VAPID, NOCTIS_VAPID_SUBJECT: "owner@example.com" })),
    ).toThrow(/mailto:/);
  });

  it("never repeats the private key in the refusal, because an error message gets pasted around", () => {
    try {
      loadCoreConfig(env({ NOCTIS_VAPID_PRIVATE_KEY: "super-secret-private-key" }));
      expect.unreachable("expected a ConfigurationError");
    } catch (error) {
      expect(String(error)).not.toContain("super-secret-private-key");
    }
  });
});
