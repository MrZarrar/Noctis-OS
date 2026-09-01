import { describe, expect, it } from "vitest";

import type { NodeJobStatus } from "@noctis/contracts";

import { transitionNodeJobStatus } from "./node-job-status.js";

const STATES: readonly NodeJobStatus[] = [
  "queued",
  "leased",
  "running",
  "expired",
  "succeeded",
  "failed",
  "cancelled",
];

const ALLOWED = new Set([
  "queued->leased",
  "queued->cancelled",
  "leased->running",
  "leased->succeeded",
  "leased->failed",
  "leased->expired",
  "leased->cancelled",
  "running->succeeded",
  "running->failed",
  "running->expired",
  "running->cancelled",
  "expired->queued",
  "expired->cancelled",
]);

const TERMINAL = ["succeeded", "failed", "cancelled"] as const;

describe("transitionNodeJobStatus", () => {
  const pairs = STATES.flatMap((from) => STATES.map((to) => [from, to] as const));

  it.each(pairs)("%s -> %s matches the declared matrix", (from, to) => {
    const result = transitionNodeJobStatus(from, to);

    if (ALLOWED.has(`${from}->${to}`)) {
      expect(result).toEqual({ ok: true, value: to });
    } else {
      expect(result).toEqual({
        ok: false,
        conflict: { kind: "forbidden_transition", machine: "node_job", from, to },
      });
    }
  });

  it("treats every terminal state as terminal", () => {
    for (const terminal of TERMINAL) {
      for (const to of STATES) {
        expect(transitionNodeJobStatus(terminal, to).ok).toBe(false);
      }
    }
  });
});
