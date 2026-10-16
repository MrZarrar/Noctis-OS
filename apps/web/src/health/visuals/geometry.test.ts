import { describe, expect, it } from "vitest";

import { closeDay, ringAngles, splitAtGaps, traceDomain, valueAt } from "./geometry.js";

describe("valueAt", () => {
  const points: [number, number][] = [
    [0, 6],
    [5, 8],
    [10, 10],
    [40, 4],
  ];

  it("interpolates between readings and refuses across a CGM gap", () => {
    expect(valueAt(points, 0)).toBe(6);
    expect(valueAt(points, 2.5)).toBe(7);
    expect(valueAt(points, 20)).toBeUndefined();
    expect(valueAt(points, 41)).toBeUndefined();
  });
});

describe("splitAtGaps", () => {
  it("breaks a trace where readings are more than 15 minutes apart", () => {
    expect(
      splitAtGaps([
        [0, 6],
        [5, 8],
        [40, 4],
        [45, 5],
      ]),
    ).toEqual([
      [
        [0, 6],
        [5, 8],
      ],
      [
        [40, 4],
        [45, 5],
      ],
    ]);
  });
});

describe("traceDomain", () => {
  it("spans every trace and always shows the 3.9 to 10 corridor", () => {
    expect(
      traceDomain([
        {
          points: [
            [0, 6],
            [240, 9],
          ],
        },
        {
          points: [
            [0, 7],
            [300, 16],
          ],
        },
      ]),
    ).toEqual({
      minutes: 300,
      low: 2,
      high: 17,
    });
    expect(traceDomain([]).high).toBeGreaterThanOrEqual(12);
  });
});

describe("ringAngles", () => {
  it("lays segments round the circle in order, skipping empty ones", () => {
    const arcs = ringAngles([
      { key: "a", pct: 25 },
      { key: "b", pct: 0 },
      { key: "c", pct: 75 },
    ]);
    expect(arcs.map((arc) => arc.key)).toEqual(["a", "c"]);
    expect(arcs[0]!.start).toBe(0);
    expect(arcs[0]!.end).toBeCloseTo(Math.PI / 2);
    expect(arcs[1]!.end).toBeCloseTo(2 * Math.PI);
  });

  it("scales to the total, so rounding never leaves a gap or overlap", () => {
    const arcs = ringAngles([
      { key: "a", pct: 33.3 },
      { key: "b", pct: 33.3 },
      { key: "c", pct: 33.3 },
    ]);
    expect(arcs.at(-1)!.end).toBeCloseTo(2 * Math.PI);
  });
});

describe("closeDay", () => {
  it("repeats midnight at hour 24 so the clock closes", () => {
    const day = Array.from({ length: 24 }, (_, hour) => ({ hour, p50: hour }));
    const closed = closeDay(day);
    expect(closed).toHaveLength(25);
    expect(closed.at(-1)).toEqual({ hour: 24, p50: 0 });
  });
});
