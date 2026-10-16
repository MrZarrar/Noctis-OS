import type { CompositionPlan, SurfaceIntent, SurfaceSize } from "@noctis/contracts";
import { z } from "zod";
import {
  fitRect,
  openingRect,
  type PanelWindows,
  type Viewport,
  type WindowRect,
} from "./arrange.js";

export interface FloatingPanel {
  id: string;
  title: string;
  revision: string;
  requestedAt: number;
  pinned: boolean;
  pendingPrimary?: boolean;
  size: SurfaceSize | undefined;
  minWidth: number;
}
export interface FloatingGroup {
  scope: string;
  panels: readonly FloatingPanel[];
  liveIds: readonly string[];
  windows: PanelWindows;
  viewport: Viewport;
  floating: boolean;
}
const SavedEntrySchema = z.object({
  id: z.string(),
  openedAt: z.number().finite(),
  touched: z.boolean(),
  tucked: z.boolean(),
  updated: z.boolean(),
  revision: z.string(),
});
type SavedEntry = z.infer<typeof SavedEntrySchema>;
export interface FloatingEntry extends SavedEntry {
  scope: string;
  title: string;
  pinned: boolean;
  floating: boolean;
  rect: WindowRect | undefined;
  geometry: WindowRect | undefined;
}
type BrowserStorage = Pick<Storage, "getItem" | "setItem">;
const keyOf = (scope: string, id: string): string => JSON.stringify([scope, id]);
const byOpening = (a: FloatingEntry, b: FloatingEntry): number =>
  a.openedAt - b.openedAt || keyOf(a.scope, a.id).localeCompare(keyOf(b.scope, b.id));

function tuckOldest(entries: readonly FloatingEntry[]): void {
  const open = entries.filter((entry) => !entry.pinned && !entry.tucked);
  const untouched = open.filter((entry) => !entry.touched).sort(byOpening);
  for (const entry of untouched.slice(0, Math.max(0, open.length - 4))) entry.tucked = true;
}

export function floatingSlots(
  plan: CompositionPlan,
  intents: readonly SurfaceIntent[],
  openedIds: readonly string[],
): CompositionPlan["slots"] {
  const returning = intents.filter(
    (intent) =>
      openedIds.includes(intent.id) &&
      plan.overflowSurfaceIds.includes(intent.id) &&
      intent.lifecycle !== "dismissed" &&
      intent.lifecycle !== "exiting",
  );
  return [
    ...plan.slots,
    ...returning.map((intent) => ({
      surfaceId: intent.id,
      region: intent.preferredRegion ?? ("right" as const),
      size: intent.minSize,
      order: 0,
      layer: 0,
    })),
  ];
}

/** One coordinator lets thread and Objective windows share both space and capacity. */
export class FloatingPanels {
  private readonly groups = new Map<string, FloatingGroup>();
  private readonly saved = new Map<string, SavedEntry[]>();
  private readonly listeners = new Set<() => void>();
  private readonly appliedWindows = new Map<string, string | undefined>();
  private entries: readonly FloatingEntry[] = [];

  constructor(private readonly storage?: () => BrowserStorage) {}

  snapshot = (): readonly FloatingEntry[] => this.entries;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  sync(owner: string, group: FloatingGroup): void {
    if (!this.saved.has(group.scope)) {
      let entries: SavedEntry[] = [];
      try {
        const raw = this.storage?.().getItem(`${group.scope}:openPanels`);
        const parsed = z.array(SavedEntrySchema).safeParse(raw ? JSON.parse(raw) : undefined);
        if (parsed.success) entries = parsed.data;
      } catch {
        /* A private browser may refuse storage. */
      }
      this.saved.set(group.scope, entries);
    }
    this.groups.set(owner, group);
    this.rebuild();
  }

  remove(owner: string): void {
    this.groups.delete(owner);
    this.rebuild();
  }

  touch(scope: string, id: string): void {
    const entry = this.saved.get(scope)?.find((value) => value.id === id);
    if (entry === undefined || entry.touched) return;
    entry.touched = true;
    this.rebuild();
  }

  reopen(scope: string, id: string): boolean {
    const entry = this.saved.get(scope)?.find((value) => value.id === id);
    const group = [...this.groups.values()].find(
      (value) => value.scope === scope && value.floating,
    );
    if (
      entry === undefined ||
      !group?.panels.some((panel) => panel.id === id && panel.size !== undefined)
    )
      return false;
    const open = this.entries.filter((value) => value.rect !== undefined && !value.pinned);
    if (open.length >= 4 && open.every((value) => value.touched)) return false;
    entry.openedAt = Math.max(Date.now(), ...this.entries.map((value) => value.openedAt + 1));
    entry.tucked = false;
    entry.touched = false;
    entry.updated = false;
    this.rebuild();
    return true;
  }

  private rebuild(): void {
    const next: FloatingEntry[] = [];
    const available = new Map<string, { group: FloatingGroup; panel: FloatingPanel }>();
    for (const group of this.groups.values()) {
      const saved = (this.saved.get(group.scope) ?? []).filter((entry) =>
        group.liveIds.includes(entry.id),
      );
      for (const panel of group.panels) {
        let entry = saved.find((value) => value.id === panel.id);
        if (entry === undefined && group.floating && panel.size !== undefined) {
          entry = {
            id: panel.id,
            openedAt: panel.requestedAt,
            revision: panel.revision,
            touched: false,
            tucked: false,
            updated: false,
          };
          saved.push(entry);
        }
        if (entry === undefined) continue;
        entry.updated ||=
          entry.tucked && (entry.revision !== panel.revision || panel.pendingPrimary === true);
        entry.revision = panel.revision;
        if (panel.pinned) entry.tucked = false;
        const value: FloatingEntry = {
          ...SavedEntrySchema.parse(entry),
          scope: group.scope,
          title: panel.title,
          pinned: panel.pinned,
          floating: group.floating,
          geometry: undefined,
          rect: undefined,
        };
        next.push(value);
        if (group.floating && panel.size !== undefined)
          available.set(keyOf(group.scope, panel.id), { group, panel });
      }
      this.saved.set(group.scope, saved);
    }
    const candidates = next.filter((entry) => available.has(keyOf(entry.scope, entry.id)));
    tuckOldest(candidates);
    const protectedOpen = candidates.filter((entry) => !entry.pinned && !entry.tucked);
    if (protectedOpen.length > 4) {
      // An unpinned or returning window waits rather than displacing one already in use.
      protectedOpen.sort((a, b) => {
        const admitted = (entry: FloatingEntry): boolean =>
          this.entries.some(
            (old) =>
              old.scope === entry.scope &&
              old.id === entry.id &&
              old.rect !== undefined &&
              !old.pinned,
          );
        return Number(admitted(b)) - Number(admitted(a)) || byOpening(a, b);
      });
      protectedOpen.slice(4).forEach((entry) => {
        entry.tucked = true;
      });
    }

    const placed: WindowRect[] = [];
    const openings: FloatingEntry[] = [];
    for (const entry of next) {
      const input = available.get(keyOf(entry.scope, entry.id));
      if (entry.tucked || input === undefined) continue;
      const key = keyOf(entry.scope, entry.id);
      const old = this.entries.find(
        (value) => value.scope === entry.scope && value.id === entry.id,
      );
      if (old?.rect === undefined) {
        openings.push(entry);
        continue;
      }
      const saved = input.group.windows[entry.id];
      const changed = JSON.stringify(saved) !== this.appliedWindows.get(key);
      entry.geometry = (changed ? saved : undefined) ?? old.geometry ?? old.rect;
      this.appliedWindows.set(key, JSON.stringify(saved));
      entry.rect = fitRect(entry.geometry, input.group.viewport, input.panel.minWidth);
      placed.push(entry.rect);
    }
    for (const entry of openings.sort(byOpening)) {
      const input = available.get(keyOf(entry.scope, entry.id));
      if (input === undefined || input.panel.size === undefined) continue;
      entry.rect = openingRect(
        input.panel.size,
        input.group.windows[entry.id],
        placed,
        input.group.viewport,
        input.panel.minWidth,
      );
      const saved = input.group.windows[entry.id];
      entry.geometry =
        saved !== undefined &&
        JSON.stringify(entry.rect) ===
          JSON.stringify(fitRect(saved, input.group.viewport, input.panel.minWidth))
          ? saved
          : entry.rect;
      this.appliedWindows.set(keyOf(entry.scope, entry.id), JSON.stringify(saved));
      placed.push(entry.rect);
    }
    for (const [scope, saved] of this.saved) {
      const values = saved.map((entry) => {
        const value = next.find(
          (candidate) => candidate.scope === scope && candidate.id === entry.id,
        );
        return value === undefined ? entry : SavedEntrySchema.parse(value);
      });
      if (
        JSON.stringify(values) === JSON.stringify(saved) &&
        JSON.stringify(next) === JSON.stringify(this.entries)
      )
        continue;
      this.saved.set(scope, values);
      try {
        this.storage?.().setItem(`${scope}:openPanels`, JSON.stringify(values));
      } catch {
        /* Keep working for this tab when storage is unavailable. */
      }
    }
    if (JSON.stringify(next) === JSON.stringify(this.entries)) return;
    this.entries = next;
    this.listeners.forEach((listener) => listener());
  }
}

export const floatingPanels = new FloatingPanels(() => window.localStorage);
