import { describe, expect, it } from "vitest";
import {
  localToInstant,
  triggerLabel,
  searchNotes,
  compareReminders,
  reminderDueAt,
  reminderDueLabel,
} from "./productivity-view.js";
import type { Reminder } from "@noctis/contracts";

const reminder = (patch: Partial<Reminder> = {}): Reminder => ({
  id: "00000000-0000-7000-8000-000000000001",
  revision: 1,
  createdAt: "2026-10-16T08:00:00Z",
  updatedAt: "2026-10-16T08:00:00Z",
  text: "Review the day",
  trigger: null,
  status: "pending",
  ...patch,
});

describe("reminder agenda", () => {
  const now = Date.parse("2026-10-16T09:00:00Z");
  it("orders by next due time, falls back to a timed trigger and puts done last", () => {
    const later = reminder({ nextDueAt: "2026-10-16T12:00:00Z" });
    const earlier = reminder({
      trigger: { kind: "at", at: "2026-10-16T10:00:00Z" },
    });
    const done = reminder({ status: "done", nextDueAt: "2026-10-15T08:00:00Z" });
    const undated = reminder();
    expect([done, undated, later, earlier].sort(compareReminders)).toEqual([
      earlier,
      later,
      undated,
      done,
    ]);
    expect(reminderDueAt(reminder({ ...earlier, nextDueAt: later.nextDueAt }))).toBe(
      later.nextDueAt,
    );
    expect(compareReminders(undated, reminder())).toBe(0);
  });
  it("labels overdue, due now, due within an hour and later reminders", () => {
    expect(reminderDueLabel(reminder({ nextDueAt: "2026-10-16T08:59:00Z" }), now)).toBe("Overdue");
    expect(reminderDueLabel(reminder({ nextDueAt: "2026-10-16T09:00:00Z" }), now)).toBe("Due now");
    expect(reminderDueLabel(reminder({ nextDueAt: "2026-10-16T10:00:00Z" }), now)).toBe("Due soon");
    expect(reminderDueLabel(reminder({ nextDueAt: "2026-10-16T10:01:00Z" }), now)).toBe("Upcoming");
    expect(reminderDueLabel(reminder({ status: "due" }), now)).toBe("Due now");
  });
  it("keeps snoozed and done records out of overdue treatment", () => {
    for (const status of ["snoozed", "done"] as const) {
      expect(reminderDueLabel(reminder({ status, nextDueAt: "2026-10-15T08:00:00Z" }), now)).toBe(
        status,
      );
    }
    expect(reminderDueLabel(reminder(), now)).toBe("To do");
    expect(
      reminderDueLabel(
        reminder({ trigger: { kind: "at_pc", nodeId: "home", repeat: false } }),
        now,
      ),
    ).toBe("At your PC");
    expect(
      reminderDueLabel(
        reminder({ trigger: { kind: "repeat", rule: { kind: "interval", hours: 24 } } }),
        now,
      ),
    ).toBe("Scheduled");
  });
  it("keeps a due recurring reminder urgent after the core advances its next occurrence", () => {
    expect(
      reminderDueLabel(
        reminder({
          status: "due",
          nextDueAt: "2026-10-17T09:00:00Z",
          trigger: { kind: "repeat", rule: { kind: "interval", hours: 24 } },
        }),
        now,
      ),
    ).toBe("Due now");
  });
});
describe("productivity owner time and search", () => {
  it("resolves London summer time independently of the browser zone", () => {
    expect(localToInstant("2027-07-01T09:00")).toBe("2027-07-01T08:00:00.000Z");
  });
  it("rejects a nonexistent spring clock time", () => {
    expect(() => localToInstant("2027-03-28T01:30")).toThrow();
  });
  it("searches both note title and body case insensitively", () => {
    expect(searchNotes([{ title: "Trip", body: "Bring PASSPORT" }], "passport")).toHaveLength(1);
  });
  it("labels owner presence rather than connectivity", () => {
    expect(triggerLabel({ kind: "at_pc", nodeId: "home", repeat: true })).toContain("unlocked");
  });
});
import { snoozeUntil } from "./productivity-view.js";
it("snoozes tomorrow at nine in the owner zone across clock changes", () => {
  expect(snoozeUntil("tomorrow", new Date("2027-03-27T15:00:00Z"))).toBe(
    "2027-03-28T08:00:00.000Z",
  );
});
