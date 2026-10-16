/**
 * The v1 destinations: what the owner opens Noctis for, from the phone first.
 * Threads is where an agent is started or continued on any PC, Files is what
 * the agents produced, Nodes is the PCs themselves, Approvals is what is
 * waiting on the owner, Health is the weekly glucose report, and Vault is the
 * shared memory.
 */
export const NAV_ITEMS = [
  "Presence",
  "Threads",
  "Files",
  "Nodes",
  "Approvals",
  /** glycolens's weekly report from the home PC. */
  "Health",
  "Vault",
  "Reminders",
  "To-dos",
  "Notes",
] as const;

/**
 * Pages built before v1 narrowed the product. They stay in the code and
 * working, offered only when the all-pages flag is set.
 */
export const HIDDEN_ITEMS = ["Missions", "Artifacts", "Automations"] as const;

/** Settings is a page too, but it has its own control rather than a slot. */
export type RailItem = (typeof NAV_ITEMS)[number] | (typeof HIDDEN_ITEMS)[number] | "Settings";

export function railItems(allPages: boolean): readonly RailItem[] {
  return allPages ? [...NAV_ITEMS, ...HIDDEN_ITEMS] : NAV_ITEMS;
}
