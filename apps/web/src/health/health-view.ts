import type { HealthReport, HealthStats, HealthStatus, HealthTrace } from "@noctis/contracts";
import { HealthReportSchema } from "@noctis/contracts";

/**
 * Everything the Health page shows, worked out from report.json alone. Display
 * geometry only (band sizes, a median line, where a marker sits): no medical
 * inference, and every number a label shows is one glycolens wrote.
 */

const STALE_AFTER_MS = 8 * 24 * 3_600_000;
const MINUTE = 60_000;

/** report.json times are naive local; the browser reads them in its own zone, the home PC's. */
const local = (iso: string): number => new Date(iso).getTime();

export type HealthViewState =
  | { kind: "not_allowed" }
  | { kind: "none" }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string }
  | { kind: "ok"; report: HealthReport; staleSince: string | null };

export function viewState(status: HealthStatus, now: Date): HealthViewState {
  if (!status.granted) return { kind: "not_allowed" };
  if (status.report.state === "none") return { kind: "none" };
  if (status.report.state === "missing") return { kind: "missing" };
  if (status.report.state === "unreadable")
    return { kind: "unreadable", reason: status.report.reason };
  const parsed = HealthReportSchema.safeParse(status.report.report);
  if (!parsed.success)
    return { kind: "unreadable", reason: "this report has a shape Noctis does not know" };
  const report = parsed.data;
  const old = now.getTime() - local(report.generated_at) > STALE_AFTER_MS;
  return {
    kind: "ok",
    report,
    staleSince: report.stale_since ?? (old ? report.generated_at : null),
  };
}

const r1 = (value: number): number => Math.round(value * 10) / 10;

export function tirSegments(stats: HealthStats) {
  const { tbr, tbr_severe, tir, tar, tar_severe } = stats;
  if (tbr === null || tbr_severe === null || tir === null || tar === null || tar_severe === null)
    return null;
  return [
    { key: "very_low", label: "Below 3.0", pct: tbr_severe },
    { key: "low", label: "3.0–3.9", pct: r1(tbr - tbr_severe) },
    { key: "in_range", label: "3.9–10.0", pct: tir },
    { key: "high", label: "10.0–13.9", pct: r1(tar - tar_severe) },
    { key: "very_high", label: "Above 13.9", pct: tar_severe },
  ] as const;
}

/** The median curve of traces aligned at t0, in 5-minute steps, where two or more traces have a reading. */
export function medianTrace(traces: readonly HealthTrace[]): [number, number][] {
  const buckets = new Map<number, number[]>();
  for (const trace of traces)
    for (const [minute, value] of trace.points) {
      const step = Math.round(minute / 5) * 5;
      buckets.set(step, [...(buckets.get(step) ?? []), value]);
    }
  return [...buckets.entries()]
    .filter(([, values]) => values.length >= 2)
    .sort(([a], [b]) => a - b)
    .map(([step, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length / 2;
      return [
        step,
        r1(sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2),
      ];
    });
}

/** Minutes after `t0` of each possible sensor low inside [t0, t0 + minutes]. */
export function sensorLowsIn(report: HealthReport, t0: string, minutes: number): number[] {
  const start = local(t0);
  return report.possible_sensor_lows
    .map((low) => Math.round((local(low) - start) / MINUTE))
    .filter((offset) => offset >= 0 && offset <= minutes);
}

export const findingWindows = (report: HealthReport): Set<string> =>
  new Set(report.findings.map((f) => f.window));

export function runMessage(lastRun: HealthStatus["lastRun"]): string | null {
  if (lastRun === null) return null;
  switch (lastRun.outcome) {
    case "no_login":
      return "Tandem Source login missing: run glycolens login on the home PC.";
    case "no_data":
      return "glycolens has no data yet.";
    case "stale":
      return `The last fetch failed; the report uses stored data. ${lastRun.reason ?? ""}`.trim();
    case "failed":
      return `The last run failed: ${lastRun.reason ?? "no reason given"}`;
    default:
      return null;
  }
}

export const formatLocal = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
