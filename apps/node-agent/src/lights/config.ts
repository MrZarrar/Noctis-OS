import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { LightsConfigSchema, type LightsConfig } from "@noctis/contracts";

import { AdapterRefused } from "../runtimes/Runtime.js";

export function lightsConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.NOCTIS_NODE_HOME?.trim() || join(homedir(), ".noctis"), "lights.json");
}

export function readLightsConfig(env: NodeJS.ProcessEnv = process.env): LightsConfig {
  let content: string;
  try {
    content = readFileSync(lightsConfigPath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new AdapterRefused("no lights.json on this PC");
    throw new AdapterRefused("could not read lights.json");
  }
  try {
    const config = LightsConfigSchema.parse(JSON.parse(content));
    if (new Set(config.lights.map((light) => light.name)).size !== config.lights.length)
      throw new Error("duplicate names");
    return config;
  } catch {
    // Schema errors can include values from a mistakenly pasted login.
    throw new AdapterRefused("invalid lights.json");
  }
}

export function lightsAgentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return readLightsConfig(env).agents;
  } catch {
    return false;
  }
}
