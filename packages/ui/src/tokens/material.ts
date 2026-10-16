import { corner } from "./spacing.js";

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

/**
 * Nearly solid. At 4 to 7% white, a card or menu over the thread let the text
 * behind it show through and neither could be read (owner, 2026-10-16).
 */
export const glass = {
  background: "linear-gradient(180deg, rgba(28, 25, 48, 0.94), rgba(19, 17, 32, 0.94))",
  backdropFilter: `blur(${String(material.blurPx)}px)`,
  WebkitBackdropFilter: `blur(${String(material.blurPx)}px)`,
  border: `1px solid ${material.border}`,
  borderRadius: corner.lg,
  boxShadow: `inset 0 1px 0 ${material.fill}, 0 12px 32px -18px ${material.shadow}`,
} as const;
