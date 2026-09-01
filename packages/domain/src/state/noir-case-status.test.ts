import { describe, expect, it } from "vitest";

import type { NoirCaseStatus } from "@noctis/contracts";

import { transitionNoirCaseStatus } from "./noir-case-status.js";

const STATES: readonly NoirCaseStatus[] = [
  "forming",
  "investigating",
  "synthesising",
  "resolved",
  "blocked",
  "abandoned",
];

const ALLOWED = new Set([
  "forming->investigating",
  "forming->abandoned",
  "investigating->synthesising",
  "investigating->blocked",
  "investigating->abandoned",
  "synthesising->resolved",
  "synthesising->blocked",
  "synthesising->abandoned",
  "blocked->investigating",
  "blocked->abandoned",
]);

const TERMINAL = ["resolved", "abandoned"] as const;

describe("transitionNoirCaseStatus", () => {
  const pairs = STATES.flatMap((from) => STATES.map((to) => [from, to] as const));

  it.each(pairs)("%s -> %s matches the declared matrix", (from, to) => {
    const result = transitionNoirCaseStatus(from, to);

    if (ALLOWED.has(`${from}->${to}`)) {
      expect(result).toEqual({ ok: true, value: to });
    } else {
      expect(result).toEqual({
        ok: false,
        conflict: { kind: "forbidden_transition", machine: "noir_case", from, to },
      });
    }
  });

  it("treats every terminal state as terminal", () => {
    for (const terminal of TERMINAL) {
      for (const to of STATES) {
        expect(transitionNoirCaseStatus(terminal, to).ok).toBe(false);
      }
    }
  });
});
