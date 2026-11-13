import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { lightsAgentsEnabled, readLightsConfig } from "./config.js";
import { createSecretsReader } from "./secrets.js";

const homes: string[] = [];
function home() {
  const path = mkdtempSync(join(tmpdir(), "noctis-lights-config-"));
  homes.push(path);
  return path;
}
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("refuses a missing config and leaves agent tools disabled", () => {
  const env = { NOCTIS_NODE_HOME: home() };
  expect(() => readLightsConfig(env)).toThrow("no lights.json on this PC");
  expect(lightsAgentsEnabled(env)).toBe(false);
});

it("validates config, defaults agent access off and refuses inline secrets", () => {
  const path = home();
  const env = { NOCTIS_NODE_HOME: path };
  const config = { lights: [{ name: "desk", kind: "tapo", host: "192.168.1.2" }] };
  writeFileSync(join(path, "lights.json"), JSON.stringify(config));
  expect(readLightsConfig(env).agents).toBe(false);
  writeFileSync(join(path, "lights.json"), JSON.stringify({ ...config, agents: true }));
  expect(lightsAgentsEnabled(env)).toBe(true);
  writeFileSync(join(path, "lights.json"), JSON.stringify({ ...config, password: "secret" }));
  expect(() => readLightsConfig(env)).toThrow("invalid lights.json");
  expect(lightsAgentsEnabled(env)).toBe(false);
});

it("reads protected secret overrides once and keeps the default paths on this PC", async () => {
  const calls: string[] = [];
  const reader = createSecretsReader({
    env: { LOCALAPPDATA: "C:/local" },
    read: (path) => {
      calls.push(path);
      return Promise.resolve({ username: "user", password: "private" });
    },
  });
  const config = { secrets: { tuya: "C:/owner's secrets/tuya.xml" } };
  expect(await reader("tuya", config)).toEqual({ username: "user", password: "private" });
  await reader("tuya", config);
  await reader("tapo", config);
  expect(calls).toEqual([
    "C:/owner's secrets/tuya.xml",
    join("C:/local", "noctis-secrets", "tapo.xml"),
  ]);
});

it("sanitizes failures from the protected reader and caches rejected reads", async () => {
  let reads = 0;
  const reader = createSecretsReader({
    env: { LOCALAPPDATA: "C:/local" },
    read: () => {
      reads++;
      return Promise.reject(new Error("user private password"));
    },
  });
  await expect(reader("tuya", { secrets: {} })).rejects.toThrow(
    "could not read protected tuya login",
  );
  await expect(reader("tuya", { secrets: {} })).rejects.not.toThrow("private");
  expect(reads).toBe(1);
});
