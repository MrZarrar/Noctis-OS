import { describe, expect, it } from "vitest";

import { HIDDEN_ITEMS, NAV_ITEMS, railItems } from "./rail-items.js";

describe("v1 navigation", () => {
  it("is exactly the five v1 destinations, in order", () => {
    expect(NAV_ITEMS).toEqual(["Threads", "Files", "Nodes", "Approvals", "Vault"]);
  });

  it("shows only the v1 destinations unless every page is asked for", () => {
    expect(railItems(false)).toEqual(NAV_ITEMS);
  });

  it("keeps the earlier pages reachable behind the flag, after the v1 ones", () => {
    expect(railItems(true)).toEqual([...NAV_ITEMS, ...HIDDEN_ITEMS]);
    expect(HIDDEN_ITEMS).toEqual(["Command", "Missions", "Artifacts", "Automations"]);
  });

  it("never lists Settings as a destination, because it has its own control", () => {
    expect(railItems(true)).not.toContain("Settings");
  });

  it("has no duplicate item", () => {
    const all = railItems(true);

    expect(new Set(all).size).toBe(all.length);
  });
});
