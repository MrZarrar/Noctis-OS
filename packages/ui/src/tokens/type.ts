/** Section 5.2: "type scale, measure, tracking, and monospace/data styles". */
export const typography = {
  family: '"Inter", "Segoe UI", system-ui, sans-serif',
  monoFamily: '"JetBrains Mono", "Cascadia Code", ui-monospace, monospace',
  scale: { xs: 12, sm: 13, base: 15, md: 17, lg: 21, xl: 28, xxl: 36 },
  measurePx: 640,
  tracking: { tight: "-0.01em", normal: "0", wide: "0.04em" },
  /**
   * Phase 5 hard-coded `#E7E6EE` at four call sites because there was no token
   * for it. Both values clear 4.5:1 against every `depth` layer, so `muted` is
   * a legible secondary rather than a decorative grey — Section 5.2 asks for
   * "legible white typography", not for text that fades into the material.
   */
  color: { primary: "#E7E6EE", muted: "#9B98AE" },
} as const;
