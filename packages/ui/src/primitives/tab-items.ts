import type { RailItem } from "./rail-items.js";
import { RAIL_ITEMS } from "./rail-items.js";

/**
 * What a phone is for. Command is where a prompt is written and Chat is where
 * the answer streams, so those two are never displaced; Missions and Vault are
 * the two destinations worth a thumb. The other four reach the phone through
 * "More", which is the donor's own answer to the same problem.
 */
export const TAB_ITEMS = [
  "Command",
  "Chat",
  "Missions",
  "Vault",
] as const satisfies readonly RailItem[];

export interface TabLayout {
  tabs: readonly RailItem[];
  overflow: readonly RailItem[];
}

/**
 * A bar that cannot show where you are is worse than one item short, so an
 * active overflow destination takes the last primary slot for as long as it is
 * active. Command and Chat are never the slot that gives way.
 */
export function tabsFor(active: RailItem): TabLayout {
  const overflow = RAIL_ITEMS.filter((item) => !TAB_ITEMS.includes(item as never));

  if (!overflow.includes(active)) {
    return { tabs: TAB_ITEMS, overflow };
  }

  return {
    tabs: [...TAB_ITEMS.slice(0, TAB_ITEMS.length - 1), active],
    overflow: overflow.filter((item) => item !== active),
  };
}
