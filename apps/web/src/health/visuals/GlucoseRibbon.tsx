import type { HealthReport } from "@noctis/contracts";
import { typography } from "@noctis/ui";
import { scaleLinear } from "d3-scale";
import { area, curveCatmullRom, line } from "d3-shape";
import { motion, useInView, useReducedMotion } from "motion/react";
import { useId, useRef, useState } from "react";

import { useIsMobile } from "../../layout/useIsMobile.js";
import { clockMinutes, closeDay } from "./geometry.js";
import { drawIn } from "./motion.js";
import { Glow, glucose, svgId } from "./palette.js";

/**
 * The same glucose day as the clock, unrolled: midnight to midnight left to
 * right, the pump's windows as columns, a pin on each window with findings.
 */

type Row = HealthReport["agp"][number];

const M = { top: 52, right: 12, bottom: 26, left: 40 };
const smooth = curveCatmullRom.alpha(0.5);

/** Scales and shapes for a ribbon `W` by `H` units: narrower on a phone so its labels stay legible. */
function shapes(W: number, H: number) {
  const x = scaleLinear()
    .domain([0, 24])
    .range([M.left, W - M.right]);
  const y = scaleLinear()
    .domain([2, 16])
    .range([H - M.bottom, M.top])
    .clamp(true);
  return {
    x,
    y,
    haze: area<Row>()
      .defined((d) => d.p5 !== null && d.p95 !== null)
      .x((d) => x(d.hour))
      .y0((d) => y(d.p5 ?? 0))
      .y1((d) => y(d.p95 ?? 0))
      .curve(smooth),
    core: area<Row>()
      .defined((d) => d.p25 !== null && d.p75 !== null)
      .x((d) => x(d.hour))
      .y0((d) => y(d.p25 ?? 0))
      .y1((d) => y(d.p75 ?? 0))
      .curve(smooth),
    median: line<Row>()
      .defined((d) => d.p50 !== null)
      .x((d) => x(d.hour))
      .y((d) => y(d.p50 ?? 0))
      .curve(smooth),
  };
}

const title = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function GlucoseRibbon({
  report,
  marked,
  onWindow,
}: {
  report: HealthReport;
  marked: ReadonlySet<string>;
  onWindow: (name: string) => void;
}): JSX.Element {
  const id = useId();
  const mobile = useIsMobile();
  const W = mobile ? 400 : 720;
  const H = mobile ? 280 : 300;
  const { x, y, haze, core, median } = shapes(W, H);
  const ref = useRef<SVGSVGElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.3 });
  const reduced = useReducedMotion() ?? false;
  const [hour, setHour] = useState<number>();
  const rows = closeDay(report.agp);
  const focus = hour === undefined ? undefined : report.agp.find((row) => row.hour === hour);

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${String(W)} ${String(H)}`}
      role="img"
      aria-label={`Your glucose day: hourly percentiles over ${String(report.period.days)} days, target 3.9 to 10.0 mmol/L`}
      style={{ width: "100%", height: "auto", display: "block", touchAction: "pan-y" }}
      onPointerLeave={() => setHour(undefined)}
    >
      <defs>
        <Glow id={svgId(id, "glow")} blur={3} />
        <clipPath id={svgId(id, "clip")}>
          <motion.rect
            x={M.left}
            y={0}
            height={H}
            initial={reduced ? false : { width: 0 }}
            animate={{ width: seen || reduced ? W - M.left - M.right : 0 }}
            transition={{ duration: 1.6, ease: [0.2, 0, 0, 1] }}
          />
        </clipPath>
      </defs>

      <rect
        x={M.left}
        y={y(10)}
        width={W - M.left - M.right}
        height={y(3.9) - y(10)}
        fill={glucose.target}
        opacity={0.08}
      />
      <rect
        x={M.left}
        y={y(3.9)}
        width={W - M.left - M.right}
        height={H - M.bottom - y(3.9)}
        fill={glucose.low}
        opacity={0.1}
      />
      {[3.9, 10].map((value) => (
        <g key={value}>
          <line
            x1={M.left}
            x2={W - M.right}
            y1={y(value)}
            y2={y(value)}
            stroke={value === 3.9 ? glucose.low : glucose.target}
            strokeOpacity={0.6}
            strokeDasharray="3 5"
          />
          <text
            x={M.left - 6}
            y={y(value)}
            textAnchor="end"
            dominantBaseline="central"
            fill={value === 3.9 ? glucose.low : glucose.target}
            style={{ font: `600 11px ${typography.monoFamily}` }}
          >
            {value.toFixed(1)}
          </text>
        </g>
      ))}

      {report.windows.map((window) => {
        const start = clockMinutes(window.start) / 60;
        const end = clockMinutes(window.end) / 60;
        const hot = marked.has(window.name);
        const mid = (start + end) / 2;
        return (
          <g key={window.name}>
            {start > 0 && (
              <line
                x1={x(start)}
                x2={x(start)}
                y1={M.top - 30}
                y2={H - M.bottom}
                stroke={glucose.gridStrong}
                strokeDasharray="2 4"
              />
            )}
            <text
              x={x(mid)}
              y={16}
              textAnchor="middle"
              fill={hot ? typography.color.primary : typography.color.muted}
              style={{ font: `${hot ? 650 : 500} 13px ${typography.family}` }}
            >
              {title(window.name)}
            </text>
            <text
              x={x(mid)}
              y={32}
              textAnchor="middle"
              fill={typography.color.muted}
              style={{ font: `500 10px ${typography.monoFamily}` }}
            >
              {`${window.start}–${window.end}`}
            </text>
            {hot && (
              <g
                role="button"
                tabIndex={0}
                aria-label={`${window.name}: see findings`}
                style={{ cursor: "pointer" }}
                onClick={() => onWindow(window.name)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onWindow(window.name);
                  }
                }}
              >
                <line
                  x1={x(mid)}
                  x2={x(mid)}
                  y1={M.top - 4}
                  y2={y(10)}
                  stroke={glucose.accent}
                  strokeOpacity={0.7}
                  strokeDasharray="2 3"
                />
                <circle
                  cx={x(mid)}
                  cy={M.top - 6}
                  r={6}
                  fill={glucose.accent}
                  filter={`url(#${svgId(id, "glow")})`}
                />
                <rect x={x(mid) - 40} y={0} width={80} height={M.top} fill="transparent" />
              </g>
            )}
          </g>
        );
      })}

      <g clipPath={`url(#${svgId(id, "clip")})`}>
        <path d={haze(rows) ?? ""} fill={glucose.accent} opacity={0.16} />
        <path d={core(rows) ?? ""} fill={glucose.accent} opacity={0.42} />
      </g>
      <motion.path
        d={median(rows) ?? ""}
        fill="none"
        stroke="#D9D3FF"
        strokeWidth={2.4}
        strokeLinecap="round"
        filter={`url(#${svgId(id, "glow")})`}
        {...drawIn(reduced, seen, 1.6, 0.2)}
      />

      {[0, 6, 12, 18, 24].map((h) => (
        <text
          key={h}
          x={x(h)}
          y={H - 8}
          textAnchor={h === 0 ? "start" : h === 24 ? "end" : "middle"}
          fill={typography.color.muted}
          style={{ font: `500 10px ${typography.monoFamily}` }}
        >
          {`${String(h % 24).padStart(2, "0")}:00`}
        </text>
      ))}

      {focus !== undefined && focus.p50 !== null && (
        <g pointerEvents="none">
          <line
            x1={x(focus.hour)}
            x2={x(focus.hour)}
            y1={M.top}
            y2={H - M.bottom}
            stroke="#fff"
            strokeOpacity={0.35}
          />
          <circle
            cx={x(focus.hour)}
            cy={y(focus.p50)}
            r={5}
            fill="#fff"
            stroke={glucose.accent}
            strokeWidth={2}
          />
          <g
            transform={`translate(${String(Math.min(Math.max(x(focus.hour), M.left + 60), W - 72))},${String(M.top + 6)})`}
          >
            <rect
              x={-62}
              y={0}
              width={124}
              height={40}
              rx={8}
              fill="rgba(19,17,32,0.92)"
              stroke="rgba(255,255,255,0.16)"
            />
            <text
              x={0}
              y={16}
              textAnchor="middle"
              fill={typography.color.primary}
              style={{ font: `600 12px ${typography.family}` }}
            >
              {`${String(focus.hour).padStart(2, "0")}:00 · ${String(focus.p50)}`}
            </text>
            <text
              x={0}
              y={31}
              textAnchor="middle"
              fill={typography.color.muted}
              style={{ font: `500 10px ${typography.family}` }}
            >
              {`${focus.p25 === null ? "–" : String(focus.p25)}–${focus.p75 === null ? "–" : String(focus.p75)} mmol/L`}
            </text>
          </g>
        </g>
      )}

      {Array.from({ length: 24 }, (_, h) => (
        <rect
          key={h}
          x={x(h - 0.5)}
          y={M.top}
          width={x(1) - x(0)}
          height={H - M.top - M.bottom}
          fill="transparent"
          onPointerEnter={() => setHour(h)}
          onPointerDown={() => setHour(h)}
        />
      ))}
    </svg>
  );
}
