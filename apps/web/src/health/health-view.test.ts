import { HealthReportSchema, healthReportFixture } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { medianTrace, runMessage, sensorLowsIn, tirSegments, viewState } from "./health-view.js";

const base = {
  granted: true,
  nodeId: null,
  nodeOnline: true,
  busy: null,
  lastRun: null,
  weeklyAt: "20:00",
  proposed: 1,
};
const ok = (report: unknown) => ({
  ...base,
  report: { state: "ok" as const, receivedAt: "2026-10-11T19:04:00.000Z", report },
});

describe("viewState", () => {
  it("shows the report fresh within 8 days", () => {
    expect(viewState(ok(healthReportFixture()), new Date("2026-10-18T12:00:00"))).toMatchObject({
      kind: "ok",
      staleSince: null,
    });
  });

  it("shows the stale banner past 8 days even when stale_since is null", () => {
    expect(viewState(ok(healthReportFixture()), new Date("2026-10-20T20:04:00"))).toMatchObject({
      staleSince: "2026-10-11T20:03:12",
    });
  });

  it("prefers glycolens's own stale_since", () => {
    const report = { ...healthReportFixture(), stale_since: "2026-10-09T08:00:00" };
    expect(viewState(ok(report), new Date("2026-10-12T00:00:00"))).toMatchObject({
      staleSince: "2026-10-09T08:00:00",
    });
  });

  it("turns a report the page cannot read into unreadable, not a crash", () => {
    expect(viewState(ok({ schema_version: 1 }), new Date())).toMatchObject({ kind: "unreadable" });
    expect(viewState({ ...base, granted: false, report: { state: "none" } }, new Date())).toEqual({
      kind: "not_allowed",
    });
  });
});

describe("geometry", () => {
  const report = HealthReportSchema.parse(healthReportFixture());

  it("splits time in range into five labelled bands that sum to 100", () => {
    const bands = tirSegments(report.stats)!;
    expect(bands.map((b) => b.key)).toEqual(["very_low", "low", "in_range", "high", "very_high"]);
    expect(bands[0]).toMatchObject({ label: "Below 3.0", pct: 0.6 });
    expect(bands[1]).toMatchObject({ label: "3.0–3.9", pct: 2.5 });
    expect(Math.round(bands.reduce((sum, b) => sum + b.pct, 0))).toBe(100);
    expect(tirSegments({ ...report.stats, tir: null })).toBeNull();
  });

  it("draws the median of aligned traces only where two or more overlap", () => {
    const median = medianTrace([
      {
        t0: "2026-10-05T07:40:00",
        hit: true,
        points: [
          [0, 6],
          [5, 8],
        ],
      },
      {
        t0: "2026-10-06T07:40:00",
        hit: false,
        points: [
          [0, 8],
          [5, 10],
          [10, 12],
        ],
      },
    ]);
    expect(median).toEqual([
      [0, 7],
      [5, 9],
    ]);
  });

  it("finds possible sensor lows inside a chart's time span", () => {
    expect(sensorLowsIn(report, "2026-10-05T00:00:00", 360)).toEqual([190]);
    expect(sensorLowsIn(report, "2026-10-06T00:00:00", 360)).toEqual([]);
  });

  it("says what to do after a run that could not log in", () => {
    expect(runMessage({ at: "2026-10-18T19:05:00.000Z", outcome: "no_login" })).toBe(
      "Tandem Source login missing: run glycolens login on the home PC.",
    );
    expect(runMessage(null)).toBeNull();
  });
});
