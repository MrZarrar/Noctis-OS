import { describe, expect, it } from "vitest";

import { RAIL_ITEMS } from "./rail-items.js";

describe("RAIL_ITEMS", () => {
  it("is exactly the eight permanent items from Section 5.1, in order", () => {
    expect(RAIL_ITEMS).toEqual([
      "Command",
      "Chat",
      "Missions",
      "Artifacts",
      "Vault",
      "Nodes",
      "Automations",
      "Settings",
    ]);
  });

  it("has no duplicate item", () => {
    expect(new Set(RAIL_ITEMS).size).toBe(RAIL_ITEMS.length);
  });
});
