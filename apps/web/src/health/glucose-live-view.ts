import type { GlucoseTrend } from "@noctis/contracts";
import { GlucoseLiveSchema } from "@noctis/contracts";

export { GlucoseLiveSchema };

/** NICE's own hypo/hyper thresholds, not a Noctis invention. */
const LOW_MMOL = 3.9;
const HIGH_MMOL = 10.0;

export function band(mmol: number): "low" | "high" | "normal" {
  if (mmol < LOW_MMOL) return "low";
  if (mmol > HIGH_MMOL) return "high";
  return "normal";
}

const GLYPHS: Record<GlucoseTrend, string> = {
  doubleUp: "⇈",
  singleUp: "↑",
  fortyFiveUp: "↗",
  flat: "→",
  fortyFiveDown: "↘",
  singleDown: "↓",
  doubleDown: "⇊",
  unknown: "",
};

export function trendGlyph(trend: GlucoseTrend): string {
  return GLYPHS[trend];
}
