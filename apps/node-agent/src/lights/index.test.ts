import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LightsEvidenceSchema } from "@noctis/contracts";
import { afterEach, expect, it } from "vitest";

import type { AdapterContext } from "../adapters.js";
import { createLightsAdapters, createLightsService, type LightDriver } from "./index.js";
import { LightsAuthenticationError } from "./secrets.js";

const homes: string[] = [];
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup(driver: (name: string) => LightDriver) {
  const home = mkdtempSync(join(tmpdir(), "noctis-lights-jobs-"));
  homes.push(home);
  writeFileSync(
    join(home, "lights.json"),
    JSON.stringify({
      lights: [
        { name: "desk", kind: "tuya", id: "a" },
        { name: "floor", kind: "tuya", id: "b" },
        { name: "bed", kind: "tapo", host: "127.0.0.1" },
      ],
      scenes: {
        evening: [
          { light: "desk", on: true },
          { light: "bed", brightness: 30 },
        ],
      },
    }),
  );
  const options = {
    env: { NOCTIS_NODE_HOME: home },
    client: (light: { name: string }) => driver(light.name),
  };
  return { options, service: createLightsService(options) };
}
const context = (capability: "lights.state" | "lights.set"): AdapterContext => ({
  signal: new AbortController().signal,
  grants: [
    {
      capability,
      id: "grant",
      nodeId: "node",
      operationClass: capability === "lights.state" ? "read_inspect" : "local_reversible_edit",
      constraintsVersion: 1,
      constraints: {},
      grantedAt: "2026-11-13T10:00:00Z",
    },
  ],
  env: {},
  runtimes: {},
  progress: () => undefined,
  stream: () => undefined,
  delta: () => undefined,
  ask: () => Promise.reject(new Error("unexpected ask")),
  fetchAttachment: () => Promise.reject(new Error("unexpected attachment")),
  delegate: () => Promise.reject(new Error("unexpected delegation")),
  uploadOutput: () => Promise.reject(new Error("unexpected upload")),
  streamFile: () => Promise.resolve(),
  streamScreen: () => Promise.resolve(),
});

it("applies scenes and answers with every light and scene name", async () => {
  const on: Record<string, boolean> = {};
  const { service } = setup((name) => ({
    state: () => Promise.resolve({ online: true, on: on[name] ?? false }),
    set: (change) => {
      on[name] = change.on ?? true;
      return Promise.resolve();
    },
  }));
  const evidence = LightsEvidenceSchema.parse(await service.set({ scene: "evening" }));
  expect(evidence.scenes).toEqual(["evening"]);
  expect(evidence.lights.map((light) => [light.name, light.on])).toEqual([
    ["desk", true],
    ["floor", false],
    ["bed", true],
  ]);
});

it("validates all targets before changing anything and refuses unknown scenes", async () => {
  let writes = 0;
  const { service } = setup(() => ({
    state: () => Promise.resolve({ online: true }),
    set: () => {
      writes++;
      return Promise.resolve();
    },
  }));
  await expect(
    service.set({
      changes: [
        { light: "desk", on: true },
        { light: "unknown", on: true },
      ],
    }),
  ).rejects.toThrow("unknown light");
  await expect(service.set({ scene: "missing" })).rejects.toThrow("unknown scene");
  expect(writes).toBe(0);
});

it("continues other lights after failures and blocks a brand after a wrong login", async () => {
  const writes: string[] = [];
  const { service } = setup((name) => ({
    state: () => Promise.resolve({ online: true }),
    set: () => {
      writes.push(name);
      return name === "desk"
        ? Promise.reject(new LightsAuthenticationError("password=private"))
        : Promise.resolve();
    },
  }));
  const evidence = await service.set({
    changes: [
      { light: "desk", on: true },
      { light: "floor", on: true },
      { light: "bed", on: true },
    ],
  });
  expect(writes).toEqual(["desk", "bed"]);
  expect(evidence.lights[0]?.error).toContain("login refused");
  expect(evidence.lights[1]?.error).toContain("login refused");
  expect(JSON.stringify(evidence)).not.toContain("private");
  await service.state();
  await service.set({ changes: [{ light: "floor", on: true }] });
  expect(writes).toEqual(["desk", "bed"]);
});

it("serializes concurrent jobs across service instances using the same node home", async () => {
  const events: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { options, service } = setup(() => ({
    state: () => Promise.resolve({ online: true }),
    set: async (change) => {
      events.push(`start:${String(change.on)}`);
      if (change.on) {
        entered();
        await wait;
      }
      events.push(`end:${String(change.on)}`);
    },
  }));
  const first = service.set({ changes: [{ light: "desk", on: true }] });
  await started;
  const second = createLightsService(options).set({ changes: [{ light: "desk", on: false }] });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(["start:true"]);
  } finally {
    release();
  }
  await Promise.all([first, second]);
  expect(events).toEqual(["start:true", "end:true", "start:false", "end:false"]);
});

it("requires a current capability grant and refuses cancelled adapter jobs", async () => {
  let writes = 0;
  const { options } = setup(() => ({
    state: () => Promise.resolve({ online: true }),
    set: () => {
      writes++;
      return Promise.resolve();
    },
  }));
  const adapters = createLightsAdapters(options);
  await expect(
    adapters["lights.set"]({ scene: "evening" }, context("lights.state")),
  ).rejects.toThrow("no lights.set grant");
  const ctx = context("lights.set");
  ctx.signal = AbortSignal.abort();
  await expect(adapters["lights.set"]({ scene: "evening" }, ctx)).rejects.toThrow("cancelled");
  expect(writes).toBe(0);
  expect(
    LightsEvidenceSchema.parse(await adapters["lights.state"]({}, context("lights.state"))).lights,
  ).toHaveLength(3);
});

it("shares authentication refusal between MCP services in a node lifetime and resets on a new lifetime", async () => {
  const writes: string[] = [];
  const { options } = setup((name) => ({
    state: () => Promise.resolve({ online: true }),
    set: () => {
      writes.push(name);
      return name === "desk"
        ? Promise.reject(new LightsAuthenticationError("wrong login"))
        : Promise.resolve();
    },
  }));
  const session = { ...options, env: { ...options.env, NOCTIS_LIGHTS_SESSION: "node-one" } };
  await createLightsService(session).set({ changes: [{ light: "desk", on: true }] });
  const evidence = await createLightsService(session).set({
    changes: [
      { light: "floor", on: true },
      { light: "bed", on: true },
    ],
  });
  expect(writes).toEqual(["desk", "bed"]);
  expect(evidence.lights[1]?.error).toContain("login refused");
  await createLightsService({
    ...options,
    env: { ...options.env, NOCTIS_LIGHTS_SESSION: "node-two" },
  }).set({ changes: [{ light: "floor", on: true }] });
  expect(writes).toEqual(["desk", "bed", "floor"]);
});

it("keeps other lights' evidence when one device returns invalid state", async () => {
  const { service } = setup((name) => ({
    state: () =>
      Promise.resolve(name === "desk" ? { online: true, brightness: NaN } : { online: true }),
    set: () => Promise.resolve(),
  }));
  const evidence = await service.state();
  expect(evidence.lights[0]?.error).toBeDefined();
  expect(evidence.lights.slice(1).map((light) => light.online)).toEqual([true, true]);
});
