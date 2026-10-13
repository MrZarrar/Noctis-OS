import { describe, expect, it } from "vitest";
import {
  clampShares,
  readGeometry,
  writeGeometry,
  geometryKey,
  dropTarget,
  supportedRegions,
  swapPlacements,
} from "./arrange.js";

describe("manual panel arrangement", () => {
  it("swaps actual slots and order while retaining each panel's own size", () => {
    const plan = {
      presence: true as const,
      layoutId: "canvas.split",
      displayFingerprint: "display",
      generatedAt: "2026-10-13T00:00:00.000Z",
      reasonCodes: [],
      overflowSurfaceIds: [],
      slots: [
        { surfaceId: "a", region: "right" as const, order: 0, size: "standard" as const, layer: 0 },
        { surfaceId: "b", region: "right" as const, order: 1, size: "wide" as const, layer: 0 },
      ],
    };
    expect(swapPlacements(plan, "a", "b")).toEqual([
      { surfaceId: "a", region: "right", order: 1, size: "standard" },
      { surfaceId: "b", region: "right", order: 0, size: "wide" },
    ]);
    expect(swapPlacements(plan, "a", "missing")).toBeUndefined();
    expect(swapPlacements(plan, "a", "a")).toBeUndefined();
  });
  it("only offers regions supported by the committed layout", () => {
    expect(supportedRegions("canvas.split", "standard")).toEqual([
      "centre",
      "right",
      "bottom",
      "overflow",
    ]);
    expect(supportedRegions("focus.stage", "standard")).toEqual(["centre", "bottom", "overflow"]);
    expect(dropTarget("left", "canvas.split", "standard")).toBeUndefined();
    expect(dropTarget("overflow", "canvas.split", "standard")).toBe("overflow");
  });
  it("bounds column shares by all panel minimums and total available room", () => {
    expect(clampShares([0.01, 0.99], [300, 400], 1000)).toEqual([0.3, 0.7]);
    expect(clampShares([0.99, 0.01], [300, 400], 1000)).toEqual([0.6, 0.4]);
    expect(clampShares([0.5, 0.5], [300, 400], 500)).toEqual([3 / 7, 4 / 7]);
  });
  it("rejects corrupt storage, separates owners and keeps old geometry after a refused save", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const key = geometryKey("client", "1920x1080@1", "thread:a");
    const geometry = { columns: { centre: 0.7, right: 0.3 }, bottom: 0.25 };
    expect(writeGeometry(storage, key, geometry)).toBe(true);
    expect(readGeometry(storage, key)).toEqual(geometry);
    expect(readGeometry(storage, geometryKey("client", "1920x1080@1", "thread:b"))).toBeUndefined();
    values.set(key, '{"columns":{"centre":-1},"bottom":2}');
    expect(readGeometry(storage, key)).toBeUndefined();
    expect(
      writeGeometry(
        {
          setItem: () => {
            throw new Error("blocked");
          },
        },
        key,
        geometry,
      ),
    ).toBe(false);
  });
});
