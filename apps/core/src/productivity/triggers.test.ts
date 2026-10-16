import { describe, expect, it } from "vitest";
import { lastWeeklyAt, latestTriggerAt, nextTriggerAt } from "./triggers.js";

const ms = (iso: string): number => Date.parse(iso);
const weekly = {
  kind: "repeat" as const,
  rule: { kind: "weekly" as const, daysOfWeek: [1], timeOfDay: "09:00", timeZone: "Europe/London" },
};

describe("deterministic productivity triggers", () => {
  it("leaves to-dos and PC triggers without a timer", () => {
    expect(nextTriggerAt(null, ms("2026-10-14T10:00:00Z"))).toBeUndefined();
    expect(nextTriggerAt({ kind: "at_pc", nodeId: "node", repeat: true }, 0)).toBeUndefined();
  });
  it("retains a one-shot instant, including one missed during shutdown", () => {
    expect(
      nextTriggerAt({ kind: "at", at: "2026-10-14T09:00:00Z" }, ms("2026-10-14T10:00:00Z")),
    ).toBe("2026-10-14T09:00:00.000Z");
  });
  it("resolves a weekly rule in the owner's zone across the autumn clock change", () => {
    expect(nextTriggerAt(weekly, ms("2026-10-18T12:00:00Z"))).toBe("2026-10-19T08:00:00.000Z");
    expect(nextTriggerAt(weekly, ms("2026-10-19T08:00:00Z"))).toBe("2026-10-26T09:00:00.000Z");
  });
  it("chooses one occurrence at an ambiguous wall time and skips a nonexistent one", () => {
    const sunday = {
      kind: "repeat" as const,
      rule: { ...weekly.rule, daysOfWeek: [0], timeOfDay: "01:30" },
    };
    expect(nextTriggerAt(sunday, ms("2026-10-24T12:00:00Z"))).toBe("2026-10-25T00:30:00.000Z");
    expect(nextTriggerAt(sunday, ms("2026-10-25T00:30:00Z"))).toBe("2026-11-01T01:30:00.000Z");
    expect(nextTriggerAt(sunday, ms("2026-03-28T12:00:00Z"))).toBe("2026-04-05T00:30:00.000Z");
  });
  it("catches up only the latest interval after a long shutdown, preserving cadence", () => {
    const trigger = { kind: "repeat" as const, rule: { kind: "interval" as const, hours: 2 } };
    const due = "2026-10-10T09:00:00.000Z";
    expect(nextTriggerAt(trigger, ms(due))).toBe("2026-10-10T11:00:00.000Z");
    expect(latestTriggerAt(trigger, due, ms("2026-10-14T10:30:00Z"))).toBe(
      "2026-10-14T09:00:00.000Z",
    );
  });
  it("catches up only the latest weekly occurrence", () => {
    expect(latestTriggerAt(weekly, "2026-09-28T08:00:00Z", ms("2026-10-14T10:30:00Z"))).toBe(
      "2026-10-12T08:00:00.000Z",
    );
  });
});

it("finds the latest Sunday across the clock change", () => {
  expect(
    lastWeeklyAt(
      { daysOfWeek: [0], timeOfDay: "20:00", timeZone: "Europe/London" },
      Date.parse("2026-11-04T09:00:00Z"),
    ),
  ).toBe(Date.parse("2026-11-01T20:00:00Z"));
});
