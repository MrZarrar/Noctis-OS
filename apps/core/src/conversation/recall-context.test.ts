import type { VaultRecallEvidence } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { promptWithRecall } from "./recall-context.js";

function evidence(overrides: Partial<VaultRecallEvidence> = {}): VaultRecallEvidence {
  return {
    itemId: "0199a000-0000-7000-8000-00000000000a",
    entityId: "0199a000-0000-7000-8000-00000000000b",
    path: "projects/noctis.md",
    span: { start: 0, end: 10 },
    quote: "The work PC runs the core",
    freshness: "current",
    ...overrides,
  };
}

describe("promptWithRecall", () => {
  it("fits complete recall lines around the prompt within the runtime limit", () => {
    const prompt = "x".repeat(12_000);
    const recalled = Array.from({ length: 6 }, (_, i) =>
      evidence({
        path: `projects/${"nested/".repeat(85)}note-${i}.md`,
        quote: "y".repeat(800),
      }),
    );
    const composed = promptWithRecall(prompt, recalled);

    expect(composed.length).toBeLessThanOrEqual(20_000);
    expect(composed.endsWith(`\n\n${prompt}`)).toBe(true);
    expect(composed).toContain(`${recalled[0]?.path} (current): ${"y".repeat(800)}`);
    expect(composed).not.toContain(recalled[5]?.path);
  });

  it("leaves a full prompt intact when no recall line fits", () => {
    const prompt = "x".repeat(20_000);
    expect(promptWithRecall(prompt, [evidence()])).toBe(prompt);
  });

  it("leaves a prompt alone when the Vault had nothing to say", () => {
    expect(promptWithRecall("what is the plan", [])).toBe("what is the plan");
  });

  it("names the note and its freshness on every line", () => {
    // Section 7: recall carries its provenance. A quote with no note behind it
    // is something the model cannot be checked on.
    const composed = promptWithRecall("what is the plan", [evidence({ freshness: "stale" })]);

    expect(composed).toContain("projects/noctis.md (stale): The work PC runs the core");
  });

  it("says Noctis looked it up, so the model never takes it for something the owner pasted", () => {
    const composed = promptWithRecall("tell me about my family", [evidence()]);

    expect(composed).toMatch(/^Noctis looked these up in the owner's MindVault/);
    expect(composed).toContain("the owner did not type them");
  });

  it("puts the owner's words last, so context never displaces the instruction", () => {
    const composed = promptWithRecall("what is the plan", [evidence()]);

    expect(composed.endsWith("what is the plan")).toBe(true);
  });

  it("keeps a whole paragraph, so a quote says something rather than just a name", () => {
    const paragraph = `Tolga ${"runs the Istanbul office and ".repeat(15)}`.trim();
    const composed = promptWithRecall("who is tolga", [evidence({ quote: paragraph })]);

    expect(paragraph.length).toBeGreaterThan(400);
    expect(composed).toContain(paragraph);
  });

  it("collapses a quote's own line breaks so one quote stays one line", () => {
    const composed = promptWithRecall("what is the plan", [
      evidence({ quote: "first line\n\nsecond line" }),
    ]);

    expect(composed).toContain("first line second line");
  });
});
