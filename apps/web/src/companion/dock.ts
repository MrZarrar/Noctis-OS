import type { IntelligenceState, RailItem } from "@noctis/ui";

export type Dock = {
  anchor: "slot" | "corner" | "hidden";
  slot?: "hero" | "composer";
  size: number;
};

/**
 * Where the one core sits on each page. Presence and Threads keep a place for it
 * in their own layout; everywhere else it waits in the corner beside the work.
 * The Vault draws its own sphere, so the core gives way there — except for an
 * approval, which the owner must never lose sight of.
 */
export function dockFor(page: RailItem, state: IntelligenceState, mobile: boolean): Dock {
  if (page === "Presence" || page === "Command") return { anchor: "slot", slot: "hero", size: 0 };
  if (page === "Threads") return { anchor: "slot", slot: "composer", size: 76 };
  if (page === "Vault" && state !== "waiting_for_approval") return { anchor: "hidden", size: 0 };
  return { anchor: "corner", size: cornerSize(mobile) };
}

/** Also where a page's slot falls back to while the page is not drawing it. */
export function cornerSize(mobile: boolean): number {
  return mobile ? 72 : 96;
}
