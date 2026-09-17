import { afterEach, describe, expect, it, vi } from "vitest";

import { coreBaseUrl, needsLogin, resolveCoreTransport } from "./core-client.js";
import { BrowserTransport } from "./transport/BrowserTransport.js";
import { SessionTransport } from "./transport/SessionTransport.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

function servedFrom(origin: string): void {
  vi.stubGlobal("window", { location: { origin } });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("coreBaseUrl", () => {
  it("is the page's own origin when nothing configures one", () => {
    servedFrom("https://noctis.tail.ts.net");

    expect(coreBaseUrl()).toBe("https://noctis.tail.ts.net");
  });

  it("is the configured core when a dev build names one", () => {
    servedFrom("http://localhost:5173");
    vi.stubEnv("VITE_CORE_URL", "http://127.0.0.1:8787");

    expect(coreBaseUrl()).toBe("http://127.0.0.1:8787");
  });
});

describe("needsLogin", () => {
  it("is true for a page served with no token: the deployed shape", () => {
    servedFrom("https://noctis.tail.ts.net");

    expect(needsLogin()).toBe(true);
  });

  it("is false for a dev build that was handed a token", () => {
    servedFrom("http://localhost:5173");
    vi.stubEnv("VITE_CORE_TOKEN", TOKEN);

    expect(needsLogin()).toBe(false);
  });
});

describe("resolveCoreTransport", () => {
  it("keeps the polling transport for a dev build that holds a token", () => {
    servedFrom("http://localhost:5173");
    vi.stubEnv("VITE_CORE_URL", "http://localhost:5173");
    vi.stubEnv("VITE_CORE_TOKEN", TOKEN);

    expect(resolveCoreTransport()).toBeInstanceOf(BrowserTransport);
  });

  it("gives a tokenless page the session transport once it has logged in", () => {
    servedFrom("https://noctis.tail.ts.net");

    expect(resolveCoreTransport("csrf-value")).toBeInstanceOf(SessionTransport);
  });

  it("is undefined for a tokenless page with no session, which is not an error", () => {
    servedFrom("https://noctis.tail.ts.net");

    // `undefined` already means "this page cannot reach the core" everywhere in
    // the workbench, so a session that does not exist yet says it the same way.
    expect(resolveCoreTransport()).toBeUndefined();
  });

  it("never builds a session transport over a token, so a dev page keeps one realm", () => {
    servedFrom("http://localhost:5173");
    vi.stubEnv("VITE_CORE_URL", "http://localhost:5173");
    vi.stubEnv("VITE_CORE_TOKEN", TOKEN);

    expect(resolveCoreTransport("csrf-value")).toBeInstanceOf(BrowserTransport);
  });
});
