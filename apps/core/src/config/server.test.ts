import { describe, expect, it } from "vitest";

import { ConfigurationError, DEFAULT_PORT, loadCoreConfig } from "./server.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

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
});
