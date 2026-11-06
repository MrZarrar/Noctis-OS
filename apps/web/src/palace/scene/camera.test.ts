import { describe, expect, it } from "vitest";

import { cameraTransform, coversViewport, minimumZoom } from "./camera.js";
import { ROOMS } from "./rooms.js";

describe("camera", () => {
  it("scales after translating, so the focal point does not drift with zoom", () => {
    const near = cameraTransform({ focus: { x: 0.25, y: 0.75 }, zoom: 1.4 });
    const far = cameraTransform({ focus: { x: 0.25, y: 0.75 }, zoom: 2.8 });

    expect(near).toBe("scale(1.4) translate(25.0000%, -25.0000%)");
    expect(far).toBe("scale(2.8) translate(25.0000%, -25.0000%)");
  });

  it("needs no zoom for a centred focus and more than the offset for a shifted one", () => {
    expect(minimumZoom({ x: 0.5, y: 0.5 }, 1)).toBeCloseTo(1);
    // 1 + 2d would say 1.2 here, which leaves a visible strip of empty viewport.
    expect(minimumZoom({ x: 0.5, y: 0.6 }, 1)).toBeCloseTo(1.25);
  });

  it.each(Object.values(ROOMS))("keeps the plate over every edge in $id", (room) => {
    for (const stop of [room.desk, room.wide, ...room.hotspots.map((spot) => spot.enter)]) {
      expect(coversViewport(stop)).toBe(true);
    }
  });
});
