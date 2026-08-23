import { describe, expect, it } from "vitest";

import * as objectiveStatus from "./objective-status.js";

describe("transitionObjectiveStatus", () => {
  it.each([
    ["suggested", "draft"],
    ["suggested", "abandoned"],
    ["draft", "active"],
    ["draft", "abandoned"],
    ["active", "paused"],
    ["active", "completed"],
    ["active", "abandoned"],
    ["paused", "active"],
    ["paused", "completed"],
    ["paused", "abandoned"],
  ] as const)("allows %s -> %s", (current, next) => {
    expect(objectiveStatus.transitionObjectiveStatus?.(current, next)).toBe(next);
  });

  it.each([
    ["suggested", "active"],
    ["draft", "completed"],
    ["active", "draft"],
    ["completed", "active"],
    ["abandoned", "draft"],
    ["active", "active"],
  ] as const)("rejects %s -> %s without changing state", (current, next) => {
    expect(() => objectiveStatus.transitionObjectiveStatus?.(current, next)).toThrow(
      `Invalid Objective transition: ${current} -> ${next}`,
    );
  });
});
