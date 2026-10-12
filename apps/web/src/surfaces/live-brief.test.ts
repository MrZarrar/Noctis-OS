import { describe, expect, it } from "vitest";

import { elapsedText } from "./LiveBrief.js";

const START = "2026-10-12T09:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(START) + minutes * 60_000);

describe("elapsedText", () => {
  it("counts from the real start in whole minutes, then hours", () => {
    expect(elapsedText(START, at(0.5))).toBe("under a minute");
    expect(elapsedText(START, at(4.9))).toBe("4 min");
    expect(elapsedText(START, at(60))).toBe("1 h");
    expect(elapsedText(START, at(125))).toBe("2 h 5 min");
  });

  it("never shows a negative time when the clocks disagree", () => {
    expect(elapsedText(START, at(-3))).toBe("under a minute");
  });
});
