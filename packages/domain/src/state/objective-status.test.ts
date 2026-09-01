import { describe, expect, it } from "vitest";

import type { ObjectiveStatus } from "@noctis/contracts";

import { transitionObjectiveStatus } from "./objective-status.js";

const STATES: readonly ObjectiveStatus[] = [
  "suggested",
  "draft",
  "active",
  "paused",
  "completed",
  "abandoned",
];

const ALLOWED = new Set([
  "suggested->draft",
  "suggested->abandoned",
  "draft->active",
  "draft->abandoned",
  "active->paused",
  "active->completed",
  "active->abandoned",
  "paused->active",
  "paused->completed",
  "paused->abandoned",
]);

const TERMINAL = ["completed", "abandoned"] as const;

describe("transitionObjectiveStatus", () => {
  const pairs = STATES.flatMap((from) => STATES.map((to) => [from, to] as const));

  it.each(pairs)("%s -> %s matches the declared matrix", (from, to) => {
    const result = transitionObjectiveStatus(from, to);

    if (ALLOWED.has(`${from}->${to}`)) {
      expect(result).toEqual({ ok: true, value: to });
    } else {
      expect(result).toEqual({
        ok: false,
        conflict: { kind: "forbidden_transition", machine: "objective", from, to },
      });
    }
  });

  it("treats every terminal state as terminal", () => {
    for (const terminal of TERMINAL) {
      for (const to of STATES) {
        expect(transitionObjectiveStatus(terminal, to).ok).toBe(false);
      }
    }
  });
});
