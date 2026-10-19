import { describe, expect, it } from "vitest";

import { UsageLimitsSchema, resetText, staleText, windowSeverity } from "./usage-limits-view.js";

describe("UsageLimitsSchema", () => {
  it("takes one provider's windows beside another provider's problem", () => {
    const response = {
      limits: [
        {
          providerId: "claude",
          hostId: "MUSHAF-PC",
          fiveHour: { usedPercent: 19, resetsAt: "2026-10-19T18:30:00.442Z" },
          weekly: { usedPercent: 68 },
        },
        { providerId: "codex", problem: "No connected PC runs Codex" },
      ],
    };

    expect(UsageLimitsSchema.parse(response)).toEqual(response);
  });

  it("refuses a percent or reset time it cannot show as given", () => {
    for (const fiveHour of [
      { usedPercent: -1 },
      { usedPercent: "19" },
      { usedPercent: 19, resetsAt: "tomorrow" },
    ]) {
      expect(
        UsageLimitsSchema.safeParse({ limits: [{ providerId: "claude", fiveHour }] }).success,
      ).toBe(false);
    }
  });
});

describe("resetText", () => {
  const now = new Date(2026, 9, 19, 10, 0);
  const after = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

  it("counts down under a day, never rounding a future reset to nothing", () => {
    expect(resetText(after(134), now)).toBe("2h 14m");
    expect(resetText(after(38), now)).toBe("38m");
    expect(resetText(after(0.1), now)).toBe("1m");
    expect(resetText(after(1439), now)).toBe("23h 59m");
  });

  it("names the local weekday and time for a reset a day or more away", () => {
    expect(resetText(new Date(2026, 9, 22, 11, 0).toISOString(), now)).toBe("Thu 11:00");
    expect(resetText(after(1440), now)).toBe("Tue 10:00");
  });

  it("says when the provider gave no reset rather than inventing one", () => {
    expect(resetText(undefined, now)).toBe("—");
    expect(resetText(after(-1), now)).toBe("now");
  });
});

describe("staleText", () => {
  const now = new Date(2026, 9, 19, 16, 0);

  it("says when a kept reading was taken once it is over ten minutes old", () => {
    expect(staleText(new Date(2026, 9, 19, 15, 41).toISOString(), now)).toBe("as of 15:41");
  });

  it("stays quiet for a fresh reading or one with no time", () => {
    expect(staleText(new Date(2026, 9, 19, 15, 55).toISOString(), now)).toBeUndefined();
    expect(staleText(undefined, now)).toBeUndefined();
  });
});

it("warns from 80% and alarms from 95%", () => {
  expect([0, 79.9, 80, 94.9, 95, 120].map(windowSeverity)).toEqual([
    "normal",
    "normal",
    "warning",
    "warning",
    "error",
    "error",
  ]);
});
