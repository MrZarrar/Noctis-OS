import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LightsEvidenceSchema,
  LightsSetPayloadSchema,
  LightsStatePayloadSchema,
  LightStateSchema,
  type LightChange,
  type LightsConfig,
  type LightsEvidence,
  type LightState,
} from "@noctis/contracts";

import type { Adapter } from "../adapters.js";
import { AdapterRefused } from "../runtimes/Runtime.js";
import { lightsConfigPath, readLightsConfig } from "./config.js";
import { createSecretsReader, LightsAuthenticationError, type SecretReader } from "./secrets.js";
import { withLightsLock } from "./lock.js";
import { TapoClient } from "./tapo.js";
import { TuyaClient } from "./tuya.js";

type ConfigLight = LightsConfig["lights"][number];
const PROCESS_SESSION = randomUUID();
export function lightsProcessSession(env: NodeJS.ProcessEnv = process.env): string {
  return env.NOCTIS_LIGHTS_SESSION || PROCESS_SESSION;
}
export interface LightDriver {
  state(): Promise<Omit<LightState, "name" | "kind">>;
  set(change: LightChange): Promise<void>;
}
export interface LightsOptions {
  env?: NodeJS.ProcessEnv;
  readSecret?: SecretReader;
  client?: (light: ConfigLight, config: LightsConfig) => LightDriver;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AdapterRefused("job was cancelled");
}

export function createLightsService(options: LightsOptions = {}) {
  const env = options.env ?? process.env;
  const secrets = createSecretsReader({
    env,
    ...(options.readSecret ? { read: options.readSecret } : {}),
  });
  const blocked = new Set<ConfigLight["kind"]>();
  const sessionKey = createHash("sha256")
    .update(lightsProcessSession(env))
    .digest("hex")
    .slice(0, 32);
  // Only refusal flags cross processes. Decrypted logins remain in each process's memory.
  const refusalPath = join(
    dirname(lightsConfigPath(env)),
    `lights-auth-refused-${sessionKey}.json`,
  );
  const drivers = new Map<string, LightDriver>();
  const tuyas = new Map<string, TuyaClient>();
  let tail: Promise<unknown> = Promise.resolve();
  const driver = (light: ConfigLight, config: LightsConfig): LightDriver => {
    const key = JSON.stringify([light, config.tuyaEndpoint, config.secrets]);
    let value = drivers.get(key);
    if (value) return value;
    if (options.client) value = options.client(light, config);
    else if (light.kind === "tapo")
      value = new TapoClient({ host: light.host, credentials: () => secrets("tapo", config) });
    else {
      const tuyaKey = JSON.stringify([config.tuyaEndpoint, config.secrets.tuya]);
      let tuya = tuyas.get(tuyaKey);
      if (!tuya) {
        tuya = new TuyaClient({
          endpoint: config.tuyaEndpoint,
          credentials: () => secrets("tuya", config),
        });
        tuyas.set(tuyaKey, tuya);
      }
      const client = tuya;
      value = {
        state: () => client.state(light.id),
        set: (change) => client.set(light.id, change),
      };
    }
    drivers.set(key, value);
    return value;
  };
  const failure = async (light: ConfigLight, error: unknown): Promise<string> => {
    if (error instanceof LightsAuthenticationError) {
      blocked.add(light.kind);
      try {
        await writeFile(refusalPath, JSON.stringify([...blocked]), { mode: 0o600 });
      } catch {
        throw new AdapterRefused("could not save lights authentication refusal");
      }
    }
    return blocked.has(light.kind)
      ? `${light.kind} login refused until the node process restarts`
      : `${light.kind}: ${error instanceof Error ? error.message : "could not read or change it"}`.slice(
          0,
          300,
        );
  };
  const job = (input?: unknown, signal?: AbortSignal): Promise<LightsEvidence> => {
    const run = async () => {
      cancelled(signal);
      const config = readLightsConfig(env);
      let changes: LightChange[] = [];
      if (input !== undefined) {
        const payload = LightsSetPayloadSchema.parse(input);
        if ("scene" in payload) {
          const scene = Object.hasOwn(config.scenes, payload.scene)
            ? config.scenes[payload.scene]
            : undefined;
          if (!scene) throw new AdapterRefused(`unknown scene ${payload.scene}`);
          changes = scene;
        } else changes = payload.changes;
        for (const change of changes) {
          if (!config.lights.some((light) => light.name === change.light))
            throw new AdapterRefused(`unknown light ${change.light}`);
        }
      }
      return withLightsLock(
        lightsConfigPath(env),
        async () => {
          try {
            const saved: unknown = JSON.parse(await readFile(refusalPath, "utf8"));
            if (
              !Array.isArray(saved) ||
              !saved.every((brand: unknown) => brand === "tuya" || brand === "tapo")
            )
              throw new Error("invalid refusal flags");
            for (const brand of saved as Array<ConfigLight["kind"]>) blocked.add(brand);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              throw new AdapterRefused("could not read lights authentication refusal");
          }
          const errors = new Map<string, string>();
          for (const change of changes) {
            cancelled(signal);
            const light = config.lights.find((entry) => entry.name === change.light)!;
            if (blocked.has(light.kind)) continue;
            try {
              await driver(light, config).set(change);
            } catch (error) {
              errors.set(light.name, await failure(light, error));
            }
          }
          const lights: LightState[] = [];
          cancelled(signal);
          // Every light at once: one slow bulb or cloud round trip no longer holds up the others.
          lights.push(
            ...(await Promise.all(
              config.lights.map(async (light) => {
                let state: LightState = { name: light.name, kind: light.kind, online: false };
                if (blocked.has(light.kind)) state.error = await failure(light, undefined);
                else {
                  try {
                    state = LightStateSchema.parse({
                      ...state,
                      ...(await driver(light, config).state()),
                    });
                  } catch (error) {
                    state.error = await failure(light, error);
                  }
                  if (errors.has(light.name)) state.error = errors.get(light.name)!;
                }
                return state;
              }),
            )),
          );
          return LightsEvidenceSchema.parse({ lights, scenes: Object.keys(config.scenes) });
        },
        signal,
      );
    };
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    state: (signal?: AbortSignal) => job(undefined, signal),
    set: (input: unknown, signal?: AbortSignal) => job(input, signal),
  };
}

const services = new Map<string, ReturnType<typeof createLightsService>>();
export function lightsService(env: NodeJS.ProcessEnv = process.env) {
  const key = JSON.stringify([lightsConfigPath(env), lightsProcessSession(env)]);
  let service = services.get(key);
  if (!service) {
    service = createLightsService({ env });
    services.set(key, service);
  }
  return service;
}

export function createLightsAdapters(
  options?: LightsOptions,
): Record<"lights.state" | "lights.set", Adapter> {
  const service = options ? createLightsService(options) : undefined;
  const adapter =
    (capability: "lights.state" | "lights.set"): Adapter =>
    async (payload, context) => {
      if (
        !context.grants.some(
          (grant) => grant.capability === capability && grant.revokedAt === undefined,
        )
      )
        throw new AdapterRefused(`no ${capability} grant`);
      cancelled(context.signal);
      const target = service ?? lightsService(context.env);
      if (capability === "lights.state") {
        LightsStatePayloadSchema.parse(payload);
        return target.state(context.signal);
      }
      return target.set(payload, context.signal);
    };
  return { "lights.state": adapter("lights.state"), "lights.set": adapter("lights.set") };
}
