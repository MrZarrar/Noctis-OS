import { describe, expect, it } from "vitest";

import { transitionObjectiveStatus } from "./objective-status.js";

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
  ] as const)("allows %s -> %s", (from, to) => {
    expect(transitionObjectiveStatus(from, to)).toEqual({ ok: true, value: to });
  });

  it.each([
    ["suggested", "active"],
    ["suggested", "completed"],
    ["draft", "completed"],
    ["draft", "paused"],
    ["active", "draft"],
    ["active", "suggested"],
    ["paused", "draft"],
    ["completed", "active"],
    ["completed", "abandoned"],
    ["abandoned", "draft"],
    ["abandoned", "active"],
    ["active", "active"],
  ] as const)("refuses %s -> %s and produces no value", (from, to) => {
    const result = transitionObjectiveStatus(from, to);

    expect(result).toEqual({
      ok: false,
      conflict: { kind: "forbidden_transition", machine: "objective", from, to },
    });
  });
});
