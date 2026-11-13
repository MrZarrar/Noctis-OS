import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { request as httpRequest } from "node:http";

import type { LightChange, LightState } from "@noctis/contracts";
import { z } from "zod";

import { LightsAuthenticationError } from "./secrets.js";

const DeviceInfo = z.object({
  device_on: z.boolean(),
  brightness: z.int().min(1).max(100),
  hue: z.int().min(0).max(360),
  saturation: z.int().min(0).max(100),
  color_temp: z.union([z.literal(0), z.int().min(2500).max(6500)]),
});
const Reply = z.object({ error_code: z.int(), result: z.unknown().optional() });
const hash = (...parts: (Buffer | string)[]) => {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return digest.digest();
};

interface Session {
  cookie: string;
  key: Buffer;
  ivPrefix: Buffer;
  signature: Buffer;
  sequence: number;
}

class SessionExpired extends Error {}

export class TapoClient {
  private session: Session | undefined;
  private authenticationError: LightsAuthenticationError | undefined;
  private readonly requestFetch: typeof fetch | undefined;

  constructor(
    private readonly options: {
      host: string;
      credentials: () => Promise<{ username: string; password: string }>;
      fetch?: typeof fetch;
    },
  ) {
    this.requestFetch = options.fetch;
  }

  async state(): Promise<Omit<LightState, "name" | "kind">> {
    const info = DeviceInfo.parse(await this.request({ method: "get_device_info" }));
    return {
      online: true,
      on: info.device_on,
      brightness: info.brightness,
      mode: info.color_temp === 0 ? "colour" : "white",
      ...(info.color_temp === 0 ? {} : { colorTempK: info.color_temp }),
      hue: info.hue,
      saturation: info.saturation,
    };
  }

  async set(change: LightChange): Promise<void> {
    const params: Record<string, boolean | number> = {};
    if (change.on !== undefined) params.device_on = change.on;
    if (change.brightness !== undefined) params.brightness = change.brightness;
    if (change.colorTempK !== undefined) params.color_temp = change.colorTempK;
    if (change.hue !== undefined) {
      params.hue = change.hue;
      params.saturation = change.saturation!;
      params.color_temp = 0;
    }
    await this.request({ method: "set_device_info", params });
  }

  private async post(path: string, body: Buffer, cookie?: string): Promise<Response> {
    if (this.requestFetch === undefined) return bulbPost(this.options.host, path, body, cookie);
    return this.requestFetch(`http://${this.options.host}/app/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  }

  private async handshake(): Promise<Session> {
    const { username, password } = await this.options.credentials();
    const auth = hash(
      createHash("sha1").update(username).digest(),
      createHash("sha1").update(password).digest(),
    );
    const local = randomBytes(16);
    const first = await this.post("handshake1", local);
    if (!first.ok) throw new Error(`Tapo handshake failed (HTTP ${first.status})`);
    const body = Buffer.from(await first.arrayBuffer());
    if (body.length !== 48) throw new Error("Invalid Tapo handshake response");
    const remote = body.subarray(0, 16);
    if (!timingSafeEqual(body.subarray(16), hash(local, remote, auth))) {
      this.authenticationError = new LightsAuthenticationError(
        "Tapo login refused; restart the node after correcting the saved login",
      );
      throw this.authenticationError;
    }
    const cookie = first.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .find((value) => value?.startsWith("TP_SESSIONID="));
    if (!cookie) throw new Error("Tapo session cookie missing");
    const second = await this.post("handshake2", hash(remote, local, auth), cookie);
    if (!second.ok) throw new Error(`Tapo handshake failed (HTTP ${second.status})`);
    await second.arrayBuffer();
    const iv = hash("iv", local, remote, auth);
    return {
      cookie,
      key: hash("lsk", local, remote, auth).subarray(0, 16),
      ivPrefix: iv.subarray(0, 12),
      signature: hash("ldk", local, remote, auth).subarray(0, 28),
      sequence: iv.readInt32BE(28),
    };
  }

  private async request(payload: unknown): Promise<unknown> {
    if (this.authenticationError) throw this.authenticationError;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(payload);
      } catch (error) {
        if (!(error instanceof SessionExpired)) throw error;
        this.session = undefined;
        if (attempt >= 1) throw error;
      }
    }
  }

  private async requestOnce(payload: unknown): Promise<unknown> {
    const session = this.session ?? (this.session = await this.handshake());
    session.sequence = (session.sequence + 1) | 0;
    const seq = Buffer.alloc(4);
    seq.writeInt32BE(session.sequence);
    const iv = Buffer.concat([session.ivPrefix, seq]);
    const cipher = createCipheriv("aes-128-cbc", session.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    const response = await this.post(
      `request?seq=${session.sequence}`,
      Buffer.concat([hash(session.signature, seq, encrypted), encrypted]),
      session.cookie,
    );
    if (response.status === 403) {
      await response.body?.cancel();
      throw new SessionExpired("Tapo session expired (HTTP 403)");
    }
    if (!response.ok) throw new Error(`Tapo request failed (HTTP ${response.status})`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length < 48 || (body.length - 32) % 16 !== 0)
      throw new Error("Invalid Tapo response length");
    if (!timingSafeEqual(body.subarray(0, 32), hash(session.signature, seq, body.subarray(32)))) {
      throw new Error("Invalid Tapo response signature");
    }
    const decipher = createDecipheriv("aes-128-cbc", session.key, iv);
    const decoded = Buffer.concat([
      decipher.update(body.subarray(32)),
      decipher.final(),
    ]).toString();
    const reply = Reply.parse(JSON.parse(decoded));
    if (reply.error_code === 9999 || reply.error_code === -1001)
      throw new SessionExpired("Tapo session expired");
    if (reply.error_code === -1501 || reply.error_code === -20651) {
      this.authenticationError = new LightsAuthenticationError(
        "Tapo login refused; restart the node after correcting the saved login",
      );
      throw this.authenticationError;
    }
    if (reply.error_code !== 0) throw new Error(`Tapo device error ${reply.error_code}`);
    return reply.result;
  }
}

/**
 * The L530E's web server answers Node's fetch (undici) with HTTP 400 even for
 * the same headers, and a plain node:http request with 200 (measured
 * 2026-11-13, firmware 1.4.4), so the bulb gets the plain one.
 */
function bulbPost(host: string, path: string, body: Buffer, cookie?: string): Promise<Response> {
  const at = new URL(`http://${host}`);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: at.hostname,
        port: at.port === "" ? 80 : Number(at.port),
        path: `/app/${path}`,
        method: "POST",
        // The whole exchange, body included: a bulb that stalls mid-reply is let go.
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": body.length,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value])
              headers.append(name, one);
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, headers }));
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
