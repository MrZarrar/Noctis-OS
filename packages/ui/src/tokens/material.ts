/** Soft glass/metal material. Section 5.2: "material fills, borders, highlights, shadows, blur, and noise". */
export const material = {
  fill: "rgba(255, 255, 255, 0.04)",
  fillElevated: "rgba(255, 255, 255, 0.07)",
  border: "rgba(255, 255, 255, 0.10)",
  highlight: "rgba(255, 255, 255, 0.16)",
  shadow: "rgba(0, 0, 0, 0.45)",
  blurPx: 24,
  noiseOpacity: 0.03,
} as const;
