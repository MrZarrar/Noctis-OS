import { describe, expect, it } from "vitest";

import {
  confirmationMatches,
  confirmationPhraseFor,
  requiresTypedConfirmation,
} from "./confirmation.js";

const target = { type: "listing", id: "vinted-4821" } as const;

describe("confirmationMatches", () => {
  const phrase = confirmationPhraseFor({ operationClass: "destructive", target }) as string;

  it("accepts the exact phrase, and the same phrase with stray outer whitespace", () => {
    expect(confirmationMatches(phrase, phrase)).toBe(true);
    expect(confirmationMatches(phrase, `  ${phrase}\n`)).toBe(true);
  });

  it("THE GATE: rejects a near miss rather than being helpful about it", () => {
    expect(confirmationMatches(phrase, phrase.toLowerCase())).toBe(false);
    expect(confirmationMatches(phrase, phrase.replace("vinted-4821", "vinted-4822"))).toBe(false);
    expect(confirmationMatches(phrase, "DESTROY")).toBe(false);
    expect(confirmationMatches(phrase, "")).toBe(false);
    expect(confirmationMatches(phrase, undefined)).toBe(false);
  });
});

describe("requiresTypedConfirmation", () => {
  it("is true for exactly the four classes Section 9.1 names", () => {
    expect(requiresTypedConfirmation("spend")).toBe(true);
    expect(requiresTypedConfirmation("destructive")).toBe(true);
    expect(requiresTypedConfirmation("production_deploy")).toBe(true);
    expect(requiresTypedConfirmation("credential_security")).toBe(true);
    expect(requiresTypedConfirmation("publish")).toBe(false);
    expect(requiresTypedConfirmation("external_write")).toBe(false);
    expect(requiresTypedConfirmation("read_inspect")).toBe(false);
  });
});

describe("confirmationPhraseFor", () => {
  it("treats a missing estimate as zero rather than omitting the amount", () => {
    // A spend phrase with no amount in it would confirm an unbounded spend.
    expect(confirmationPhraseFor({ operationClass: "spend", target })).toBe(
      "SPEND GBP 0.00 ON listing:vinted-4821",
    );
  });

  it("rounds to pence rather than carrying a float into the phrase", () => {
    expect(
      confirmationPhraseFor({ operationClass: "spend", target, estimatedCostGbp: 1.005 }),
    ).toContain("GBP 1.01");
    expect(
      confirmationPhraseFor({ operationClass: "spend", target, estimatedCostGbp: 1234 }),
    ).toContain("GBP 1234.00");
  });
});
