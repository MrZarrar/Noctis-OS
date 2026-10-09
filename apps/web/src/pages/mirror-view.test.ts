import { describe, expect, it } from "vitest";

import { mirrorAllowed, mirrorPath, mirrorRefusal } from "./mirror-view.js";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");

describe("mirrorPath", () => {
  it("asks the core for one PC at a rate and a size, or only whether it would start", () => {
    expect(mirrorPath("n1", 15, 1280)).toBe("/screen/live?node=n1&fps=15&width=1280");
    expect(mirrorPath("n1", 30, 1920, true)).toBe("/screen/live?node=n1&fps=30&width=1920&probe=1");
  });
});

describe("mirrorAllowed", () => {
  it("needs a live screen.view grant of its own", () => {
    expect(mirrorAllowed([{ capability: "screen.view" }], NOW)).toBe(true);
    expect(mirrorAllowed([{ capability: "runtime.turn" }], NOW)).toBe(false);
    expect(
      mirrorAllowed([{ capability: "screen.view", revokedAt: "2026-10-01T00:00:00.000Z" }], NOW),
    ).toBe(false);
    expect(
      mirrorAllowed([{ capability: "screen.view", expiresAt: "2026-10-09T11:59:59.000Z" }], NOW),
    ).toBe(false);
  });
});

describe("mirrorRefusal", () => {
  it("tells a locked PC from one with nothing to capture with", () => {
    expect(mirrorRefusal(423, {})).toEqual({ phase: "locked" });
    expect(mirrorRefusal(403, {})).toEqual({ phase: "not_granted" });
    expect(
      mirrorRefusal(503, {
        error: { message: "No screen helper is running (see HOME-SETUP.md, Screen mirror)" },
      }),
    ).toEqual({
      phase: "unavailable",
      message: "No screen helper is running (see HOME-SETUP.md, Screen mirror)",
    });
    expect(mirrorRefusal(500, "nonsense")).toEqual({
      phase: "unavailable",
      message: "The core could not start the mirror (HTTP 500).",
    });
  });
});
