import { typography } from "@noctis/ui";
import { arc } from "d3-shape";
import { useInView } from "motion/react";
import { useId, useRef } from "react";

import { ringAngles } from "./geometry.js";
import { useProgress } from "./motion.js";
import type { BandKey } from "./palette.js";
import { BandPatterns, band, svgId } from "./palette.js";

/**
 * Time in range as five patterned segments. Given `from`, the ring morphs from
 * the earlier split to this one: a past change's before and after.
 */

export interface RingSegment {
  key: BandKey;
  label: string;
  pct: number;
}

const segmentArc = arc<{ start: number; end: number; inner: number; outer: number }>()
  .innerRadius((d) => d.inner)
  .outerRadius((d) => d.outer)
  .startAngle((d) => d.start)
  .endAngle((d) => d.end)
  .padAngle(0.025)
  .cornerRadius(3);

export function RangeRing({
  segments,
  from,
  centre,
  caption,
  size = 200,
  thickness = 0.16,
}: {
  segments: readonly RingSegment[];
  from?: readonly RingSegment[] | undefined;
  /** The number in the middle, as the report wrote it. */
  centre: string;
  caption: string;
  size?: number;
  thickness?: number;
}): JSX.Element {
  const id = useId();
  const ref = useRef<SVGSVGElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.4 });
  const progress = useProgress(
    seen,
    from === undefined ? 1.2 : 1.6,
    from === undefined ? 0.15 : 0.5,
  );
  const outer = size / 2 - 2;
  const inner = outer * (1 - thickness * 2);

  // A sweep from nothing on first sight; between two splits when morphing.
  const shown = segments.map((segment) => {
    const before = from?.find((f) => f.key === segment.key)?.pct ?? 0;
    return {
      key: segment.key,
      pct: from === undefined ? segment.pct : before + (segment.pct - before) * progress,
    };
  });
  const sweep = from === undefined ? progress : 1;
  const arcs = ringAngles(shown).map((a) => ({ ...a, start: a.start * sweep, end: a.end * sweep }));

  return (
    <svg
      ref={ref}
      viewBox={`${String(-size / 2)} ${String(-size / 2)} ${String(size)} ${String(size)}`}
      role="img"
      aria-label={`${caption}: ${segments.map((s) => `${s.label} ${String(s.pct)}%`).join(", ")}`}
      style={{ width: size, maxWidth: "100%", height: "auto", flex: "none" }}
    >
      <BandPatterns id={id} />
      <circle
        r={(outer + inner) / 2}
        fill="none"
        stroke="rgba(255,255,255,0.05)"
        strokeWidth={outer - inner}
      />
      {arcs.map((a) => (
        <path
          key={a.key}
          d={segmentArc({ ...a, inner, outer }) ?? ""}
          fill={`url(#${svgId(id, a.key)})`}
          stroke={band[a.key].colour}
          strokeOpacity={0.9}
          strokeWidth={1}
          style={
            a.key === "in_range"
              ? { filter: `drop-shadow(0 0 6px ${band.in_range.colour}66)` }
              : undefined
          }
        />
      ))}
      <text
        textAnchor="middle"
        dominantBaseline="central"
        y={-size * 0.04}
        fill={typography.color.primary}
        style={{
          font: `650 ${String(Math.round(size * 0.17))}px ${typography.family}`,
          letterSpacing: "-0.02em",
        }}
      >
        {centre}
      </text>
      <text
        textAnchor="middle"
        dominantBaseline="central"
        y={size * 0.11}
        fill={typography.color.muted}
        style={{
          font: `600 ${String(Math.max(9, Math.round(size * 0.055)))}px ${typography.family}`,
          letterSpacing: "0.14em",
        }}
      >
        {caption.toUpperCase()}
      </text>
    </svg>
  );
}

/** The ring's legend: a swatch in the band's own pattern, its range and its share. */
export function RingLegend({ segments }: { segments: readonly RingSegment[] }): JSX.Element {
  const id = useId();
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
      {[...segments].reverse().map((segment) => (
        <li
          key={segment.key}
          style={{
            display: "grid",
            gridTemplateColumns: "16px 1fr auto",
            alignItems: "center",
            gap: 10,
            fontSize: 13,
          }}
        >
          <svg width={16} height={16} aria-hidden>
            <BandPatterns id={`${id}${segment.key}`} />
            <rect
              width={16}
              height={16}
              rx={4}
              fill={`url(#${svgId(`${id}${segment.key}`, segment.key)})`}
              stroke={band[segment.key].colour}
            />
          </svg>
          <span style={{ color: typography.color.muted }}>{segment.label}</span>
          <span
            style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}
          >{`${String(segment.pct)}%`}</span>
        </li>
      ))}
    </ul>
  );
}
