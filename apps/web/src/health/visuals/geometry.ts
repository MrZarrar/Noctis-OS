/**
 * Chart geometry for the Health page. Placement only: where a line bends, where
 * an arc ends. Nothing here produces a number that ends up in a label.
 */

type Point = readonly [number, number];

/** Readings further apart than this are a gap in the CGM, not a line between them. */
export const MAX_GAP_MINUTES = 15;

export function valueAt(points: readonly Point[], minute: number): number | undefined {
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i]!;
    if (x === minute) return y;
    const next = points[i + 1];
    if (next === undefined || x > minute) continue;
    const [x2, y2] = next;
    if (x2 < minute) continue;
    if (x2 - x > MAX_GAP_MINUTES) return undefined;
    return y + ((y2 - y) * (minute - x)) / (x2 - x);
  }
  return undefined;
}

export function splitAtGaps(points: readonly Point[]): Point[][] {
  const runs: Point[][] = [];
  for (const point of points) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (run === undefined || last === undefined || point[0] - last[0] > MAX_GAP_MINUTES)
      runs.push([point]);
    else run.push(point);
  }
  return runs;
}

/** The x span and a y range that always shows the whole 3.9–10 corridor with room around it. */
export function traceDomain(traces: readonly { points: readonly Point[] }[]): {
  minutes: number;
  low: number;
  high: number;
} {
  let minutes = 0;
  let low = Infinity;
  let high = -Infinity;
  for (const { points } of traces)
    for (const [x, y] of points) {
      minutes = Math.max(minutes, x);
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
  return {
    minutes: minutes || 240,
    low: Math.min(2, Number.isFinite(low) ? Math.floor(low - 0.5) : 2),
    high: Math.max(12, Number.isFinite(high) ? Math.ceil(high + 1) : 12),
  };
}

export function ringAngles<K extends string>(
  segments: readonly { key: K; pct: number }[],
): { key: K; start: number; end: number }[] {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.pct), 0);
  if (total <= 0) return [];
  let at = 0;
  const arcs: { key: K; start: number; end: number }[] = [];
  for (const segment of segments) {
    if (segment.pct <= 0) continue;
    const sweep = (segment.pct / total) * 2 * Math.PI;
    arcs.push({ key: segment.key, start: at, end: at + sweep });
    at += sweep;
  }
  return arcs;
}

/** The 24 hourly rows plus midnight again, so a radial line or band closes on itself. */
export function closeDay<T extends { hour: number }>(rows: readonly T[]): T[] {
  const first = rows[0];
  return first === undefined ? [] : [...rows, { ...first, hour: 24 }];
}

/** Minutes since local midnight of a naive local `HH:MM`. */
export const clockMinutes = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};
