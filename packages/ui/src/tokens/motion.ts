/**
 * Section 5.2: "motion durations, easing, reduced-motion substitutions, and
 * renderer budgets". `reducedDurationMs` shares every key with `durationMs`
 * so a consumer can always find the substitute for a duration it is using —
 * see `tokens.test.ts`, which checks that pairing rather than trusting it.
 */
export const motion = {
  durationMs: { fast: 120, base: 220, slow: 360 },
  reducedDurationMs: { fast: 0, base: 0, slow: 0 },
  easing: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    enter: "cubic-bezier(0, 0, 0.2, 1)",
    exit: "cubic-bezier(0.4, 0, 1, 1)",
  },
  /** Idle render loops stop; this is the budget an active one may spend. */
  rendererBudget: { targetFps: 30, idleStopMs: 2000 },
} as const;
