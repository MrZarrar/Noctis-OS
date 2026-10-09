import { expect, it } from "vitest";

import { localMidnight, todayLine } from "./digest-view.js";

const digest = (turns: number, files: number, outputs: number, asked: number) => ({
  turns: { total: turns, completed: turns, failed: 0, cancelled: 0 },
  files,
  outputs,
  approvals: { asked, approved: asked, declined: 0, unanswered: 0 },
});

it("sums the owner's day in a few words, and stays quiet when nothing happened", () => {
  expect(todayLine(digest(6, 2, 0, 1))).toBe("Today · 6 turns · 2 files · 1 approval");
  expect(todayLine(digest(1, 0, 3, 0))).toBe("Today · 1 turn · 3 outputs");
  expect(todayLine(digest(0, 0, 0, 0))).toBeUndefined();
  expect(todayLine(undefined)).toBeUndefined();
});

it("starts the owner's day at their own midnight", () => {
  const midnight = localMidnight(new Date(2026, 9, 9, 21, 30));

  expect(midnight.getHours()).toBe(0);
  expect(midnight.getDate()).toBe(9);
});
