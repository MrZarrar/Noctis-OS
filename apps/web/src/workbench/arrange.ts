import type { SurfaceSize } from "@noctis/contracts";
import { z } from "zod";

/** A floating panel's place on screen, in CSS pixels from the viewport's top-left. */
const RectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite().positive(),
    h: z.number().finite().positive(),
  })
  .strict();
export type WindowRect = z.infer<typeof RectSchema>;
/** Saved windows stay with the panel the owner arranged. */
const WindowsSchema = z.record(z.string(), RectSchema);
export type PanelWindows = z.infer<typeof WindowsSchema>;
export interface Viewport {
  width: number;
  height: number;
}
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const PANEL_MIN_HEIGHT = 160;
const PRESETS: Readonly<Record<SurfaceSize, readonly [number, number]>> = {
  compact: [340, 440],
  standard: [460, 560],
  wide: [640, 640],
  stage: [820, 720],
};

/** Keeps the whole window on screen without forgetting how it was sized for a larger one. */
export function fitRect(rect: WindowRect, viewport: Viewport, minWidth: number): WindowRect {
  const w = Math.min(Math.max(rect.w, minWidth), viewport.width);
  const h = Math.min(Math.max(rect.h, PANEL_MIN_HEIGHT), viewport.height);
  return {
    x: Math.min(Math.max(rect.x, 0), viewport.width - w),
    y: Math.min(Math.max(rect.y, 0), viewport.height - h),
    w,
    h,
  };
}

function overlaps(a: WindowRect, b: WindowRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Where a panel with nothing saved opens: the first spot along the top, from
 * the right edge leftwards, that covers no open window. When the row is full
 * it cascades instead, so it still never lands exactly on another.
 */
export function defaultRect(
  size: SurfaceSize,
  placed: readonly WindowRect[],
  viewport: Viewport,
): WindowRect {
  const [w, h] = PRESETS[size];
  const top = 72;
  let right = viewport.width - 24;
  while (right - w >= 0) {
    const rect = fitRect({ x: right - w, y: top, w, h }, viewport, 0);
    const hits = placed.filter((other) => overlaps(other, rect));
    if (hits.length === 0) return rect;
    // Every hit starts left of `right`, so this always moves on.
    right = Math.min(...hits.map((other) => other.x)) - 16;
  }
  const step = placed.length * 32;
  return fitRect({ x: viewport.width - w - 24 - step, y: top + step, w, h }, viewport, 0);
}

export function openingRect(
  size: SurfaceSize,
  saved: WindowRect | undefined,
  placed: readonly WindowRect[],
  viewport: Viewport,
  minWidth: number,
): WindowRect {
  if (saved !== undefined) {
    const fitted = fitRect(saved, viewport, minWidth);
    if (!placed.some((other) => overlaps(fitted, other))) return fitted;
  }
  return fitRect(defaultRect(size, placed, viewport), viewport, minWidth);
}

export function presetRect(
  rect: WindowRect,
  size: SurfaceSize,
  viewport: Viewport,
  minWidth: number,
): WindowRect {
  const [w, h] = PRESETS[size];
  return fitRect({ ...rect, w, h }, viewport, minWidth);
}

/** Drags one edge or corner; the opposite edge stays where it is. */
export function resizeRect(
  rect: WindowRect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  minWidth: number,
): WindowRect {
  let { x, y, w, h } = rect;
  if (edge.includes("e")) w = Math.max(minWidth, w + dx);
  if (edge.includes("w")) {
    w = Math.max(minWidth, rect.w - dx);
    x = rect.x + rect.w - w;
  }
  if (edge.includes("s")) h = Math.max(PANEL_MIN_HEIGHT, h + dy);
  if (edge.includes("n")) {
    h = Math.max(PANEL_MIN_HEIGHT, rect.h - dy);
    y = rect.y + rect.h - h;
  }
  return { x, y, w, h };
}

export function geometryKey(client: string, fingerprint: string, owner: string): string {
  return `noctis.panelGeometry:${JSON.stringify([client, fingerprint, owner])}`;
}
export function readWindows(
  storage: Pick<Storage, "getItem">,
  key: string,
): PanelWindows | undefined {
  try {
    const raw = storage.getItem(key);
    const parsed = WindowsSchema.safeParse(raw === null ? undefined : (JSON.parse(raw) as unknown));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
export function writeWindows(
  storage: Pick<Storage, "setItem">,
  key: string,
  value: PanelWindows,
): boolean {
  try {
    storage.setItem(key, JSON.stringify(WindowsSchema.parse(value)));
    return true;
  } catch {
    return false;
  }
}

export const PANEL_MIN_WIDTH: Readonly<Record<string, number>> = {
  page: 320,
  document: 300,
  conversation: 320,
  approval: 320,
  evidence: 300,
  verification: 280,
  timeline: 280,
  list: 240,
  detail: 240,
  media: 240,
  live_brief: 280,
  vault_recall: 280,
  artifact: 280,
  attention: 240,
  native_application: 320,
  external_tool: 320,
  source_state: 240,
};

/**
 * The stacking order after some windows have just opened. Each goes on top, as
 * a new window would, except under a window that opened after it and has not
 * been touched since. Two owners announce their new windows in whichever order
 * their renders land, and the newest must still end up highest.
 */
export function stackOpened(
  order: readonly string[],
  openedAt: ReadonlyMap<string, string>,
  opened: readonly { id: string; at: string }[],
): string[] {
  const next = order.filter((id) => !opened.some((entry) => entry.id === id));
  for (const { id, at } of opened) {
    let index = next.length;
    while (index > 0 && (openedAt.get(next[index - 1] ?? "") ?? "") > at) index -= 1;
    next.splice(index, 0, id);
  }
  return next;
}
