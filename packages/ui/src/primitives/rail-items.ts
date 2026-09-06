/**
 * Section 5.1: "The rail contains exactly" these eight items, in this order.
 * NOIR, Jester, and Objective are deliberately absent — they are a protocol
 * overlay, an identity, and state, not permanent navigation destinations.
 */
export const RAIL_ITEMS = [
  "Command",
  "Chat",
  "Missions",
  "Artifacts",
  "Vault",
  "Nodes",
  "Automations",
  "Settings",
] as const;

export type RailItem = (typeof RAIL_ITEMS)[number];
