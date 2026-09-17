import { describe, expect, it } from "vitest";

import { RAIL_ITEMS } from "./rail-items.js";
import { TAB_ITEMS, tabsFor } from "./tab-items.js";

describe("tabsFor", () => {
  it("shows the four primary destinations", () => {
    expect(tabsFor("Command").tabs).toEqual(TAB_ITEMS);
  });

  it("puts everything that is not a tab in the overflow", () => {
    const { tabs, overflow } = tabsFor("Command");

    expect([...tabs, ...overflow].sort()).toEqual([...RAIL_ITEMS].sort());
  });

  it("promotes the active item into the bar when it lives in the overflow, so the phone always shows where it is", () => {
    const { tabs, overflow } = tabsFor("Nodes");

    expect(tabs).toContain("Nodes");
    expect(overflow).not.toContain("Nodes");
    expect(tabs).toHaveLength(TAB_ITEMS.length);
  });

  it("drops the last primary tab to make room, never Command or Chat", () => {
    const { tabs } = tabsFor("Nodes");

    expect(tabs).toContain("Command");
    expect(tabs).toContain("Chat");
  });

  it("changes nothing when the active item is already a tab", () => {
    expect(tabsFor("Chat").tabs).toEqual(TAB_ITEMS);
  });
});
