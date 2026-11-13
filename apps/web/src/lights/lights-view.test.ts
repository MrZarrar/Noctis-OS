import { describe, expect, it } from "vitest";

import { lightColour, sceneLabel } from "./lights-view.js";

describe("lightColour", () => {
  it("is dark for a light that is off or unreachable", () => {
    expect(lightColour({ name: "Lamp", kind: "tapo", online: true, on: false })).toBeUndefined();
    expect(lightColour({ name: "Lamp", kind: "tapo", online: false, on: true })).toBeUndefined();
  });

  it("shows a colour bulb in its own hue", () => {
    expect(
      lightColour({
        name: "Lamp",
        kind: "tapo",
        online: true,
        on: true,
        mode: "colour",
        hue: 120,
        saturation: 100,
      }),
    ).toBe("hsl(120 100% 55%)");
  });

  it("runs white from candle orange to daylight blue", () => {
    const warm = lightColour({ name: "A", kind: "tuya", online: true, on: true, colorTempK: 2500 });
    const cool = lightColour({ name: "A", kind: "tuya", online: true, on: true, colorTempK: 6500 });
    expect(warm).toBe("rgb(255 180 107)");
    expect(cool).toBe("rgb(219 232 255)");
  });
});

describe("sceneLabel", () => {
  it("turns a scene id into words", () => {
    expect(sceneLabel("cinema")).toBe("Cinema");
    expect(sceneLabel("late-night")).toBe("Late night");
  });
});
