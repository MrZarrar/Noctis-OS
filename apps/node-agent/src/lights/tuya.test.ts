import { createHash, createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LightsAuthenticationError } from "./secrets.js";
import { TuyaClient } from "./tuya.js";

const credentials = () => Promise.resolve({ username: "access-id", password: "access-secret" });
const v2 = [
  { code: "switch_led", values: "{}" },
  { code: "work_mode", values: '{"range":["white","colour"]}' },
  { code: "bright_value_v2", values: '{"min":10,"max":1000}' },
  { code: "temp_value_v2", values: '{"min":0,"max":1000}' },
  {
    code: "colour_data_v2",
    values: '{"h":{"min":0,"max":360},"s":{"min":0,"max":1000},"v":{"min":0,"max":1000}}',
  },
];
const v1 = v2.map((entry) => ({
  ...entry,
  code: entry.code.replace("_v2", ""),
  values: entry.code.startsWith("bright")
    ? '{"min":25,"max":255}'
    : entry.code.startsWith("temp")
      ? '{"min":0,"max":255}'
      : entry.code.startsWith("colour")
        ? '{"h":{"min":0,"max":360},"s":{"min":0,"max":255},"v":{"min":0,"max":255}}'
        : entry.values,
}));
const status = [
  { code: "switch_led", value: true },
  { code: "work_mode", value: "colour" },
  { code: "bright_value_v2", value: 700 },
  { code: "temp_value_v2", value: 250 },
  { code: "colour_data_v2", value: '{"h":240,"s":600,"v":400}' },
];

function fakeCloud(options: { functions?: typeof v2; status?: typeof status } = {}) {
  const calls: { path: string; init: RequestInit }[] = [];
  let tokenCount = 0;
  let handler: ((path: string, init: RequestInit) => Response | undefined) | undefined;
  const fetcher: typeof fetch = (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname + url.search;
    calls.push({ path, init });
    const override = handler?.(path, init);
    if (override) return Promise.resolve(override);
    if (path.startsWith("/v1.0/token?")) {
      tokenCount++;
      return Promise.resolve(ok({ access_token: `token-${tokenCount}`, expire_time: 120 }));
    }
    if (path.endsWith("/functions"))
      return Promise.resolve(ok({ functions: options.functions ?? v2 }));
    if (path.endsWith("/status")) return Promise.resolve(ok(options.status ?? status));
    if (path.endsWith("/commands")) return Promise.resolve(ok(true));
    return Promise.resolve(ok({ online: true }));
  };
  return {
    fetcher,
    calls,
    intercept: (fn: typeof handler) => {
      handler = fn;
    },
  };
}

function ok(result: unknown) {
  return Response.json({ success: true, result });
}

function body(init: RequestInit): unknown {
  if (typeof init.body !== "string") throw new Error("Expected JSON request body");
  return JSON.parse(init.body) as unknown;
}

function client(cloud: ReturnType<typeof fakeCloud>, now = () => 1_000_000) {
  return new TuyaClient({
    endpoint: "https://openapi.tuyaeu.com/",
    credentials,
    fetch: cloud.fetcher,
    now,
  });
}

afterEach(() => vi.useRealTimers());

describe("TuyaClient", () => {
  it("signs token, status and JSON command requests and reads colour brightness", async () => {
    const cloud = fakeCloud();
    const tuya = client(cloud);
    expect(await tuya.state("bulb/one")).toEqual({
      online: true,
      on: true,
      mode: "colour",
      brightness: 40,
      colorTempK: 3500,
      hue: 240,
      saturation: 60,
    });
    await tuya.set("bulb/one", { light: "desk", on: false });
    for (const { path, init } of cloud.calls) {
      expect(path).toMatch(/^\/v1.0\/(token\?grant_type=1|iot-03\/devices\/bulb%2Fone)/);
      const headers = new Headers(init.headers);
      const body = typeof init.body === "string" ? init.body : "";
      const token = path.startsWith("/v1.0/token") ? "" : "token-1";
      const digest = createHash("sha256").update(body).digest("hex");
      const signed = `access-id${token}1000000${init.method}\n${digest}\n\n${path}`;
      expect(headers.get("sign")).toBe(
        createHmac("sha256", "access-secret").update(signed).digest("hex").toUpperCase(),
      );
      expect(headers.get("client_id")).toBe("access-id");
      expect(headers.get("sign_method")).toBe("HMAC-SHA256");
      expect(headers.get("access_token") ?? "").toBe(token);
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    const command = cloud.calls.find((entry) => entry.path.endsWith("/commands"))!;
    expect(new Headers(command.init.headers).get("content-type")).toBe("application/json");
    expect(body(command.init)).toEqual({
      commands: [{ code: "switch_led", value: false }],
    });
  });

  it("caches tokens with an expiry margin and functions per device", async () => {
    const cloud = fakeCloud();
    let now = 1_000_000;
    const tuya = client(cloud, () => now);
    await tuya.state("one");
    now += 60_000;
    await tuya.state("one");
    expect(cloud.calls.filter((entry) => entry.path.startsWith("/v1.0/token"))).toHaveLength(1);
    now += 35_000;
    await tuya.state("one");
    expect(cloud.calls.filter((entry) => entry.path.startsWith("/v1.0/token"))).toHaveLength(2);
    expect(cloud.calls.filter((entry) => entry.path.endsWith("/functions"))).toHaveLength(1);
  });

  it.each([1010, 1011, "1010", "1011"])(
    "refreshes an invalid token once for code %s",
    async (code) => {
      const cloud = fakeCloud();
      cloud.intercept((path, init) =>
        path.endsWith("/status") && new Headers(init.headers).get("access_token") === "token-1"
          ? Response.json({ success: false, code, msg: "expired" })
          : undefined,
      );
      expect((await client(cloud).state("one")).on).toBe(true);
      expect(cloud.calls.filter((entry) => entry.path.startsWith("/v1.0/token"))).toHaveLength(2);
    },
  );

  it("bounds invalid-token retries and suppresses provider messages", async () => {
    const cloud = fakeCloud();
    cloud.intercept((path) =>
      path.endsWith("/status")
        ? Response.json({ success: false, code: 1010, msg: "access-secret token-1" })
        : undefined,
    );
    await expect(client(cloud).state("one")).rejects.toThrow("Tuya request refused (1010)");
    expect(cloud.calls.filter((entry) => entry.path.endsWith("/status"))).toHaveLength(2);
  });

  it("latches wrong credentials and performs no further network or login attempts", async () => {
    const cloud = fakeCloud();
    const read = vi.fn(credentials);
    cloud.intercept(() => Response.json({ success: false, code: 1004, msg: "access-secret" }));
    const tuya = new TuyaClient({
      endpoint: "https://openapi.tuyaeu.com",
      credentials: read,
      fetch: cloud.fetcher,
    });
    await expect(tuya.state("one")).rejects.toBeInstanceOf(LightsAuthenticationError);
    await expect(tuya.set("two", { light: "desk", on: true })).rejects.toBeInstanceOf(
      LightsAuthenticationError,
    );
    expect(cloud.calls).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("latches a string authentication code from the provider", async () => {
    const cloud = fakeCloud();
    cloud.intercept(() => Response.json({ success: false, code: "1004", msg: "access-secret" }));
    const tuya = client(cloud);
    await expect(tuya.state("one")).rejects.toBeInstanceOf(LightsAuthenticationError);
    await expect(tuya.state("two")).rejects.toBeInstanceOf(LightsAuthenticationError);
    expect(cloud.calls).toHaveLength(1);
  });

  it("shares a token request across concurrent device reads", async () => {
    const cloud = fakeCloud();
    const tuya = client(cloud);
    await Promise.all([tuya.state("one"), tuya.state("two"), tuya.state("one")]);
    expect(cloud.calls.filter((entry) => entry.path.startsWith("/v1.0/token"))).toHaveLength(1);
    expect(cloud.calls.filter((entry) => entry.path.endsWith("/functions"))).toHaveLength(2);
  });

  it("reads the online flag from device detail rather than assuming reachability", async () => {
    const cloud = fakeCloud();
    cloud.intercept((path) => (path.endsWith("/one") ? ok({ online: false }) : undefined));
    expect((await client(cloud).state("one")).online).toBe(false);
  });

  it("keeps hue and saturation when only colour brightness changes", async () => {
    const cloud = fakeCloud();
    await client(cloud).set("one", { light: "desk", brightness: 55 });
    const command = cloud.calls.find((entry) => entry.path.endsWith("/commands"))!;
    expect(body(command.init)).toEqual({
      commands: [{ code: "colour_data_v2", value: '{"h":240,"s":600,"v":550}' }],
    });
  });

  it("maps v1 functions, white temperature and colour ranges", async () => {
    const cloud = fakeCloud({
      functions: v1,
      status: [
        { code: "switch_led", value: false },
        { code: "work_mode", value: "white" },
        { code: "bright_value", value: 255 },
        { code: "temp_value", value: 255 },
        { code: "colour_data", value: '{"h":100,"s":255,"v":128}' },
      ],
    });
    const tuya = client(cloud);
    expect(await tuya.state("one")).toEqual({
      online: true,
      on: false,
      mode: "white",
      brightness: 100,
      colorTempK: 6500,
      hue: 100,
      saturation: 100,
    });
    await tuya.set("one", { light: "desk", brightness: 1, colorTempK: 2500 });
    await tuya.set("one", { light: "desk", hue: 180, saturation: 50, brightness: 80 });
    const commands = cloud.calls
      .filter((entry) => entry.path.endsWith("/commands"))
      .map((entry) => body(entry.init));
    expect(commands).toEqual([
      {
        commands: [
          { code: "work_mode", value: "white" },
          { code: "temp_value", value: 0 },
          { code: "bright_value", value: 25 },
        ],
      },
      {
        commands: [
          { code: "work_mode", value: "colour" },
          { code: "colour_data", value: '{"h":180,"s":128,"v":204}' },
        ],
      },
    ]);
  });

  it("uses function metadata ranges rather than assuming v2 maxima", async () => {
    const cloud = fakeCloud({
      functions: v2.map((entry) =>
        entry.code === "bright_value_v2" ? { ...entry, values: '{"min":5,"max":200}' } : entry,
      ),
      status: status.map((entry) =>
        entry.code === "work_mode" ? { ...entry, value: "white" } : entry,
      ),
    });
    await client(cloud).set("one", { light: "desk", brightness: 75 });
    expect(body(cloud.calls.at(-1)!.init)).toEqual({
      commands: [{ code: "bright_value_v2", value: 150 }],
    });
  });

  it("sanitizes HTTP, transport and malformed response errors", async () => {
    for (const reply of [
      new Response("access-secret", { status: 500 }),
      Response.json({ success: true, result: { access_token: "access-secret" } }),
      Response.json({ success: false, code: "access-secret", msg: "access-secret" }),
    ]) {
      const tuya = new TuyaClient({
        endpoint: "https://openapi.tuyaeu.com",
        credentials,
        fetch: () => Promise.resolve(reply),
      });
      await expect(tuya.state("one")).rejects.toThrow(
        /^Tuya (request failed|response invalid|request refused)/,
      );
    }
    const tuya = new TuyaClient({
      endpoint: "https://openapi.tuyaeu.com",
      credentials,
      fetch: () => Promise.reject(new Error("access-secret")),
    });
    await expect(tuya.state("one")).rejects.toThrow("Tuya request failed");
  });

  it("aborts stalled requests after ten seconds", async () => {
    vi.useFakeTimers();
    const tuya = new TuyaClient({
      endpoint: "https://openapi.tuyaeu.com",
      credentials,
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener("abort", () =>
            reject(new Error("private transport details")),
          ),
        ),
    });
    const assertion = expect(tuya.state("one")).rejects.toThrow("Tuya request timed out");
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(10_000)]);
  });
});
