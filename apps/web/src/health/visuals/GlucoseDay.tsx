import type { HealthReport } from "@noctis/contracts";
import { typography } from "@noctis/ui";
import { scaleLinear } from "d3-scale";
import { arc, areaRadial, curveCatmullRom, lineRadial } from "d3-shape";
import { motion, useInView, useReducedMotion } from "motion/react";
import { useId, useRef, useState } from "react";

import { clockMinutes, closeDay } from "./geometry.js";
import { EASE, drawIn } from "./motion.js";
import { Glow, glucose, svgId } from "./palette.js";

/**
 * "Your glucose day": the fortnight's hourly percentiles wrapped round a 24 h
 * clock, midnight at the top. p5–p95 is the haze, p25–p75 the band, the median
 * the bright line; the pump's own windows ride the outside.
 */

type Row = HealthReport["agp"][number];

const SIZE = 480;
const C = SIZE / 2;
const INNER = 74;
const OUTER = 166;
const WINDOW_R = 194;
const LABEL_R = 214;
const TAU = 2 * Math.PI;

const r = scaleLinear().domain([2, 18]).range([INNER, OUTER]).clamp(true);
const hourAngle = (hour: number): number => (hour / 24) * TAU;
const minuteAngle = (minutes: number): number => (minutes / 1440) * TAU;

const haze = areaRadial<Row>()
  .defined((d) => d.p5 !== null && d.p95 !== null)
  .angle((d) => hourAngle(d.hour))
  .innerRadius((d) => r(d.p5 ?? 0))
  .outerRadius((d) => r(d.p95 ?? 0))
  .curve(curveCatmullRom.alpha(0.5));
const core = areaRadial<Row>()
  .defined((d) => d.p25 !== null && d.p75 !== null)
  .angle((d) => hourAngle(d.hour))
  .innerRadius((d) => r(d.p25 ?? 0))
  .outerRadius((d) => r(d.p75 ?? 0))
  .curve(curveCatmullRom.alpha(0.5));
const median = lineRadial<Row>()
  .defined((d) => d.p50 !== null)
  .angle((d) => hourAngle(d.hour))
  .radius((d) => r(d.p50 ?? 0))
  .curve(curveCatmullRom.alpha(0.5));

const ring = arc<{ inner: number; outer: number; start: number; end: number }>()
  .innerRadius((d) => d.inner)
  .outerRadius((d) => d.outer)
  .startAngle((d) => d.start)
  .endAngle((d) => d.end);

/** A point at `radius` and clock angle `angle` (0 at the top, clockwise). */
const polar = (radius: number, angle: number): [number, number] => [
  C + radius * Math.sin(angle),
  C - radius * Math.cos(angle),
];

/** An arc for text to run along, reversed on the lower half so labels never read upside down. */
function labelPath(start: number, end: number): string {
  const middle = (start + end) / 2;
  const lower = middle > Math.PI / 2 && middle < (3 * Math.PI) / 2;
  const [x1, y1] = polar(LABEL_R, lower ? end : start);
  const [x2, y2] = polar(LABEL_R, lower ? start : end);
  const large = end - start > Math.PI ? 1 : 0;
  return `M${String(x1)},${String(y1)} A${String(LABEL_R)},${String(LABEL_R)} 0 ${String(large)} ${lower ? 0 : 1} ${String(x2)},${String(y2)}`;
}

const fmt = (value: number | null): string => (value === null ? "–" : String(value));

export function GlucoseDay({
  report,
  marked,
  onWindow,
}: {
  report: HealthReport;
  /** Windows with findings: marked and clickable. */
  marked: ReadonlySet<string>;
  onWindow: (name: string) => void;
}): JSX.Element {
  const id = useId();
  const ref = useRef<SVGSVGElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.3 });
  const reduced = useReducedMotion() ?? false;
  const [hour, setHour] = useState<number>();
  const rows = closeDay(report.agp);
  const focus = hour === undefined ? undefined : report.agp.find((row) => row.hour === hour);
  const at = (path: string | null): string => path ?? "";

  return (
    <figure style={{ margin: 0, display: "grid", gap: 8, justifyItems: "center" }}>
      <svg
        ref={ref}
        viewBox={`0 0 ${String(SIZE)} ${String(SIZE)}`}
        role="img"
        aria-label={`Your glucose day: hourly percentiles over ${String(report.period.days)} days, target 3.9 to 10.0 mmol/L`}
        style={{
          width: "100%",
          maxWidth: 460,
          height: "auto",
          overflow: "visible",
          touchAction: "pan-y",
        }}
        onPointerLeave={() => setHour(undefined)}
      >
        <defs>
          <Glow id={svgId(id, "glow")} blur={4} />
          <radialGradient id={svgId(id, "lowzone")} cx="50%" cy="50%" r="50%">
            <stop
              offset={`${String((INNER / OUTER) * 100 * 0.9)}%`}
              stopColor={glucose.low}
              stopOpacity={0.5}
            />
            <stop
              offset={`${String((r(3.9) / OUTER) * 100)}%`}
              stopColor={glucose.low}
              stopOpacity={0.08}
            />
          </radialGradient>
          <radialGradient id={svgId(id, "floor")} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={glucose.accentDeep} stopOpacity={0.22} />
            <stop offset="70%" stopColor={glucose.accentDeep} stopOpacity={0.04} />
            <stop offset="100%" stopColor={glucose.accentDeep} stopOpacity={0} />
          </radialGradient>
        </defs>

        <circle cx={C} cy={C} r={OUTER + 40} fill={`url(#${svgId(id, "floor")})`} />

        <motion.g
          style={{ transformOrigin: `${String(C)}px ${String(C)}px` }}
          initial={reduced ? false : { opacity: 0, scale: 0.94, rotate: -8 }}
          {...(seen || reduced ? { animate: { opacity: 1, scale: 1, rotate: 0 } } : {})}
          transition={{ duration: 1.1, ease: EASE }}
        >
          <g transform={`translate(${String(C)},${String(C)})`}>
            <path
              d={at(ring({ inner: INNER, outer: r(3.9), start: 0, end: TAU }))}
              fill={`url(#${svgId(id, "lowzone")})`}
            />
            <path
              d={at(ring({ inner: r(3.9), outer: r(10), start: 0, end: TAU }))}
              fill={glucose.target}
              opacity={0.07}
            />
            {[3.9, 10].map((value) => (
              <circle
                key={value}
                r={r(value)}
                fill="none"
                stroke={value === 3.9 ? glucose.low : glucose.target}
                strokeOpacity={0.55}
                strokeDasharray="2 5"
              />
            ))}
            <circle r={r(13.9)} fill="none" stroke={glucose.grid} />
            <circle r={OUTER} fill="none" stroke={glucose.grid} />
            {Array.from({ length: 24 }, (_, h) => {
              const [x1, y1] = polar(INNER - 6, hourAngle(h));
              const [x2, y2] = polar(h % 6 === 0 ? OUTER + 8 : OUTER, hourAngle(h));
              return (
                <line
                  key={h}
                  x1={x1 - C}
                  y1={y1 - C}
                  x2={x2 - C}
                  y2={y2 - C}
                  stroke={h % 6 === 0 ? glucose.gridStrong : glucose.grid}
                  strokeWidth={h === hour ? 1.5 : 1}
                />
              );
            })}

            <path d={at(haze(rows))} fill={glucose.accent} opacity={0.16} />
            <path d={at(core(rows))} fill={glucose.accent} opacity={0.42} />
            <motion.path
              d={at(median(rows))}
              fill="none"
              stroke="#D9D3FF"
              strokeWidth={2.4}
              strokeLinecap="round"
              filter={`url(#${svgId(id, "glow")})`}
              {...drawIn(reduced, seen, 1.8, 0.4)}
            />
            {focus?.p50 != null && (
              <circle
                cx={polar(r(focus.p50), hourAngle(focus.hour))[0] - C}
                cy={polar(r(focus.p50), hourAngle(focus.hour))[1] - C}
                r={5}
                fill="#fff"
                stroke={glucose.accent}
                strokeWidth={2}
              />
            )}
          </g>

          {[0, 6, 12, 18].map((h) => {
            const [x, y] = polar(OUTER + 18, hourAngle(h));
            return (
              <text
                key={h}
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fill={typography.color.muted}
                style={{ font: `500 13px ${typography.monoFamily}` }}
              >
                {`${String(h).padStart(2, "0")}:00`}
              </text>
            );
          })}
          {[3.9, 10].map((value) => {
            const [x, y] = polar(r(value), hourAngle(1.5));
            return (
              <text
                key={value}
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fill={value === 3.9 ? glucose.low : glucose.target}
                style={{ font: `600 12px ${typography.monoFamily}`, paintOrder: "stroke" }}
                stroke="#050409"
                strokeWidth={3}
              >
                {value.toFixed(1)}
              </text>
            );
          })}

          {report.windows.map((window) => {
            const start = minuteAngle(clockMinutes(window.start));
            const end = minuteAngle(clockMinutes(window.end));
            const hot = marked.has(window.name);
            const pathId = svgId(id, `w-${window.name}`);
            const [mx, my] = polar(WINDOW_R + 3, (start + end) / 2);
            const label = `${window.name}${hot ? ": see findings" : ""}`;
            return (
              <g
                key={window.name}
                {...(hot
                  ? {
                      role: "button",
                      tabIndex: 0,
                      "aria-label": label,
                      onClick: () => onWindow(window.name),
                      onKeyDown: (event: React.KeyboardEvent) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onWindow(window.name);
                        }
                      },
                      style: { cursor: "pointer", outline: "none" },
                    }
                  : {})}
              >
                <path
                  d={at(
                    ring({
                      inner: WINDOW_R,
                      outer: WINDOW_R + (hot ? 6 : 3),
                      start: start + 0.02,
                      end: end - 0.02,
                    }),
                  )}
                  transform={`translate(${String(C)},${String(C)})`}
                  fill={hot ? glucose.accent : glucose.gridStrong}
                  opacity={hot ? 0.95 : 0.7}
                  filter={hot ? `url(#${svgId(id, "glow")})` : undefined}
                />
                <path id={pathId} d={labelPath(start, end)} fill="none" />
                <text
                  fill={hot ? typography.color.primary : typography.color.muted}
                  style={{
                    font: `${hot ? 650 : 500} 15px ${typography.family}`,
                    letterSpacing: "0.06em",
                  }}
                  dominantBaseline="central"
                >
                  <textPath href={`#${pathId}`} startOffset="50%" textAnchor="middle">
                    {window.name}
                  </textPath>
                </text>
                {hot && <circle cx={mx} cy={my} r={14} fill="transparent" />}
              </g>
            );
          })}

          {Array.from({ length: 24 }, (_, h) => (
            <path
              key={h}
              d={at(
                ring({
                  inner: INNER,
                  outer: OUTER + 10,
                  start: hourAngle(h - 0.5),
                  end: hourAngle(h + 0.5),
                }),
              )}
              transform={`translate(${String(C)},${String(C)})`}
              fill="transparent"
              onPointerEnter={() => setHour(h)}
              onPointerDown={() => setHour(h)}
            />
          ))}
        </motion.g>

        <g pointerEvents="none" textAnchor="middle">
          {focus === undefined ? (
            <>
              <text
                x={C}
                y={C - 10}
                fill={typography.color.muted}
                style={{ font: `600 12px ${typography.family}`, letterSpacing: "0.16em" }}
              >
                YOUR GLUCOSE DAY
              </text>
              <text
                x={C}
                y={C + 14}
                fill={typography.color.primary}
                style={{ font: `650 26px ${typography.family}` }}
              >
                {`${String(report.period.days)} days`}
              </text>
            </>
          ) : (
            <>
              <text
                x={C}
                y={C - 22}
                fill={typography.color.muted}
                style={{ font: `500 12px ${typography.monoFamily}` }}
              >
                {`${String(focus.hour).padStart(2, "0")}:00`}
              </text>
              <text
                x={C}
                y={C + 4}
                fill={typography.color.primary}
                style={{ font: `600 24px ${typography.family}` }}
              >
                {fmt(focus.p50)}
              </text>
              <text
                x={C}
                y={C + 24}
                fill={typography.color.muted}
                style={{ font: `500 11px ${typography.family}` }}
              >
                {`${fmt(focus.p25)}–${fmt(focus.p75)} mmol/L`}
              </text>
            </>
          )}
        </g>
      </svg>
      <figcaption
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
          justifyContent: "center",
          color: typography.color.muted,
          fontSize: 12,
        }}
      >
        <Key
          swatch={
            <span
              style={{
                width: 18,
                height: 3,
                borderRadius: 2,
                background: "#D9D3FF",
                boxShadow: `0 0 8px ${glucose.accent}`,
              }}
            />
          }
        >
          median
        </Key>
        <Key
          swatch={
            <span
              style={{
                width: 14,
                height: 10,
                borderRadius: 3,
                background: glucose.accent,
                opacity: 0.6,
              }}
            />
          }
        >
          middle half
        </Key>
        <Key
          swatch={
            <span
              style={{
                width: 14,
                height: 10,
                borderRadius: 3,
                background: glucose.accent,
                opacity: 0.22,
              }}
            />
          }
        >
          5–95%
        </Key>
        <Key
          swatch={
            <span style={{ width: 14, height: 0, borderTop: `2px dashed ${glucose.target}` }} />
          }
        >
          target 3.9–10.0
        </Key>
      </figcaption>
    </figure>
  );
}

function Key({ swatch, children }: { swatch: JSX.Element; children: string }): JSX.Element {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {swatch}
      {children}
    </span>
  );
}
