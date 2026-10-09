import { describe, expect, it } from "vitest";

import { clockText, greetingFor, msToNextMinute } from "./clock.js";

const at = (iso: string): Date => new Date(iso);

describe("the Presence clock", () => {
  it("shows 24-hour time and the day, the way the owner reads them in the UK", () => {
    expect(clockText(new Date(2026, 9, 9, 7, 5))).toEqual({
      time: "07:05",
      day: "Friday 9 October",
    });
  });

  it("greets by the hour it is now, not the hour the page opened", () => {
    expect(greetingFor(new Date(2026, 9, 9, 11, 59))).toBe("Good morning.");
    expect(greetingFor(new Date(2026, 9, 9, 12, 0))).toBe("Good afternoon.");
    expect(greetingFor(new Date(2026, 9, 9, 18, 0))).toBe("Good evening.");
  });

  it("ticks on the minute, not a second late", () => {
    expect(msToNextMinute(at("2026-10-09T07:05:59.250Z"))).toBe(750);
    expect(msToNextMinute(at("2026-10-09T07:06:00.000Z"))).toBe(60_000);
  });
});
