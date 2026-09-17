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

  it("keeps the displaced tab reachable, instead of hiding it from both the bar and the sheet", () => {
    const { tabs, overflow } = tabsFor("Nodes");
    const displaced = TAB_ITEMS[TAB_ITEMS.length - 1];

    expect(tabs).not.toContain(displaced);
    expect(overflow).toContain(displaced);
    // Nothing is lost while an overflow destination is active, which is the
    // only state in which anything could be.
    expect([...tabs, ...overflow].sort()).toEqual([...RAIL_ITEMS].sort());
  });

  it("changes nothing when the active item is already a tab", () => {
    expect(tabsFor("Chat").tabs).toEqual(TAB_ITEMS);
  });
});
