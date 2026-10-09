import { describe, expect, it } from "vitest";

import { API_SEGMENTS } from "./api.js";
import {
  CAPABILITY_CONTRACTS,
  CAPABILITY_OPERATION_CLASS,
  NODE_CAPABILITIES,
  NodeCapabilitySchema,
  grantCovers,
} from "./node.js";

describe("the screen mirror contract", () => {
  it("is a node capability, classed as a read", () => {
    expect(NodeCapabilitySchema.parse("screen.view")).toBe("screen.view");
    expect(CAPABILITY_OPERATION_CLASS["screen.view"]).toBe("read_inspect");
  });

  it("takes 15 or 30 fps at 960, 1280 or 1920 wide, and nothing else", () => {
    const { payload } = CAPABILITY_CONTRACTS["screen.view"];

    for (const fps of [15, 30]) {
      for (const width of [960, 1280, 1920]) {
        expect(payload.safeParse({ fps, width }).success, `${String(fps)}@${String(width)}`).toBe(
          true,
        );
      }
    }

    for (const bad of [
      { fps: 60, width: 1280 },
      { fps: 15, width: 4096 },
      { fps: "15", width: 1280 },
      { fps: 15 },
      { fps: 15, width: 1280, display: 2 },
    ]) {
      expect(payload.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("reports how many frames went and why it stopped", () => {
    const { evidence } = CAPABILITY_CONTRACTS["screen.view"];

    for (const endedBy of ["client", "error", "locked"]) {
      expect(evidence.safeParse({ frames: 3, endedBy }).success).toBe(true);
    }

    expect(evidence.safeParse({ frames: -1, endedBy: "client" }).success).toBe(false);
    expect(evidence.safeParse({ frames: 3, endedBy: "bored" }).success).toBe(false);
  });

  // A PC sharing its folders with the agents has not agreed to show its screen.
  it("is covered by its own grant only", () => {
    expect(grantCovers("screen.view", "screen.view")).toBe(true);

    for (const other of NODE_CAPABILITIES.filter((capability) => capability !== "screen.view")) {
      expect(grantCovers(other, "screen.view"), other).toBe(false);
    }
  });

  it("is an API path, so the page server never answers it", () => {
    expect(API_SEGMENTS).toContain("screen");
  });
});
