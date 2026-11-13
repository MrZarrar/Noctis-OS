import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createLightsTool, LightsToolInputSchema } from "./tool.js";

const homes: string[] = [];
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "noctis-lights-tool-"));
  homes.push(home);
  const env = { NOCTIS_NODE_HOME: home };
  return {
    home,
    env,
    save: (agents: boolean) =>
      writeFileSync(
        join(home, "lights.json"),
        JSON.stringify({ agents, lights: [{ name: "desk", kind: "tapo", host: "127.0.0.1" }] }),
      ),
  };
}

it("registers only with valid config and explicit agent access", () => {
  const { env, save } = setup();
  expect(createLightsTool({ env })).toBeUndefined();
  save(false);
  expect(createLightsTool({ env })).toBeUndefined();
  save(true);
  expect(createLightsTool({ env })).toBeDefined();
});

it("accepts read or exactly one write form and rejects extra fields", () => {
  for (const value of [{}, { scene: "evening" }, { changes: [{ light: "desk", on: true }] }])
    expect(LightsToolInputSchema.safeParse(value).success).toBe(true);
  for (const value of [
    { scene: "evening", changes: [{ light: "desk", on: true }] },
    { changes: [] },
    { password: "private" },
  ])
    expect(LightsToolInputSchema.safeParse(value).success).toBe(false);
});

it("rechecks the switch on each call and returns a safe tool error", async () => {
  const { env, save } = setup();
  save(true);
  const tool = createLightsTool({ env })!;
  save(false);
  const result = await tool.call({});
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("disabled");
});
