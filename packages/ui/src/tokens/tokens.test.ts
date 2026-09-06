import { describe, expect, it } from "vitest";

import { TOKENS } from "./index.js";

/**
 * A completeness test, not a visual one: it proves every required token group
 * from Section 5.2 exists and is non-empty. It says nothing about whether the
 * actual colour/spacing values look right — that is a design review's job.
 */
const REQUIRED_GROUPS = [
  "depth",
  "material",
  "identityAccent",
  "semantic",
  "typography",
  "spacing",
  "corner",
  "elevation",
  "occlusion",
  "motion",
] as const;

describe("design tokens", () => {
  it.each(REQUIRED_GROUPS)("declares the %s token group", (group) => {
    expect(TOKENS[group]).toBeDefined();
    expect(Object.keys(TOKENS[group]).length).toBeGreaterThan(0);
  });

  it("names Vesper, Jester, and NOIR accents", () => {
    expect(Object.keys(TOKENS.identityAccent)).toEqual(["vesper", "jester", "noir"]);
  });

  it("names the seven semantic states the master plan lists", () => {
    expect(Object.keys(TOKENS.semantic)).toEqual([
      "success",
      "warning",
      "error",
      "current",
      "stale",
      "unavailable",
      "approval",
    ]);
  });

  it("gives every motion duration a reduced-motion substitute", () => {
    const durationKeys = Object.keys(TOKENS.motion.durationMs);
    const reducedKeys = Object.keys(TOKENS.motion.reducedDurationMs);

    expect(reducedKeys).toEqual(durationKeys);
  });

  it("gives the renderer a positive frame budget and idle-stop timeout", () => {
    expect(TOKENS.motion.rendererBudget.targetFps).toBeGreaterThan(0);
    expect(TOKENS.motion.rendererBudget.idleStopMs).toBeGreaterThan(0);
  });
});
