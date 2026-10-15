import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDailyTimer } from "./daily.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 15, 9, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a daily timer", () => {
  it("runs once a day at the time it is given", () => {
    const runs: number[] = [];
    const timer = createDailyTimer({
      clock: { now: () => Date.now() },
      at: () => "10:00",
      run: () => runs.push(1),
    });

    timer.start();
    vi.advanceTimersByTime(60 * 60_000);
    expect(runs).toHaveLength(1);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(runs).toHaveLength(2);
    timer.stop();
  });

  it("does nothing when the time is empty", () => {
    const runs: number[] = [];
    const timer = createDailyTimer({
      clock: { now: () => Date.now() },
      at: () => "",
      run: () => runs.push(1),
    });

    timer.start();
    vi.advanceTimersByTime(48 * 60 * 60_000);
    expect(runs).toHaveLength(0);
  });

  it("reschedules once when the time changes, so nothing runs twice", () => {
    const runs: number[] = [];
    let at = "10:00";
    const timer = createDailyTimer({
      clock: { now: () => Date.now() },
      at: () => at,
      run: () => runs.push(1),
    });

    timer.start();
    at = "11:00";
    timer.restart();
    at = "12:00";
    timer.restart();
    vi.advanceTimersByTime(4 * 60 * 60_000);

    expect(runs).toHaveLength(1);
    timer.stop();
  });
});
