import { afterEach, describe, expect, it } from "vitest";

import { resolveSurface } from "../surfaces/registry.js";
import { drift, hardwareBusy, setHardwareLoad } from "./hardware.js";

afterEach(() => {
  setHardwareLoad(false);
});

describe("the Hardware panel's readings", () => {
  it("climb toward the load target over several samples, not in one jump", () => {
    const still = (): number => 0.5;
    let sample = { cpu: 10, ram: 40, gpu: 5, vram: 20 };
    const target = { cpu: 90, ram: 70, gpu: 95, vram: 80 };

    const first = drift(sample, target, still);
    expect(first.cpu).toBeGreaterThan(10);
    expect(first.cpu).toBeLessThan(40);

    for (let step = 0; step < 30; step += 1) sample = drift(sample, target, still);
    expect(sample.cpu).toBeCloseTo(90, 0);
  });

  it("stay between 0 and 100 whatever the noise", () => {
    const loud = (): number => 1;
    const sample = drift(
      { cpu: 99, ram: 99, gpu: 99, vram: 99 },
      { cpu: 100, ram: 100, gpu: 100, vram: 100 },
      loud,
    );

    expect(Math.max(sample.cpu, sample.ram, sample.gpu, sample.vram)).toBeLessThanOrEqual(100);
  });

  it("switch between idle and busy", () => {
    setHardwareLoad(true);
    expect(hardwareBusy()).toBe(true);
  });

  it("render as a registered panel kind", () => {
    expect(resolveSurface("hardware", 1, {}, "standard").status).toBe("ok");
  });
});
