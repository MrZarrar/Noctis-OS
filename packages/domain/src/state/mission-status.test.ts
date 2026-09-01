import { describe, expect, it } from "vitest";

import type { MissionStatus } from "@noctis/contracts";

import { transitionMissionStatus } from "./mission-status.js";

const STATES: readonly MissionStatus[] = [
  "draft",
  "awaiting_approval",
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
];

const ALLOWED = new Set([
  "draft->awaiting_approval",
  "draft->cancelled",
  "awaiting_approval->queued",
  "awaiting_approval->cancelled",
  "queued->running",
  "queued->cancelled",
  "running->succeeded",
  "running->failed",
  "running->blocked",
  "running->cancelled",
  "blocked->running",
  "blocked->cancelled",
]);

const TERMINAL = ["succeeded", "failed", "cancelled"] as const;

describe("transitionMissionStatus", () => {
  const pairs = STATES.flatMap((from) => STATES.map((to) => [from, to] as const));

  it.each(pairs)("%s -> %s matches the declared matrix", (from, to) => {
    const result = transitionMissionStatus(from, to);

    if (ALLOWED.has(`${from}->${to}`)) {
      expect(result).toEqual({ ok: true, value: to });
    } else {
      expect(result).toEqual({
        ok: false,
        conflict: { kind: "forbidden_transition", machine: "mission", from, to },
      });
    }
  });

  it("treats every terminal state as terminal", () => {
    for (const terminal of TERMINAL) {
      for (const to of STATES) {
        expect(transitionMissionStatus(terminal, to).ok).toBe(false);
      }
    }
  });
});
