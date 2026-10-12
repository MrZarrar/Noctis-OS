import type { VaultEntityType } from "@noctis/contracts";
import { SHELL_RADIUS } from "@noctis/domain";

/**
 * The arithmetic behind the Vault sphere, with no renderer and no `three`
 * import, so every rule below is testable without a WebGL context.
 *
 * Ported from `Jarvis-Sub-Agent-Dashboard` at commit `ee7b4527`,
 * `client/src/components/VaultSphere.tsx`. MIT licence, Copyright (c) 2026 -
 * Now, Son Nguyen. See `docs/architecture/DONOR-PORT-LEDGER.md`.
 *
 * What is deliberately absent is the donor's `tickSim`. Its repulsion, springs,
 * and containment move a node every frame, and Noctis's coordinates are already
 * settled by `@noctis/domain`'s `settle` and persisted in `vault_layout`. A
 * second solver in the renderer would walk nodes off the coordinates every
 * client is supposed to agree on, which is exactly the wandering Section 7 asks
 * to remove. Positions here are read, scaled, and drawn.
 */

/** Donor world units: the wireframe shell's radius. */
export const R = 100;
/** Donor `CONTENT_R`: nodes sit inside the shell, leaving room for their glow. */
export const CONTENT_R = R * 0.88;

/** Donor constants, unchanged. */
export const MAX_EDGES_PER_NODE = 4;
export const EDGE_SEGS = 10;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Keep a fixed world scale so growing the layout gives notes more room.
 */
export function toWorld(point: Point3): Point3 {
  const scale = CONTENT_R / SHELL_RADIUS;

  return { x: point.x * scale, y: point.y * scale, z: point.z * scale };
}

export function viewDistanceFor(radius: number, aspect: number): number {
  const halfFov = Math.atan(Math.tan((25 * Math.PI) / 180) * Math.min(1, aspect));
  return (radius / Math.sin(halfFov)) * 1.12;
}

/**
 * The donor's eight cluster slots, keyed by Noctis's seven entity types. The
 * slot decides the node's colour, independently of its position.
 */
const TYPE_SLOT: Readonly<Record<VaultEntityType, number>> = {
  capture: 1,
  project: 2,
  person: 3,
  reference: 4,
  daily: 5,
  agent: 6,
  note: 7,
};

export function slotFor(type: VaultEntityType): number {
  return TYPE_SLOT[type];
}

/** Donor `radiusFor`: a node's drawn size grows with its degree, and stops. */
export function radiusFor(degree: number): number {
  return Math.min(1.1 + Math.sqrt(degree) * 0.4, 4.5);
}

export interface SphereEdge {
  id: string;
  source: string;
  target: string;
  lifecycle: "resolved" | "unresolved";
}

/**
 * One edge per linked pair. Two notes that link each other arrive as two
 * edges, and drawn twice an additive line is twice as bright as a one-way link.
 */
export function uniqueLinks(edges: readonly SphereEdge[]): SphereEdge[] {
  const seen = new Set<string>();

  return edges.filter((edge) => {
    const pair =
      edge.source < edge.target
        ? `${edge.source}\u0000${edge.target}`
        : `${edge.target}\u0000${edge.source}`;

    if (edge.source === edge.target || seen.has(pair)) {
      return false;
    }

    seen.add(pair);

    return true;
  });
}

/**
 * Donor edge thinning, kept because a personal Vault is densely cross-linked
 * and drawing every link is a hairball.
 *
 * Sparsest-first: rarely-connected nodes keep all their edges, because those
 * few links are what give them a place to be, while hubs shed the hub-to-hub
 * crossings that make the noise. Sorting by summed degree makes the choice
 * deterministic rather than a consequence of the order rows arrived in.
 */
export function thinEdges(
  edges: readonly SphereEdge[],
  maxPerNode = MAX_EDGES_PER_NODE,
): SphereEdge[] {
  const linkCount = new Map<string, number>();

  for (const edge of edges) {
    linkCount.set(edge.source, (linkCount.get(edge.source) ?? 0) + 1);
    linkCount.set(edge.target, (linkCount.get(edge.target) ?? 0) + 1);
  }

  const weight = (edge: SphereEdge): number =>
    (linkCount.get(edge.source) ?? 0) + (linkCount.get(edge.target) ?? 0);

  const kept = new Map<string, number>();

  return [...edges]
    .sort((a, b) => weight(a) - weight(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter((edge) => {
      const source = kept.get(edge.source) ?? 0;
      const target = kept.get(edge.target) ?? 0;

      if (source >= maxPerNode && target >= maxPerNode) {
        return false;
      }

      kept.set(edge.source, source + 1);
      kept.set(edge.target, target + 1);

      return true;
    });
}

function length(point: Point3): number {
  return Math.hypot(point.x, point.y, point.z);
}

function clampLength(point: Point3, max: number): Point3 {
  const current = length(point);

  if (current <= max || current === 0) {
    return point;
  }

  const scale = max / current;

  return { x: point.x * scale, y: point.y * scale, z: point.z * scale };
}

/**
 * Donor `setEdgeControl`: the quadratic-bezier control point that bows an edge
 * outward without letting the curve break the globe's silhouette.
 */
export function edgeControl(a: Point3, b: Point3, contentRadius = CONTENT_R): Point3 {
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  const separation = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  // The bow grows with the link's length: a long link arcs round the core,
  // a short one inside a topic stays nearly straight instead of looping.
  const bow = (separation * 0.2) / Math.max(1, length(midpoint));

  const bowed = clampLength(
    { x: midpoint.x * (1 + bow), y: midpoint.y * (1 + bow), z: midpoint.z * (1 + bow) },
    contentRadius,
  );

  // Two antipodal nodes have a midpoint at the origin, which the bow cannot
  // push anywhere. Nudging it off-centre is what keeps that edge from being
  // drawn straight through the crystal core.
  return length(bowed) < 5 ? { ...bowed, y: bowed.y + 10 } : bowed;
}

export function bezier(a: Point3, control: Point3, b: Point3, t: number): Point3 {
  const u = 1 - t;

  return {
    x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
    z: u * u * a.z + 2 * u * t * control.z + t * t * b.z,
  };
}

/**
 * Donor label level-of-detail: a label appears once its node is big enough on
 * screen to hang one off, or when the node is the one being talked about.
 *
 * Returned as an opacity rather than a boolean so labels fade in instead of
 * popping, and so `0` means "do not draw" without a second rule.
 */
export function labelOpacity(onScreenRadiusPx: number, isKey: boolean): number {
  if (isKey) {
    return 0.95;
  }

  if (onScreenRadiusPx < 12) {
    return 0;
  }

  const opacity = Math.min(0.85, (onScreenRadiusPx - 12) / 5);

  return opacity <= 0.02 ? 0 : opacity;
}

/** A label's screen rectangle, top-left anchored, in CSS pixels. */
export interface LabelBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Which labels to draw, given them most-important first.
 *
 * Greedy: each label is kept unless it collides with one already kept. A
 * crowded patch of the sphere then shows its most important name rather than
 * a smear of all of them.
 */
export function placeLabels(boxes: readonly LabelBox[], gap = 2): Set<string> {
  const kept: LabelBox[] = [];

  for (const box of boxes) {
    const collides = kept.some(
      (other) =>
        box.x < other.x + other.width + gap &&
        other.x < box.x + box.width + gap &&
        box.y < other.y + other.height + gap &&
        other.y < box.y + box.height + gap,
    );

    if (!collides) {
      kept.push(box);
    }
  }

  return new Set(kept.map((box) => box.id));
}

export function degreeOf(edges: readonly SphereEdge[]): Map<string, number> {
  const degree = new Map<string, number>();

  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  return degree;
}
