import { describe, expect, it } from "vitest";

import { band, trendGlyph } from "./glucose-live-view.js";

describe("band", () => {
  it("is low under 3.9 mmol/L", () => {
    expect(band(3.8)).toBe("low");
    expect(band(2.0)).toBe("low");
  });

  it("is high over 10.0 mmol/L", () => {
    expect(band(10.1)).toBe("high");
    expect(band(15)).toBe("high");
  });

  it("is normal between the two", () => {
    expect(band(3.9)).toBe("normal");
    expect(band(6.5)).toBe("normal");
    expect(band(10.0)).toBe("normal");
  });
});

describe("trendGlyph", () => {
  it("maps every trend to an arrow", () => {
    expect(trendGlyph("doubleUp")).toBe("⇈");
    expect(trendGlyph("singleUp")).toBe("↑");
    expect(trendGlyph("fortyFiveUp")).toBe("↗");
    expect(trendGlyph("flat")).toBe("→");
    expect(trendGlyph("fortyFiveDown")).toBe("↘");
    expect(trendGlyph("singleDown")).toBe("↓");
    expect(trendGlyph("doubleDown")).toBe("⇊");
    expect(trendGlyph("unknown")).toBe("");
  });
});
