import { describe, expect, it } from "vitest";

import { offeredModels, rootOption } from "./PromptForm.js";

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

describe("rootOption", () => {
  const ROOT = {
    grantId: "grant-1",
    path: "C:\\Users\\owner\\Documents",
    mode: "write" as const,
    localOnly: false,
    nodeId: "node-1",
    hostId: "home",
    connected: true,
  };

  it("names a folder by its machine and last segment, with nothing to add when it is awake", () => {
    expect(rootOption(ROOT)).toEqual({ value: "grant-1", label: "Documents on home" });
  });

  it("says offline and read only beside the name rather than inside it", () => {
    expect(rootOption({ ...ROOT, connected: false })).toMatchObject({
      label: "Documents on home",
      detail: "offline",
    });
    expect(rootOption({ ...ROOT, mode: "read" })).toMatchObject({ detail: "read only" });
    expect(rootOption({ ...ROOT, connected: false, mode: "read" })).toMatchObject({
      detail: "offline · read only",
    });
  });
});
