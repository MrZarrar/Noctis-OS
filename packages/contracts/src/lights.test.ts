import { describe, expect, it } from "vitest";

import {
  CAPABILITY_CONTRACTS,
  CAPABILITY_OPERATION_CLASS,
  LightChangeSchema,
  LightsConfigSchema,
  LightsSetPayloadSchema,
  NodeCapabilitySchema,
} from "./index.js";

describe("lights contracts", () => {
  it("are node capabilities with fixed operation classes", () => {
    expect(NodeCapabilitySchema.parse("lights.state")).toBe("lights.state");
    expect(CAPABILITY_OPERATION_CLASS["lights.state"]).toBe("read_inspect");
    expect(CAPABILITY_OPERATION_CLASS["lights.set"]).toBe("local_reversible_edit");
    expect(CAPABILITY_CONTRACTS["lights.set"].payload).toBe(LightsSetPayloadSchema);
  });

  it("accepts a change with something to change and refuses an empty one", () => {
    expect(LightChangeSchema.parse({ light: "Lamp", on: true, brightness: 40 })).toEqual({
      light: "Lamp",
      on: true,
      brightness: 40,
    });
    expect(LightChangeSchema.safeParse({ light: "Lamp" }).success).toBe(false);
  });

  it("needs hue and saturation together, and never colour with a white temperature", () => {
    expect(LightChangeSchema.safeParse({ light: "Lamp", hue: 20 }).success).toBe(false);
    expect(
      LightChangeSchema.safeParse({ light: "Lamp", hue: 20, saturation: 80, colorTempK: 3000 })
        .success,
    ).toBe(false);
    expect(LightChangeSchema.safeParse({ light: "Lamp", hue: 20, saturation: 80 }).success).toBe(
      true,
    );
  });

  it("sets either a list of changes or one named scene", () => {
    expect(LightsSetPayloadSchema.safeParse({ scene: "cinema" }).success).toBe(true);
    expect(
      LightsSetPayloadSchema.safeParse({ scene: "cinema", changes: [{ light: "Lamp", on: true }] })
        .success,
    ).toBe(false);
    expect(LightsSetPayloadSchema.safeParse({}).success).toBe(false);
  });

  it("reads a node's lights.json with no secrets in it", () => {
    const config = LightsConfigSchema.parse({
      lights: [
        { name: "Main Light", kind: "tuya", id: "80157022e09806022865" },
        { name: "Lamp", kind: "tapo", host: "192.168.1.138" },
      ],
      scenes: { cinema: [{ light: "Main Light", on: false }] },
    });
    expect(config.tuyaEndpoint).toBe("https://openapi.tuyaeu.com");
    expect(config.agents).toBe(false);
    expect(
      LightsConfigSchema.safeParse({
        lights: [{ name: "Lamp", kind: "tapo", host: "x", password: "nope" }],
      }).success,
    ).toBe(false);
  });
});
