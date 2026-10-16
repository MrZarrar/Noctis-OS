import type { HealthFinding, HealthReport, HealthTrace } from "@noctis/contracts";
import { corner, material, typography } from "@noctis/ui";
import { median as middle } from "d3-array";
import { scaleLinear } from "d3-scale";
import { curveMonotoneX, line } from "d3-shape";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import type { CSSProperties } from "react";
import { useId, useRef, useState } from "react";

import { formatLocal, medianTrace, sensorLowsIn } from "../health-view.js";
import { splitAtGaps, traceDomain, valueAt } from "./geometry.js";
import { drawIn } from "./motion.js";
import { Glow, glucose, ruleAccent, svgId } from "./palette.js";

/**
 * A finding's events laid over each other from the moment that matters (the
 * bolus, the correction). The ones that fit the pattern glow; the rest stay
 * faint so the pattern reads first, and the median runs through them all.
 */

const W = 640;
const H = 250;
const M = { top: 14, right: 14, bottom: 28, left: 36 };

type Point = readonly [number, number];

const path = line<Point>()
  .x((d) => d[0])
  .y((d) => d[1])
  .curve(curveMonotoneX);

export function TraceChart({
  finding,
  report,
}: {
  finding: HealthFinding;
  report: HealthReport;
}): JSX.Element {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.35 });
  const reduced = useReducedMotion() ?? false;
  const [hover, setHover] = useState<number>();
  const accent = ruleAccent[finding.rule] ?? glucose.accent;
  const traces = finding.traces;
  const domain = traceDomain(traces);
  const x = scaleLinear()
    .domain([0, domain.minutes])
    .range([M.left, W - M.right]);
  const y = scaleLinear()
    .domain([domain.low, domain.high])
    .range([H - M.bottom, M.top]);
  const project = (points: readonly Point[]): Point[] =>
    points.map(([m, v]) => [x(m), y(v)] as const);
  const centre = medianTrace(traces);
  const meal = finding.rule === "carb_ratio" || finding.rule === "pre_bolus";
  const startMedian = middle(traces, (t) => t.points[0]?.[1]);
  const hours = Array.from({ length: Math.floor(domain.minutes / 60) + 1 }, (_, h) => h);
  // Draw the faint ones first so the pattern sits on top.
  const order = traces
    .map((trace, index) => ({ trace, index }))
    .sort((a, b) => Number(a.trace.hit) - Number(b.trace.hit));
  const focused = hover === undefined ? undefined : traces[hover];

  return (
    <div ref={ref} style={{ display: "grid", gap: 10 }}>
      <div style={{ position: "relative" }}>
        <svg
          viewBox={`0 0 ${String(W)} ${String(H)}`}
          role="img"
          aria-label={`${String(traces.length)} events, aligned at the start: ${finding.text}`}
          style={{ width: "100%", height: "auto", display: "block", touchAction: "pan-y" }}
          onPointerLeave={() => setHover(undefined)}
        >
          <defs>
            <Glow id={svgId(id, "glow")} blur={2.5} />
            <linearGradient id={svgId(id, "corridor")} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={glucose.target} stopOpacity={0.1} />
              <stop offset="100%" stopColor={glucose.target} stopOpacity={0.03} />
            </linearGradient>
            <linearGradient id={svgId(id, "low")} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={glucose.low} stopOpacity={0.05} />
              <stop offset="100%" stopColor={glucose.low} stopOpacity={0.22} />
            </linearGradient>
          </defs>

          <rect
            x={M.left}
            y={y(10)}
            width={W - M.left - M.right}
            height={y(3.9) - y(10)}
            fill={`url(#${svgId(id, "corridor")})`}
          />
          <rect
            x={M.left}
            y={y(3.9)}
            width={W - M.left - M.right}
            height={H - M.bottom - y(3.9)}
            fill={`url(#${svgId(id, "low")})`}
          />
          {hours.map((h) => (
            <g key={h}>
              <line
                x1={x(h * 60)}
                x2={x(h * 60)}
                y1={M.top}
                y2={H - M.bottom}
                stroke={glucose.grid}
              />
              <text
                x={x(h * 60)}
                y={H - 8}
                textAnchor="middle"
                fill={typography.color.muted}
                style={{ font: `500 10px ${typography.monoFamily}` }}
              >
                {h === 0 ? "start" : `+${String(h)}h`}
              </text>
            </g>
          ))}
          {[3.9, 10, 13.9]
            .filter((v) => v < domain.high)
            .map((value) => (
              <g key={value}>
                <line
                  x1={M.left}
                  x2={W - M.right}
                  y1={y(value)}
                  y2={y(value)}
                  stroke={
                    value === 3.9 ? glucose.low : value === 10 ? glucose.target : glucose.gridStrong
                  }
                  strokeOpacity={0.6}
                  strokeDasharray="3 5"
                />
                <text
                  x={M.left - 6}
                  y={y(value)}
                  textAnchor="end"
                  dominantBaseline="central"
                  fill={typography.color.muted}
                  style={{ font: `500 10px ${typography.monoFamily}` }}
                >
                  {value.toFixed(1)}
                </text>
              </g>
            ))}

          {meal && startMedian !== undefined && domain.minutes >= 240 && (
            <g>
              <line
                x1={x(210)}
                x2={x(240)}
                y1={y(startMedian + 2)}
                y2={y(startMedian + 2)}
                stroke={accent}
                strokeWidth={2}
                strokeDasharray="4 3"
              />
              <text
                x={x(208)}
                y={y(startMedian + 2)}
                textAnchor="end"
                dominantBaseline="central"
                fill={accent}
                style={{ font: `600 10px ${typography.family}` }}
              >
                +2.0 at 4h
              </text>
            </g>
          )}

          {finding.rule === "isf" &&
            traces.map((trace, index) => {
              const start = trace.points[0]?.[1];
              if (start === undefined || trace.expected_drop === undefined) return null;
              const end = Math.min(300, domain.minutes);
              return (
                <line
                  key={`expected-${String(index)}`}
                  x1={x(0)}
                  y1={y(start)}
                  x2={x(end)}
                  y2={y(start - (trace.expected_drop * end) / 300)}
                  stroke={accent}
                  strokeOpacity={hover === undefined || hover === index ? 0.75 : 0.2}
                  strokeWidth={1.5}
                  strokeDasharray="6 5"
                />
              );
            })}

          {order.map(({ trace, index }) =>
            splitAtGaps(trace.points).map((run, part) => (
              <motion.path
                key={`${String(index)}-${String(part)}`}
                d={path(project(run)) ?? ""}
                fill="none"
                stroke={hover === index ? "#ffffff" : trace.hit ? accent : "rgba(231,230,238,0.32)"}
                strokeWidth={hover === index ? 2.8 : trace.hit ? 1.9 : 1.2}
                strokeLinecap="round"
                opacity={hover === undefined || hover === index ? 1 : 0.35}
                filter={trace.hit || hover === index ? `url(#${svgId(id, "glow")})` : undefined}
                {...drawIn(reduced, seen, 1.3, 0.1 + index * 0.12)}
              />
            )),
          )}

          {centre.length > 1 && (
            <motion.path
              d={path(project(centre)) ?? ""}
              fill="none"
              stroke="#ffffff"
              strokeWidth={3.2}
              strokeLinecap="round"
              filter={`url(#${svgId(id, "glow")})`}
              {...drawIn(reduced, seen, 1.5, 0.3 + traces.length * 0.12)}
            />
          )}

          {traces.map((trace, index) =>
            sensorLowsIn(report, trace.t0, domain.minutes).map((minute) => {
              const value = valueAt(trace.points, minute) ?? domain.low + 0.6;
              return (
                <g key={`low-${String(index)}-${String(minute)}`}>
                  <circle
                    cx={x(minute)}
                    cy={y(value)}
                    r={7}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth={1.5}
                    strokeDasharray="2 2"
                  />
                  <title>possible sensor low (counted as real)</title>
                </g>
              );
            }),
          )}

          {traces.map((trace, index) =>
            splitAtGaps(trace.points).map((run, part) => (
              <path
                key={`hit-${String(index)}-${String(part)}`}
                d={path(project(run)) ?? ""}
                fill="none"
                stroke="transparent"
                strokeWidth={16}
                onPointerEnter={() => setHover(index)}
                onPointerDown={() => setHover(index)}
              />
            )),
          )}
        </svg>
        <AnimatePresence>
          {focused !== undefined && <TraceTip key={hover} trace={focused} />}
        </AnimatePresence>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
          fontSize: 12,
          color: typography.color.muted,
        }}
      >
        <Key swatch={{ height: 2, background: accent, boxShadow: `0 0 6px ${accent}` }}>
          fits the pattern
        </Key>
        <Key swatch={{ height: 1.5, background: "rgba(231,230,238,0.4)" }}>other events</Key>
        <Key swatch={{ height: 3, background: "#fff", boxShadow: `0 0 6px ${glucose.accent}` }}>
          median
        </Key>
        {meal && <Key swatch={{ height: 0, borderTop: `2px dashed ${accent}` }}>+2.0 at 4h</Key>}
        {finding.rule === "isf" && (
          <Key swatch={{ height: 0, borderTop: `2px dashed ${accent}` }}>expected drop</Key>
        )}
      </div>

      <div role="list" aria-label="Events" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {traces.map((trace, index) => (
          <button
            key={trace.t0}
            type="button"
            role="listitem"
            aria-pressed={hover === index}
            onMouseEnter={() => setHover(index)}
            onFocus={() => setHover(index)}
            onBlur={() => setHover(undefined)}
            onClick={() => setHover(hover === index ? undefined : index)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              minHeight: 32,
              padding: "0 10px",
              borderRadius: 999,
              border: `1px solid ${hover === index ? "#ffffff" : trace.hit ? `${accent}88` : material.border}`,
              background: hover === index ? material.fillElevated : material.fill,
              color: trace.hit ? typography.color.primary : typography.color.muted,
              font: `500 12px ${typography.family}`,
              cursor: "pointer",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: trace.hit ? accent : "transparent",
                border: `1.5px solid ${trace.hit ? accent : typography.color.muted}`,
                boxShadow: trace.hit ? `0 0 8px ${accent}` : "none",
              }}
            />
            {formatLocal(trace.t0)}
            <span
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                overflow: "hidden",
                clip: "rect(0 0 0 0)",
              }}
            >
              {trace.hit ? ", fits the pattern" : ", does not fit"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Key({ swatch, children }: { swatch: CSSProperties; children: string }): JSX.Element {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span aria-hidden style={{ width: 18, borderRadius: 2, ...swatch }} />
      {children}
    </span>
  );
}

function TraceTip({ trace }: { trace: HealthTrace }): JSX.Element {
  const first = trace.points[0]?.[1];
  const last = trace.points.at(-1);
  const facts = [
    trace.carbs !== undefined ? `${String(trace.carbs)} g carbs` : undefined,
    trace.units !== undefined ? `${String(trace.units)} U` : undefined,
    trace.expected_drop !== undefined ? `expected drop ${String(trace.expected_drop)}` : undefined,
    first !== undefined && last !== undefined
      ? `${String(first)} → ${String(last[1])} mmol/L`
      : undefined,
  ].filter((fact): fact is string => fact !== undefined);

  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.16 }}
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        pointerEvents: "none",
        display: "grid",
        gap: 2,
        padding: "8px 12px",
        borderRadius: corner.md,
        background: "rgba(19, 17, 32, 0.92)",
        border: `1px solid ${material.highlight}`,
        backdropFilter: "blur(12px)",
        font: `500 12px ${typography.family}`,
        color: typography.color.primary,
        maxWidth: "70%",
      }}
    >
      <strong style={{ fontWeight: 600 }}>{formatLocal(trace.t0)}</strong>
      <span style={{ color: typography.color.muted }}>{facts.join(" · ")}</span>
      <span style={{ color: trace.hit ? typography.color.primary : typography.color.muted }}>
        {trace.hit ? "Fits the pattern" : "Does not fit the pattern"}
      </span>
    </motion.div>
  );
}
