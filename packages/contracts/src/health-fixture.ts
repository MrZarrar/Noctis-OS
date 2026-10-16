import type { z } from "zod";

import type { HealthReportSchema } from "./health.js";

type Report = z.input<typeof HealthReportSchema>;

const r1 = (value: number): number => Math.round(value * 10) / 10;

/** A smooth synthetic curve: `minutes` long, rising by `rise` at its middle. */
function curve(start: number, rise: number, minutes: number): [number, number][] {
  return Array.from({ length: minutes / 5 + 1 }, (_, i) => [
    i * 5,
    r1(start + rise * Math.sin((Math.PI * i * 5) / minutes)),
  ]);
}

function stats(tir: number) {
  return {
    coverage: 0.96,
    mean: 8.4,
    tir,
    tbr: 3.1,
    tbr_severe: 0.6,
    tar: r1(100 - tir - 3.1),
    tar_severe: 4.2,
    gmi: 6.9,
    cv: 34.5,
    min: 2.6,
  };
}

/** A synthetic fortnight in the shape glycolens writes. For tests and the visual preview only. */
export function healthReportFixture(): Report {
  return {
    schema_version: 1,
    generated_at: "2026-10-11T20:03:12",
    period: { start: "2026-09-27T19:55:00", end: "2026-10-11T19:56:00", days: 14 },
    data_through: "2026-10-11T19:55:00",
    stale_since: null,
    summary: "Synthetic fortnight for tests.",
    summary_source: "template",
    stats: stats(71.4),
    windows: [
      { name: "overnight", start: "00:00", end: "06:00", ...stats(82) },
      { name: "breakfast", start: "06:00", end: "11:00", ...stats(58.2) },
      { name: "lunch", start: "11:00", end: "17:00", ...stats(70.1) },
      { name: "dinner", start: "17:00", end: "24:00", ...stats(68.9) },
    ],
    agp: Array.from({ length: 24 }, (_, hour) => {
      const median = 7 + 2 * Math.sin(((hour - 6) / 24) * 2 * Math.PI);
      return {
        hour,
        p5: r1(median - 3),
        p25: r1(median - 1.2),
        p50: r1(median),
        p75: r1(median + 1.5),
        p95: r1(median + 4),
      };
    }),
    findings: [
      {
        rule: "carb_ratio",
        window: "breakfast",
        direction: "stronger",
        events: 3,
        hits: 2,
        metric: 3.4,
        text: "Breakfast: 2 of 3 meals ended high (median +3.4 mmol/L at 4h).",
        evidence: ["Mon 05 Oct 07:40: +3.6 at 4h", "Wed 07 Oct 07:55: +3.2 at 4h"],
        traces: [
          { t0: "2026-10-05T07:40:00", hit: true, carbs: 45, points: curve(7.2, 5, 240) },
          { t0: "2026-10-07T07:55:00", hit: true, carbs: 50, points: curve(6.8, 5.5, 240) },
          { t0: "2026-10-09T08:10:00", hit: false, carbs: 40, points: curve(6.5, 2, 240) },
        ],
      },
      {
        rule: "isf",
        window: "overnight",
        direction: "weaker",
        events: 2,
        hits: 2,
        metric: 1.6,
        text: "Overnight: corrections dropped 1.6x what your correction factor predicts (2 of 2).",
        evidence: ["Tue 06 Oct 02:00: 1.5 U, dropped 4.8"],
        traces: [
          {
            t0: "2026-10-06T02:00:00",
            hit: true,
            units: 1.5,
            expected_drop: 3,
            points: curve(13.1, -4.8, 300),
          },
          {
            t0: "2026-10-08T01:30:00",
            hit: true,
            units: 1,
            expected_drop: 2,
            points: curve(12.4, -3.6, 300),
          },
        ],
      },
      {
        rule: "basal",
        window: "overnight",
        direction: "stronger",
        events: 2,
        hits: 1,
        metric: 1.32,
        text: "Overnight: on 1 of 2 fasting days Control-IQ ran basal at a median 132% of programmed.",
        evidence: ["Mon 05 Oct: 132% of programmed"],
        traces: [
          {
            t0: "2026-10-05T00:00:00",
            hit: true,
            ratio: 1.32,
            basal: [
              [0, 1.1],
              [60, 1.4],
              [120, null],
              [180, 1.5],
              [240, 1.3],
              [300, 1.2],
            ],
            points: curve(8, 2, 360),
          },
          {
            t0: "2026-10-06T00:00:00",
            hit: false,
            ratio: 1.02,
            basal: [
              [0, 1],
              [60, 1],
              [120, 1.1],
              [180, 1],
              [240, 0.9],
              [300, 1.1],
            ],
            points: curve(7.4, 0.6, 360),
          },
        ],
      },
    ],
    suggestions: [
      {
        id: "2026-W41-breakfast-carb_ratio",
        window: "breakfast",
        setting: "carb_ratio",
        direction: "stronger",
        current: 10,
        proposed: 9,
        step_pct: 10,
        text: "Breakfast: consider strengthening your carb ratio from 10 to 9 g/U (10%).",
        evidence: ["Mon 05 Oct 07:40: +3.6 at 4h"],
        status: "proposed",
      },
    ],
    watching: [{ window: "lunch", rule: "pre_bolus", reason: "2 of 5 meals so far; needs 3" }],
    changes: [
      {
        id: "2026-W38-overnight-basal",
        window: "overnight",
        setting: "basal",
        direction: "stronger",
        current: 0.8,
        proposed: 0.88,
        applied_at: "2026-09-21T21:00:00",
        outcome: "helped",
        outcome_final: false,
        before: stats(64),
        after: stats(71.4),
      },
    ],
    possible_sensor_lows: ["2026-10-05T03:10:00"],
  };
}
