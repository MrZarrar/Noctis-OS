/**
 * Section 5.2: "success, warning, error, current, stale, unavailable, and
 * approval semantics". Colour is never the sole carrier of meaning — every
 * consumer must pair these with a label or icon, not rely on hue alone.
 */
export const semantic = {
  success: "#3ED598",
  warning: "#FFB020",
  error: "#FF4D4D",
  current: "#3ED598",
  stale: "#FFB020",
  unavailable: "#7A7A85",
  approval: "#8B7CF6",
} as const;
