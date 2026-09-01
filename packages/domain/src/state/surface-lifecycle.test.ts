import { describe, expect, it } from "vitest";

import type { SurfaceLifecycle } from "@noctis/contracts";

import { transitionSurfaceLifecycle } from "./surface-lifecycle.js";

const STATES: readonly SurfaceLifecycle[] = [
  "proposed",
  "entering",
  "active",
  "background",
  "exiting",
  "dismissed",
];

const ALLOWED = new Set([
  "proposed->entering",
  "proposed->dismissed",
  "entering->active",
  "entering->dismissed",
  "active->background",
  "active->exiting",
  "background->active",
  "background->exiting",
  "exiting->dismissed",
]);

const TERMINAL = ["dismissed"] as const;

describe("transitionSurfaceLifecycle", () => {
  const pairs = STATES.flatMap((from) => STATES.map((to) => [from, to] as const));

  it.each(pairs)("%s -> %s matches the declared matrix", (from, to) => {
    const result = transitionSurfaceLifecycle(from, to);

    if (ALLOWED.has(`${from}->${to}`)) {
      expect(result).toEqual({ ok: true, value: to });
    } else {
      expect(result).toEqual({
        ok: false,
        conflict: { kind: "forbidden_transition", machine: "surface", from, to },
      });
    }
  });

  it("treats every terminal state as terminal", () => {
    for (const terminal of TERMINAL) {
      for (const to of STATES) {
        expect(transitionSurfaceLifecycle(terminal, to).ok).toBe(false);
      }
    }
  });
});
