import { createHash, createHmac } from "node:crypto";

import { LightChangeSchema, type LightChange, type LightState } from "@noctis/contracts";

import { LightsAuthenticationError } from "./secrets.js";

type Options = {
  endpoint: string;
  credentials: () => Promise<{ username: string; password: string }>;
  fetch?: typeof fetch;
  now?: () => number;
};

type ObjectValue = Record<string, unknown>;
type Range = { min: number; max: number };
type FunctionSpec = { code: string; values: ObjectValue };
type Functions = Map<string, FunctionSpec>;
type Status = Map<string, unknown>;

function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tuya response invalid");
  }
  return value as ObjectValue;
}

function json(value: unknown): ObjectValue {
  try {
    return object(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    throw new Error("Tuya response invalid");
  }
}

function range(value: unknown, fallback: Range): Range {
  if (value === undefined) return fallback;
  const data = object(value);
  if (data.min === undefined && data.max === undefined) return fallback;
  if (
    typeof data.min !== "number" ||
    typeof data.max !== "number" ||
    !Number.isFinite(data.min) ||
    !Number.isFinite(data.max) ||
    data.min < 0 ||
    data.max <= data.min
  ) {
    throw new Error("Tuya response invalid");
  }
  return { min: data.min, max: data.max };
}

function choose(functions: Functions, base: string): FunctionSpec {
  const spec = functions.get(`${base}_v2`) ?? functions.get(base);
  if (!spec) throw new Error("Tuya light does not support this change");
  return spec;
}

function limits(spec: FunctionSpec, channel?: string): Range {
  const max = spec.code.endsWith("_v2") ? 1000 : 255;
  const fallback = { min: spec.code.startsWith("bright") ? (max === 1000 ? 10 : 25) : 0, max };
  return range(
    channel ? spec.values[channel] : spec.values,
    channel === "h" ? { min: 0, max: 360 } : fallback,
  );
}

function percent(raw: number, bounds: Range, minimum = 1): number {
  return Math.max(minimum, Math.min(100, Math.round((raw / bounds.max) * 100)));
}

function fromPercent(value: number, bounds: Range): number {
  return Math.max(bounds.min, Math.min(bounds.max, Math.round((value / 100) * bounds.max)));
}

class TuyaRefused extends Error {
  constructor(readonly code: number | undefined) {
    super(`Tuya request refused${code === undefined ? "" : ` (${code})`}`);
  }
}

export class TuyaClient {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly functions = new Map<string, Promise<Functions>>();
  private token: { value: string; expires: number } | undefined;
  private tokenPending: Promise<string> | undefined;
  private credentialsPending: ReturnType<Options["credentials"]> | undefined;
  private authFailure: LightsAuthenticationError | undefined;

  constructor(private readonly options: Options) {
    const endpoint = new URL(options.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Error("Tuya endpoint must be an HTTPS origin");
    }
    this.endpoint = endpoint.origin;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async state(id: string): Promise<Omit<LightState, "name" | "kind">> {
    this.checkLogin();
    const functions = await this.deviceFunctions(id);
    const status = await this.deviceStatus(id);
    const detail = object(await this.request(this.path(id)));
    if (typeof detail.online !== "boolean") throw new Error("Tuya response invalid");
    const state: Omit<LightState, "name" | "kind"> = { online: detail.online };
    const on = status.get("switch_led");
    const mode = status.get("work_mode");
    if (typeof on === "boolean") state.on = on;
    if (mode === "white" || mode === "colour") state.mode = mode;
    const brightness = functions.get("bright_value_v2") ?? functions.get("bright_value");
    const temperature = functions.get("temp_value_v2") ?? functions.get("temp_value");
    const colour = functions.get("colour_data_v2") ?? functions.get("colour_data");
    if (brightness && typeof status.get(brightness.code) === "number") {
      state.brightness = percent(status.get(brightness.code) as number, limits(brightness));
    }
    if (temperature && typeof status.get(temperature.code) === "number") {
      const bounds = limits(temperature);
      const raw = status.get(temperature.code) as number;
      state.colorTempK = Math.round(
        2500 + Math.max(0, Math.min(1, (raw - bounds.min) / (bounds.max - bounds.min))) * 4000,
      );
    }
    if (colour && status.has(colour.code)) {
      const hsv = json(status.get(colour.code));
      if (typeof hsv.h === "number" && Number.isFinite(hsv.h))
        state.hue = Math.max(0, Math.min(360, Math.round((hsv.h / limits(colour, "h").max) * 360)));
      if (typeof hsv.s === "number" && Number.isFinite(hsv.s))
        state.saturation = percent(hsv.s, limits(colour, "s"), 0);
      if (mode === "colour" && typeof hsv.v === "number" && Number.isFinite(hsv.v))
        state.brightness = percent(hsv.v, limits(colour, "v"));
    }
    return state;
  }

  async set(id: string, change: LightChange): Promise<void> {
    this.checkLogin();
    LightChangeSchema.parse(change);
    const functions = await this.deviceFunctions(id);
    const commands: { code: string; value: unknown }[] = [];
    const append = (code: string, value: unknown) => {
      if (!functions.has(code)) throw new Error("Tuya light does not support this change");
      commands.push({ code, value });
    };
    if (change.on !== undefined) append("switch_led", change.on);
    const status =
      (change.brightness !== undefined &&
        change.colorTempK === undefined &&
        change.hue === undefined) ||
      (change.hue !== undefined && change.brightness === undefined)
        ? await this.deviceStatus(id)
        : new Map<string, unknown>();
    const colourMode =
      change.hue !== undefined ||
      (change.colorTempK === undefined && status.get("work_mode") === "colour");
    if (change.colorTempK !== undefined) {
      const spec = choose(functions, "temp_value");
      const bounds = limits(spec);
      append("work_mode", "white");
      append(
        spec.code,
        Math.round(bounds.min + ((change.colorTempK - 2500) / 4000) * (bounds.max - bounds.min)),
      );
    }
    if (colourMode) {
      const spec = choose(functions, "colour_data");
      const existing = status.has(spec.code) ? json(status.get(spec.code)) : {};
      const h =
        change.hue === undefined
          ? existing.h
          : Math.round((change.hue / 360) * limits(spec, "h").max);
      const s =
        change.saturation === undefined
          ? existing.s
          : fromPercent(change.saturation, limits(spec, "s"));
      const v =
        change.brightness === undefined
          ? existing.v
          : fromPercent(change.brightness, limits(spec, "v"));
      if (![h, s, v].every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error("Tuya response invalid");
      }
      if (change.hue !== undefined) append("work_mode", "colour");
      append(spec.code, JSON.stringify({ h, s, v }));
    } else if (change.brightness !== undefined) {
      const spec = choose(functions, "bright_value");
      append(spec.code, fromPercent(change.brightness, limits(spec)));
    }
    const result = await this.request(
      `${this.path(id)}/commands`,
      "POST",
      JSON.stringify({ commands }),
    );
    if (result !== true) throw new Error("Tuya command refused");
  }

  private checkLogin(): void {
    if (this.authFailure) throw this.authFailure;
  }

  private path(id: string): string {
    if (!id || id.length > 64) throw new Error("Tuya device ID invalid");
    return `/v1.0/iot-03/devices/${encodeURIComponent(id)}`;
  }

  private async deviceFunctions(id: string): Promise<Functions> {
    let pending = this.functions.get(id);
    if (!pending) {
      pending = this.request(`${this.path(id)}/functions`).then((result) => {
        const entries = object(result).functions;
        if (!Array.isArray(entries)) throw new Error("Tuya response invalid");
        const functions: Functions = new Map();
        for (const entry of entries) {
          const spec = object(entry);
          if (typeof spec.code !== "string") throw new Error("Tuya response invalid");
          functions.set(spec.code, { code: spec.code, values: json(spec.values ?? {}) });
        }
        return functions;
      });
      this.functions.set(id, pending);
    }
    try {
      return await pending;
    } catch (error) {
      this.functions.delete(id);
      throw error;
    }
  }

  private async deviceStatus(id: string): Promise<Status> {
    const result = await this.request(`${this.path(id)}/status`);
    if (!Array.isArray(result)) throw new Error("Tuya response invalid");
    const status: Status = new Map();
    for (const item of result) {
      const entry = object(item);
      if (typeof entry.code !== "string") throw new Error("Tuya response invalid");
      status.set(entry.code, entry.value);
    }
    return status;
  }

  private async accessToken(): Promise<string> {
    this.checkLogin();
    if (this.token && this.now() < this.token.expires) return this.token.value;
    if (!this.tokenPending) {
      this.tokenPending = (async () => {
        const token = object(await this.raw("/v1.0/token?grant_type=1", "GET", "", ""));
        if (
          typeof token.access_token !== "string" ||
          !token.access_token ||
          typeof token.expire_time !== "number" ||
          !Number.isFinite(token.expire_time) ||
          token.expire_time <= 0
        ) {
          throw new Error("Tuya response invalid");
        }
        this.token = {
          value: token.access_token,
          expires: this.now() + (token.expire_time - Math.min(30, token.expire_time / 2)) * 1000,
        };
        return token.access_token;
      })();
    }
    try {
      return await this.tokenPending;
    } finally {
      this.tokenPending = undefined;
    }
  }

  private async request(path: string, method = "GET", body = ""): Promise<unknown> {
    const token = await this.accessToken();
    try {
      return await this.raw(path, method, body, token);
    } catch (error) {
      if (!(error instanceof TuyaRefused) || (error.code !== 1010 && error.code !== 1011))
        throw error;
      if (this.token?.value === token) this.token = undefined;
      return this.raw(path, method, body, await this.accessToken());
    }
  }

  private async raw(path: string, method: string, body: string, token: string): Promise<unknown> {
    this.checkLogin();
    let login: Awaited<ReturnType<Options["credentials"]>>;
    try {
      this.credentialsPending ??= this.options.credentials();
      login = await this.credentialsPending;
    } catch (error) {
      if (error instanceof LightsAuthenticationError) {
        this.authFailure = error;
        throw error;
      }
      // eslint-disable-next-line preserve-caught-error -- Credential errors can contain secrets.
      throw new Error("Tuya credentials unavailable");
    }
    this.checkLogin();
    const t = String(this.now());
    const digest = createHash("sha256").update(body).digest("hex");
    const stringToSign = `${method}\n${digest}\n\n${path}`;
    const sign = createHmac("sha256", login.password)
      .update(login.username + token + t + stringToSign)
      .digest("hex")
      .toUpperCase();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    timer.unref();
    let data: unknown;
    try {
      const response = await this.fetcher(this.endpoint + path, {
        method,
        headers: {
          client_id: login.username,
          sign,
          t,
          sign_method: "HMAC-SHA256",
          access_token: token,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403) {
        this.authFailure = new LightsAuthenticationError(
          "Tuya login refused; restart the node after fixing credentials",
        );
        throw this.authFailure;
      }
      if (!response.ok) throw new Error("Tuya request failed");
      data = await response.json();
    } catch (error) {
      if (error instanceof LightsAuthenticationError) throw error;
      // eslint-disable-next-line preserve-caught-error -- Provider errors can contain tokens and secrets.
      throw new Error(controller.signal.aborted ? "Tuya request timed out" : "Tuya request failed");
    } finally {
      clearTimeout(timer);
    }
    const envelope = object(data);
    if (envelope.success !== true) {
      const numericCode =
        typeof envelope.code === "string" && /^\d{1,8}$/.test(envelope.code)
          ? Number(envelope.code)
          : envelope.code;
      const code =
        typeof numericCode === "number" && Number.isSafeInteger(numericCode)
          ? numericCode
          : undefined;
      if (code !== undefined && [1004, 1005, 1013, 1014].includes(code)) {
        this.authFailure = new LightsAuthenticationError(
          "Tuya login refused; restart the node after fixing credentials",
        );
        throw this.authFailure;
      }
      throw new TuyaRefused(code);
    }
    return envelope.result;
  }
}
