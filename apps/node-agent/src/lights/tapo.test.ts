import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TapoClient } from "./tapo.js";
import { LightsAuthenticationError } from "./secrets.js";

const credentials = () =>
  Promise.resolve({ username: "owner@example.test", password: "test-password" });
const sha = (...parts: (Buffer | string)[]) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

async function bulb(
  options: {
    wrongLogin?: boolean;
    expire?: "http" | "code" | "always";
    corrupt?: boolean;
    response?: unknown;
    plaintext?: string;
    stallBody?: boolean;
  } = {},
) {
  const login = await credentials();
  const auth = sha(
    createHash("sha1").update(login.username).digest(),
    createHash("sha1").update(login.password).digest(),
  );
  const remote = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  let local = Buffer.alloc(0);
  let key = Buffer.alloc(0);
  let prefix = Buffer.alloc(0);
  let signing = Buffer.alloc(0);
  let sequence = 0;
  let handshakes = 0;
  let requests = 0;
  const calls: unknown[] = [];
  const failures: unknown[] = [];
  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const parts: Buffer[] = [];
      for await (const part of req as AsyncIterable<Uint8Array>) parts.push(Buffer.from(part));
      const body = Buffer.concat(parts);
      if (req.url === "/app/handshake1") {
        handshakes++;
        expect(body).toHaveLength(16);
        local = body;
        res.setHeader("Set-Cookie", "TP_SESSIONID=fake-session; Path=/; HttpOnly");
        res.end(
          Buffer.concat([remote, options.wrongLogin ? Buffer.alloc(32) : sha(local, remote, auth)]),
        );
        return;
      }
      expect(req.headers.cookie).toBe("TP_SESSIONID=fake-session");
      if (req.url === "/app/handshake2") {
        expect(body).toEqual(sha(remote, local, auth));
        key = sha("lsk", local, remote, auth).subarray(0, 16);
        const iv = sha("iv", local, remote, auth);
        prefix = iv.subarray(0, 12);
        sequence = iv.readInt32BE(28);
        signing = sha("ldk", local, remote, auth).subarray(0, 28);
        res.end();
        return;
      }
      requests++;
      sequence = (sequence + 1) | 0;
      expect(req.url).toBe(`/app/request?seq=${sequence}`);
      const seq = Buffer.alloc(4);
      seq.writeInt32BE(sequence);
      expect(body.subarray(0, 32)).toEqual(sha(signing, seq, body.subarray(32)));
      const iv = Buffer.concat([prefix, seq]);
      const decipher = createDecipheriv("aes-128-cbc", key, iv);
      calls.push(
        JSON.parse(
          Buffer.concat([decipher.update(body.subarray(32)), decipher.final()]).toString(),
        ),
      );
      if (options.expire === "always" || (options.expire === "http" && requests === 1)) {
        res.writeHead(403).end();
        return;
      }
      if (options.stallBody) {
        res.write(Buffer.alloc(1));
        return;
      }
      const response =
        options.expire === "code" && requests === 1
          ? { error_code: 9999 }
          : (options.response ?? {
              error_code: 0,
              result: {
                device_on: true,
                brightness: 57,
                color_temp: 4200,
                hue: 120,
                saturation: 48,
              },
            });
      const cipher = createCipheriv("aes-128-cbc", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(options.plaintext ?? JSON.stringify(response)),
        cipher.final(),
      ]);
      const signature = sha(signing, seq, encrypted);
      if (options.corrupt) signature[0] = signature[0]! ^ 1;
      res.end(Buffer.concat([signature, encrypted]));
    } catch (error) {
      failures.push(error);
      res.writeHead(500).end();
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return {
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    failures,
    counts: () => ({ handshakes, requests }),
  };
}

describe("Tapo KLAP", () => {
  it("authenticates both handshakes, validates request crypto and maps white state", async () => {
    const fake = await bulb();
    const client = new TapoClient({ host: fake.host, credentials });
    expect(await client.state()).toEqual({
      online: true,
      on: true,
      brightness: 57,
      mode: "white",
      colorTempK: 4200,
      hue: 120,
      saturation: 48,
    });
    await client.set({ light: "desk", on: false, brightness: 33, hue: 230, saturation: 75 });
    await client.set({ light: "desk", colorTempK: 5000 });
    expect(fake.calls).toEqual([
      { method: "get_device_info" },
      {
        method: "set_device_info",
        params: { device_on: false, brightness: 33, hue: 230, saturation: 75, color_temp: 0 },
      },
      { method: "set_device_info", params: { color_temp: 5000 } },
    ]);
    expect(fake.counts()).toEqual({ handshakes: 1, requests: 3 });
    expect(fake.failures).toEqual([]);
  });

  it("permanently stops this client after wrong credentials", async () => {
    const fake = await bulb({ wrongLogin: true });
    const client = new TapoClient({ host: fake.host, credentials });
    await expect(client.state()).rejects.toBeInstanceOf(LightsAuthenticationError);
    await expect(client.set({ light: "desk", on: true })).rejects.toBeInstanceOf(
      LightsAuthenticationError,
    );
    expect(fake.counts()).toEqual({ handshakes: 1, requests: 0 });
  });

  it.each(["http", "code"] as const)("renews the session once after %s expiry", async (expire) => {
    const fake = await bulb({ expire });
    const client = new TapoClient({ host: fake.host, credentials });
    await expect(client.state()).resolves.toMatchObject({ on: true });
    expect(fake.counts()).toEqual({ handshakes: 2, requests: 2 });
    expect(fake.failures).toEqual([]);
  });

  it("bounds session recovery to one retry", async () => {
    const fake = await bulb({ expire: "always" });
    const client = new TapoClient({ host: fake.host, credentials });
    await expect(client.state()).rejects.toThrow(/session|403/i);
    expect(fake.counts()).toEqual({ handshakes: 2, requests: 2 });
    expect(fake.failures).toEqual([]);
  });

  it("rejects a forged response before decrypting it", async () => {
    const fake = await bulb({ corrupt: true });
    const client = new TapoClient({ host: fake.host, credentials });
    await expect(client.state()).rejects.toThrow(/signature/i);
    expect(fake.counts()).toEqual({ handshakes: 1, requests: 1 });
  });

  it("maps colour mode without a white temperature", async () => {
    const fake = await bulb({
      response: {
        error_code: 0,
        result: { device_on: false, brightness: 1, hue: 360, saturation: 100, color_temp: 0 },
      },
    });
    const client = new TapoClient({ host: fake.host, credentials });
    expect(await client.state()).toEqual({
      online: true,
      on: false,
      brightness: 1,
      hue: 360,
      saturation: 100,
      mode: "colour",
    });
  });

  it("aborts a stalled response body within the bounded request timeout", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const bounded = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => timeout(Math.min(ms, 100)));
    const fake = await bulb({ stallBody: true });
    const client = new TapoClient({ host: fake.host, credentials });
    await expect(client.state()).rejects.toThrow(/abort|timeout/i);
    expect(bounded).toHaveBeenCalledWith(10_000);
    expect(fake.counts()).toEqual({ handshakes: 1, requests: 1 });
  });

  it.each([-1501, -20651])("latches a device authentication error %s", async (code) => {
    const fake = await bulb({ response: { error_code: code } });
    const client = new TapoClient({ host: fake.host, credentials });
    await expect(client.state()).rejects.toBeInstanceOf(LightsAuthenticationError);
    await expect(client.state()).rejects.toBeInstanceOf(LightsAuthenticationError);
    expect(fake.counts()).toEqual({ handshakes: 1, requests: 1 });
  });

  it.each([
    { plaintext: "invalid JSON" },
    { response: { error_code: "0", result: {} } },
    { response: { error_code: 0, result: { device_on: "yes", brightness: 101 } } },
    { response: { error_code: -1008 } },
  ])("rejects malformed data and device errors without retry", async (options) => {
    const fake = await bulb(options);
    const client = new TapoClient({ host: fake.host, credentials });
    await expect(client.state()).rejects.toThrow();
    expect(fake.counts()).toEqual({ handshakes: 1, requests: 1 });
  });
});
