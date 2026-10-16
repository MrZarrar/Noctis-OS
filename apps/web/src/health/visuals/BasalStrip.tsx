import type { HealthFinding, HealthReport, HealthTrace } from "@noctis/contracts";
import { material, typography } from "@noctis/ui";
import { scaleLinear } from "d3-scale";
import { curveMonotoneX, line } from "d3-shape";
import { motion, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";

import { sensorLowsIn } from "../health-view.js";
import { splitAtGaps, traceDomain, valueAt } from "./geometry.js";
import { EASE } from "./motion.js";
import { glucose } from "./palette.js";

/**
 * Control-IQ's basal, night by hour: how far it ran from what the pump was
 * programmed to give. Each cell says its ratio when pointed at; a night with
 * nothing programmed in an hour is hatched rather than coloured.
 */

/** Strength of the tint: none at exactly programmed, full at half or one and a half times. */
const strength = scaleLinear().domain([0, 0.5]).range([0.12, 0.95]).clamp(true);

function colour(ratio: number): string {
  const tint = ratio >= 1 ? glucose.boosted : glucose.cutBack;
  const alpha = Math.round(strength(Math.abs(ratio - 1)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `linear-gradient(${tint}${alpha}, ${tint}${alpha}), ${glucose.neutral}`;
}

const HATCH = `repeating-linear-gradient(135deg, ${material.fill} 0 3px, rgba(255,255,255,0.14) 3px 5px)`;

const clock = (t0: string, minute: number): string =>
  new Date(new Date(t0).getTime() + minute * 60_000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

const night = (t0: string): string =>
  new Date(t0).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export function BasalStrip({
  finding,
  report,
}: {
  finding: HealthFinding;
  report: HealthReport;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.3 });
  const reduced = useReducedMotion() ?? false;
  const domain = traceDomain(finding.traces);

  return (
    <div ref={ref} style={{ display: "grid", gap: 12 }}>
      <div
        role="table"
        aria-label="Basal against programmed, by night and hour"
        style={{ display: "grid", gap: 8 }}
      >
        {finding.traces.map((trace, row) => (
          <div
            key={trace.t0}
            role="row"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              columnGap: 12,
              rowGap: 6,
            }}
          >
            <div role="rowheader" style={{ width: 96, flex: "none", display: "grid", gap: 1 }}>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: trace.hit ? typography.color.primary : typography.color.muted,
                }}
              >
                {night(trace.t0)}
              </span>
              {trace.ratio != null && (
                <span
                  style={{
                    fontSize: 12,
                    color: typography.color.muted,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {`${String(trace.ratio)}× programmed`}
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 3, flex: "1 1 180px", minWidth: 160 }}>
              {(trace.basal ?? []).map(([minute, ratio], column) => (
                <motion.div
                  key={minute}
                  role="cell"
                  title={`${clock(trace.t0, minute)}: ${ratio === null ? "nothing programmed" : `${String(ratio)}× programmed`}`}
                  aria-label={`${clock(trace.t0, minute)}: ${ratio === null ? "nothing programmed" : `${String(ratio)} times programmed`}`}
                  initial={reduced ? false : { opacity: 0, scaleY: 0.3 }}
                  {...(seen || reduced ? { animate: { opacity: 1, scaleY: 1 } } : {})}
                  transition={{ duration: 0.45, delay: row * 0.08 + column * 0.05, ease: EASE }}
                  style={{
                    flex: 1,
                    height: 30,
                    borderRadius: 5,
                    background: ratio === null ? HATCH : colour(ratio),
                    border: `1px solid ${ratio === null ? material.border : "rgba(255,255,255,0.12)"}`,
                    boxShadow:
                      ratio !== null && ratio >= 1.25 ? `0 0 12px ${glucose.boosted}55` : "none",
                  }}
                />
              ))}
            </div>
            <Sparkline
              trace={trace}
              report={report}
              minutes={domain.minutes}
              low={domain.low}
              high={domain.high}
            />
          </div>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 14,
          fontSize: 12,
          color: typography.color.muted,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          cut back
          <span
            aria-hidden
            style={{
              width: 96,
              height: 8,
              borderRadius: 4,
              background: `linear-gradient(90deg, ${glucose.cutBack}, ${glucose.neutral}, ${glucose.boosted})`,
            }}
          />
          boosted
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            aria-hidden
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              background: HATCH,
              border: `1px solid ${material.border}`,
            }}
          />
          nothing programmed
        </span>
        <span>Line: glucose that night</span>
      </div>
    </div>
  );
}

const SW = 180;
const SH = 34;

function Sparkline({
  trace,
  report,
  minutes,
  low,
  high,
}: {
  trace: HealthTrace;
  report: HealthReport;
  minutes: number;
  low: number;
  high: number;
}): JSX.Element {
  const x = scaleLinear()
    .domain([0, minutes])
    .range([2, SW - 2]);
  const y = scaleLinear()
    .domain([low, high])
    .range([SH - 2, 2]);
  const draw = line<readonly [number, number]>()
    .x((d) => x(d[0]))
    .y((d) => y(d[1]))
    .curve(curveMonotoneX);
  return (
    <svg
      width={SW}
      height={SH}
      viewBox={`0 0 ${String(SW)} ${String(SH)}`}
      aria-hidden
      style={{ flex: "none", maxWidth: "100%" }}
    >
      <rect
        x={0}
        y={y(10)}
        width={SW}
        height={y(3.9) - y(10)}
        fill={glucose.target}
        opacity={0.08}
        rx={3}
      />
      <line
        x1={0}
        x2={SW}
        y1={y(3.9)}
        y2={y(3.9)}
        stroke={glucose.low}
        strokeOpacity={0.5}
        strokeDasharray="2 3"
      />
      {splitAtGaps(trace.points).map((run, i) => (
        <path
          key={i}
          d={draw(run) ?? ""}
          fill="none"
          stroke={trace.hit ? "#D9D3FF" : typography.color.muted}
          strokeWidth={1.5}
        />
      ))}
      {sensorLowsIn(report, trace.t0, minutes).map((minute) => (
        <circle
          key={minute}
          cx={x(minute)}
          cy={y(valueAt(trace.points, minute) ?? low + 0.5)}
          r={4.5}
          fill="none"
          stroke="#fff"
          strokeDasharray="2 1.5"
        >
          <title>possible sensor low (counted as real)</title>
        </circle>
      ))}
    </svg>
  );
}
