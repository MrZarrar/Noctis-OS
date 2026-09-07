import { describe, expect, it } from "vitest";

import { AA_NON_TEXT, AA_TEXT, contrastRatio, relativeLuminance } from "./contrast.js";
import { depth } from "./depth.js";
import { identityAccent } from "./identity.js";
import { semantic } from "./semantic.js";
import { typography } from "./type.js";

/**
 * The contrast sweep Phases 5 and 6 left outstanding.
 *
 * Every colour the product actually paints text in, against every ground it
 * can be painted on. It is a table rather than a spot check because the failure
 * mode is a single unlucky pairing — a warning that reads on the floor and
 * disappears on the third depth layer — and a spot check is exactly what misses
 * that one.
 */

/** Every opaque ground a Surface can sit on: the floor plus the four layers. */
const GROUNDS: ReadonlyArray<[string, string]> = [
  ["floor", depth.floor],
  ...depth.layers.map((layer, index): [string, string] => [`layer ${String(index)}`, layer]),
];

/** Colours passed to `color:` somewhere in `packages/ui` or `apps/web`. */
const TEXT: ReadonlyArray<[string, string]> = [
  ["typography.color.primary", typography.color.primary],
  ["typography.color.muted", typography.color.muted],
  ["semantic.warning", semantic.warning],
  ["semantic.error", semantic.error],
  ["semantic.stale", semantic.stale],
];

/**
 * Colours that carry no text: freshness dots, the Vault node markers, and the
 * borders that mark a focused control. WCAG holds these to 3:1, and every one
 * of them is paired with a word elsewhere in the same element — the ratio keeps
 * them visible, the word keeps them meaningful.
 */
const NON_TEXT: ReadonlyArray<[string, string]> = [
  ["semantic.success", semantic.success],
  ["semantic.current", semantic.current],
  ["semantic.unavailable", semantic.unavailable],
  ["semantic.approval", semantic.approval],
  ["identityAccent.vesper.primary", identityAccent.vesper.primary],
  ["identityAccent.jester.primary", identityAccent.jester.primary],
  ["identityAccent.jester.secondary", identityAccent.jester.secondary],
  ["identityAccent.noir.structure", identityAccent.noir.structure],
  ["identityAccent.noir.amber", identityAccent.noir.amber],
  ["identityAccent.noir.red", identityAccent.noir.red],
];

describe("contrastRatio", () => {
  it("agrees with the two ratios everyone knows", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });

  it("is symmetric: an ordering mistake cannot pass a failing pair", () => {
    expect(contrastRatio("#8B7CF6", "#050409")).toBeCloseTo(contrastRatio("#050409", "#8B7CF6"), 9);
  });

  it("reads a three-digit hex the same as its six-digit form", () => {
    expect(relativeLuminance("#fff")).toBeCloseTo(relativeLuminance("#ffffff"), 9);
  });

  it("refuses a colour it cannot measure rather than scoring it", () => {
    // `material.*` are rgba overlays; scoring one against a ground it is
    // composited over would be a number that means nothing.
    expect(() => contrastRatio("rgba(255, 255, 255, 0.04)", "#050409")).toThrow();
  });
});

describe("THE GATE: every text colour is legible on every ground", () => {
  for (const [textName, text] of TEXT) {
    for (const [groundName, ground] of GROUNDS) {
      it(`${textName} on ${groundName}`, () => {
        const ratio = contrastRatio(text, ground);

        expect(
          ratio,
          `${textName} on ${groundName} is ${ratio.toFixed(2)}:1, below AA's ${String(AA_TEXT)}:1`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  }
});

describe("THE GATE: every indicator colour is visible on every ground", () => {
  for (const [name, colour] of NON_TEXT) {
    for (const [groundName, ground] of GROUNDS) {
      it(`${name} on ${groundName}`, () => {
        const ratio = contrastRatio(colour, ground);

        expect(
          ratio,
          `${name} on ${groundName} is ${ratio.toFixed(2)}:1, below AA's ${String(AA_NON_TEXT)}:1 for a UI component`,
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
      });
    }
  }
});

describe("colour is never the sole carrier of meaning", () => {
  it("keeps unavailable and unknown on one colour, so only the word separates them", () => {
    // Asserted here so that giving `unknown` its own hue — which would look
    // like an improvement — has to be a deliberate change to this test.
    expect(semantic.unavailable).toBe("#7A7A85");
    expect(semantic.current).toBe(semantic.success);
    expect(semantic.stale).toBe(semantic.warning);
  });
});
