import { describe, expect, it } from "vitest";

import { offeredModels } from "./PromptForm.js";

const CLAUDE = { providerId: "claude" as const, model: "opus" };
const LOCAL = { providerId: "local" as const, model: "qwen/qwen3.5-9b" };
const HERMES = { providerId: "hermes" as const, model: "qwen/qwen3.5-9b" };

describe("offeredModels", () => {
  it("offers Jester Hermes alone, since Jester is Hermes (ADR-0030)", () => {
    expect(offeredModels("jester", [CLAUDE, LOCAL, HERMES])).toEqual([HERMES]);
    expect(offeredModels("jester", [CLAUDE])).toEqual([]);
  });

  it("offers Vesper every agent", () => {
    expect(offeredModels("vesper", [CLAUDE, LOCAL, HERMES])).toEqual([CLAUDE, LOCAL, HERMES]);
  });
});
