import type { CompositionPlan, SurfacePlacementRegion } from "@noctis/contracts";
import { SurfacePlacementRegionSchema } from "@noctis/contracts";
import { LAYOUTS, attentionStateForLayout, type DisplayClass } from "@noctis/domain";
import { z } from "zod";

export function supportedRegions(
  layoutId: string,
  display: DisplayClass,
): SurfacePlacementRegion[] {
  const state = attentionStateForLayout(layoutId);
  return state === undefined
    ? []
    : SurfacePlacementRegionSchema.options.filter(
        (region) => region === "overflow" || region in LAYOUTS[state].capacity[display],
      );
}
export function dropTarget(
  region: string | undefined,
  layoutId: string,
  display: DisplayClass,
): SurfacePlacementRegion | undefined {
  return supportedRegions(layoutId, display).find((entry) => entry === region);
}

export function swapPlacements(
  plan: CompositionPlan | undefined,
  sourceId: string,
  targetId: string,
):
  | {
      surfaceId: string;
      region: SurfacePlacementRegion;
      size: CompositionPlan["slots"][number]["size"];
      order: number;
    }[]
  | undefined {
  if (sourceId === targetId) return undefined;
  const source = plan?.slots.find((slot) => slot.surfaceId === sourceId);
  const target = plan?.slots.find((slot) => slot.surfaceId === targetId);
  if (source === undefined || target === undefined) return undefined;
  return [
    { surfaceId: sourceId, region: target.region, order: target.order, size: source.size },
    { surfaceId: targetId, region: source.region, order: source.order, size: target.size },
  ];
}

const share = z.number().finite().positive().max(1);
const GeometrySchema = z
  .object({
    columns: z
      .object({ left: share.optional(), centre: share.optional(), right: share.optional() })
      .strict(),
    bottom: share,
  })
  .strict();
export type PanelGeometry = z.infer<typeof GeometrySchema>;
export function geometryKey(client: string, fingerprint: string, owner: string): string {
  return `noctis.panelGeometry:${JSON.stringify([client, fingerprint, owner])}`;
}
export function readGeometry(
  storage: Pick<Storage, "getItem">,
  key: string,
): PanelGeometry | undefined {
  try {
    const raw = storage.getItem(key);
    const parsed = GeometrySchema.safeParse(
      raw === null ? undefined : (JSON.parse(raw) as unknown),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
export function writeGeometry(
  storage: Pick<Storage, "setItem">,
  key: string,
  value: PanelGeometry,
): boolean {
  try {
    storage.setItem(key, JSON.stringify(GeometrySchema.parse(value)));
    return true;
  } catch {
    return false;
  }
}

/** Distribute one canvas, keeping every kind's minimum before handing out spare room. */
export function clampShares(
  shares: readonly number[],
  minimums: readonly number[],
  room: number,
): number[] {
  const totalMinimum = minimums.reduce((sum, value) => sum + value, 0);
  if (room <= totalMinimum) return minimums.map((value) => value / totalMinimum);
  const result = new Array<number>(shares.length).fill(0);
  let active = shares.map((_value, index) => index);
  let remaining = 1;
  while (active.length > 0) {
    const total = active.reduce((sum, index) => sum + (shares[index] ?? 0), 0);
    const blocked = active.filter(
      (index) => (remaining * (shares[index] ?? 0)) / total < (minimums[index] ?? 0) / room,
    );
    if (blocked.length === 0) {
      for (const index of active)
        result[index] =
          total > 0 ? (remaining * (shares[index] ?? 0)) / total : remaining / active.length;
      break;
    }
    for (const index of blocked) {
      result[index] = (minimums[index] ?? 0) / room;
      remaining -= result[index];
    }
    active = active.filter((index) => !blocked.includes(index));
  }
  return result;
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
