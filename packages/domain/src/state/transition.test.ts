import { describe, expect, it } from "vitest";

import { defineTransition } from "./transition.js";

type Light = "red" | "green";

const transitionLight = defineTransition<Light>("light", {
  red: ["green"],
  green: [],
});

describe("defineTransition", () => {
  it("returns the next state for an allowed transition", () => {
    const result = transitionLight("red", "green");

    expect(result).toEqual({ ok: true, value: "green" });
  });

  it("returns a forbidden_transition conflict naming the machine", () => {
    const result = transitionLight("green", "red");

    expect(result).toEqual({
      ok: false,
      conflict: { kind: "forbidden_transition", machine: "light", from: "green", to: "red" },
    });
  });

  it("refuses a self-transition that the table does not list", () => {
    expect(transitionLight("red", "red").ok).toBe(false);
  });
});
