import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../logging.js";
import type { RunningCore } from "../server.js";
import { startCore } from "../server.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

const started: { core: RunningCore; directory: string }[] = [];
afterEach(async () => {
  for (const { core, directory } of started.splice(0)) {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

async function startTestCore(): Promise<{ base: string; core: RunningCore }> {
  const directory = mkdtempSync(join(tmpdir(), "noctis-dexcom-"));
  const core = await startCore({
    config: {
      bindAddress: "127.0.0.1",
      port: 0,
      token: TOKEN,
      databasePath: join(directory, "core.db"),
      allowedOrigins: [],
      logLevel: "error",
      sessionTtlHours: 720,
    },
    logger: createLogger({ sink: () => undefined, level: "error" }),
  });
  started.push({ core, directory });
  return { base: `http://127.0.0.1:${String(core.port)}`, core };
}

async function session(base: string): Promise<{ cookie: string; csrf: string }> {
  const login = await fetch(`${base}/session/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const { csrf } = (await login.json()) as { csrf: string };
  return { cookie, csrf };
}

const realFetch = fetch;

describe("Dexcom integration routes", () => {
  it("connects, serves a live reading, then disconnects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (!url.includes("dexcom.com")) return realFetch(url, init);
        if (url.includes("LoginPublisherAccountById"))
          return new Response(JSON.stringify("session-abc"), { status: 200 });
        if (url.includes("ReadPublisherLatestGlucoseValues"))
          return new Response(
            JSON.stringify([{ Value: 108, Trend: "Flat", WT: `/Date(${String(Date.now())})/` }]),
            { status: 200 },
          );
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const { base } = await startTestCore();
    const { cookie, csrf } = await session(base);
    const headers = { cookie, "content-type": "application/json", "x-noctis-csrf": csrf };

    const before = await fetch(`${base}/integrations/dexcom`, { headers: { cookie } });
    expect(await before.json()).toEqual({ configured: false });

    const connect = await fetch(`${base}/integrations/dexcom`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "me@example.com", password: "hunter2" }),
    });
    expect(connect.status).toBe(200);
    expect(await connect.text()).not.toContain("hunter2");

    const live = await fetch(`${base}/glucose/live`, { headers: { cookie } });
    expect(await live.json()).toMatchObject({ state: "ok", mmol: 6, trend: "flat" });

    const disconnect = await fetch(`${base}/integrations/dexcom/disconnect`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(await disconnect.json()).toEqual({ configured: false });

    const liveAfter = await fetch(`${base}/glucose/live`, { headers: { cookie } });
    expect(await liveAfter.json()).toEqual({ state: "not_configured" });
  });

  it("reports Dexcom's own message on a bad login, without storing anything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url.includes("dexcom.com")
          ? new Response(JSON.stringify({ Message: "Password not valid." }), { status: 500 })
          : realFetch(url, init),
      ),
    );

    const { base } = await startTestCore();
    const { cookie, csrf } = await session(base);

    const connect = await fetch(`${base}/integrations/dexcom`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-noctis-csrf": csrf },
      body: JSON.stringify({ username: "me@example.com", password: "wrong" }),
    });
    expect(connect.status).toBe(422);
    const body = (await connect.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Password not valid.");

    const status = await fetch(`${base}/integrations/dexcom`, { headers: { cookie } });
    expect(await status.json()).toEqual({ configured: false });
  });
});
