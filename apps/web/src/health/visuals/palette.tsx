import { identityAccent, semantic } from "@noctis/ui";

/**
 * The Health page's colours. Every band also has its own pattern and a label,
 * because a low and a high must never be told apart by hue alone.
 */

export type BandKey = "very_low" | "low" | "in_range" | "high" | "very_high";

export const band: Record<
  BandKey,
  { colour: string; pattern: "cross" | "hatch" | "solid" | "dots" | "dense" }
> = {
  very_low: { colour: "#FF4D4D", pattern: "cross" },
  low: { colour: "#FF8A7A", pattern: "hatch" },
  in_range: { colour: semantic.success, pattern: "solid" },
  high: { colour: semantic.warning, pattern: "dots" },
  very_high: { colour: "#FF7A2F", pattern: "dense" },
};

export const glucose = {
  accent: identityAccent.vesper.primary,
  accentDeep: identityAccent.vesper.secondary,
  target: semantic.success,
  low: "#FF4D4D",
  high: semantic.warning,
  grid: "rgba(255, 255, 255, 0.08)",
  gridStrong: "rgba(255, 255, 255, 0.16)",
  /** Control-IQ below programmed, at programmed, above it. */
  cutBack: "#5B8CFF",
  neutral: "#3A3550",
  boosted: semantic.warning,
} as const;

/** A finding's accent, by rule. */
export const ruleAccent: Record<string, string> = {
  carb_ratio: semantic.warning,
  pre_bolus: "#F7C873",
  isf: "#5B8CFF",
  basal: identityAccent.vesper.primary,
  exercise_low: "#FF8A7A",
};

/** SVG ids must be unique in the document and safe inside `url(#...)`. */
export const svgId = (reactId: string, name: string): string =>
  `h${reactId.replace(/[^\w-]/g, "")}-${name}`;

/**
 * One `<pattern>` per band, for any SVG that fills by band. Solid is still a
 * pattern so every fill goes through the same `url(#...)` path.
 */
export function BandPatterns({ id }: { id: string }): JSX.Element {
  return (
    <defs>
      {(Object.keys(band) as BandKey[]).map((key) => {
        const { colour, pattern } = band[key];
        return (
          <pattern key={key} id={svgId(id, key)} width={6} height={6} patternUnits="userSpaceOnUse">
            <rect width={6} height={6} fill={colour} opacity={pattern === "solid" ? 0.95 : 0.55} />
            {pattern === "hatch" && (
              <path
                d="M-1,1 l2,-2 M0,6 l6,-6 M5,7 l2,-2"
                stroke="#050409"
                strokeWidth={1.2}
                opacity={0.7}
              />
            )}
            {pattern === "cross" && (
              <path d="M0,0 L6,6 M6,0 L0,6" stroke="#050409" strokeWidth={1.1} opacity={0.75} />
            )}
            {pattern === "dots" && <circle cx={3} cy={3} r={1.1} fill="#050409" opacity={0.6} />}
            {pattern === "dense" && (
              <>
                <circle cx={1.5} cy={1.5} r={0.9} fill="#050409" opacity={0.6} />
                <circle cx={4.5} cy={4.5} r={0.9} fill="#050409" opacity={0.6} />
              </>
            )}
          </pattern>
        );
      })}
    </defs>
  );
}

/** A soft glow for the lines that matter: the median and a hit trace. */
export function Glow({ id, blur = 3 }: { id: string; blur?: number }): JSX.Element {
  return (
    <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation={blur} result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  );
}
