import type { AttentionState, SurfaceRegion, SurfaceRole, SurfaceSize } from "@noctis/contracts";

/**
 * How wide the display is, in the only granularity composition is allowed to
 * see. The compositor never receives a pixel rectangle it could place a
 * Surface into — it receives a class, and the class picks region capacities.
 * That is the mechanical reason a plan can carry no geometry: there is no
 * geometry in scope to carry.
 */
export type DisplayClass = "compact" | "standard" | "wide";

export function displayClass(widthPx: number): DisplayClass {
  if (widthPx < 1200) {
    return "compact";
  }

  return widthPx < 1800 ? "standard" : "wide";
}

export interface LayoutTemplate {
  id: string;
  /** The size a slot in this region gets, before a user override is applied. */
  regionSize: Partial<Record<SurfaceRegion, SurfaceSize>>;
  /** How many Surfaces each region holds. A region absent here does not exist. */
  capacity: Record<DisplayClass, Partial<Record<SurfaceRegion, number>>>;
}

/** Where a role goes when the intent expresses no preference. */
export const ROLE_REGION: Readonly<Record<SurfaceRole, SurfaceRegion>> = {
  primary: "centre",
  supporting: "right",
  context: "left",
  control: "bottom",
  attention: "overlay",
};

/**
 * One named template per attention state (Section 5.5). The mapping is total
 * and one-to-one, which is what lets restore read the attention state back out
 * of a persisted `layoutId` instead of needing a column to store it in.
 */
export const LAYOUTS: Readonly<Record<AttentionState, LayoutTemplate>> = {
  // "identity is spatially present, prompt is primary, no active workspace":
  // nothing is composed, so every intent lands in the accessible overflow
  // stack rather than being silently discarded.
  presence: {
    id: "presence.only",
    regionSize: {},
    capacity: { compact: {}, standard: {}, wide: {} },
  },
  active_canvas: {
    id: "canvas.split",
    regionSize: { centre: "wide", right: "standard", left: "standard", bottom: "compact" },
    capacity: {
      compact: { centre: 1, bottom: 1 },
      standard: { centre: 1, right: 1, bottom: 1 },
      wide: { centre: 1, right: 2, left: 1, bottom: 1 },
    },
  },
  // "native or Noctis-owned work dominates; identity reduces to a restrained
  // companion/control": one stage Surface and the control strip, nothing else.
  focus: {
    id: "focus.stage",
    regionSize: { centre: "stage", bottom: "compact" },
    capacity: {
      compact: { centre: 1 },
      standard: { centre: 1, bottom: 1 },
      wide: { centre: 1, bottom: 1 },
    },
  },
  // "elevated without hiding current work": the canvas capacities are
  // unchanged and the overlay is added on top of them.
  attention_required: {
    id: "attention.elevated",
    regionSize: {
      centre: "wide",
      right: "standard",
      left: "standard",
      bottom: "compact",
      overlay: "standard",
    },
    capacity: {
      compact: { overlay: 1, centre: 1, bottom: 1 },
      standard: { overlay: 1, centre: 1, right: 1, bottom: 1 },
      wide: { overlay: 1, centre: 1, right: 2, left: 1, bottom: 1 },
    },
  },
};

const LAYOUT_ATTENTION = new Map<string, AttentionState>(
  (Object.keys(LAYOUTS) as AttentionState[]).map((state) => [LAYOUTS[state].id, state]),
);

/** Reads a restored snapshot's attention state back out of its layout id. */
export function attentionStateForLayout(layoutId: string): AttentionState | undefined {
  return LAYOUT_ATTENTION.get(layoutId);
}
