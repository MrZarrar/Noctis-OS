/** Section 5.2: "type scale, measure, tracking, and monospace/data styles". */
export const typography = {
  family: '"Inter", "Segoe UI", system-ui, sans-serif',
  monoFamily: '"JetBrains Mono", "Cascadia Code", ui-monospace, monospace',
  scale: { xs: 12, sm: 13, base: 15, md: 17, lg: 21, xl: 28, xxl: 36 },
  measurePx: 640,
  tracking: { tight: "-0.01em", normal: "0", wide: "0.04em" },
} as const;
