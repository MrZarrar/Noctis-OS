import type { VaultEntityType } from "@noctis/contracts";

/**
 * Deterministic Vault sphere placement.
 *
 * Types divide the occupied volume, and topics divide each type's region.
 * Reindexing can rebalance those regions; rendering never moves the notes.
 * Golden-angle placement retains MIT-licensed work by Son Nguyen,
 * Copyright (c) 2026 - Now.
 */

export interface Coordinate {
  x: number;
  y: number;
  z: number;
}

/**
 * Bumped when placement changes, so persisted coordinates can be recognised as old.
 *
 * Version 4 shares the whole volume among populated types and grows with content.
 */
export const LAYOUT_VERSION = 4;

/** Reference radius for conversion to renderer units. */
export const SHELL_RADIUS = 10;
/** Nothing is placed nearer the centre than this; the renderer draws its core there. */
export const CORE_RADIUS = 3.6;

const SPACING = 0.85;
const REPULSION_REACH = SPACING * 4;
const SLOT_PULL = 0.8;
const LINK_PULL = 0.06;

// shortcut: repulsion checks every pair, use a spatial grid if large Vaults reindex too slowly.
const DEFAULT_ITERATIONS = 80;
/** Below this much total movement the graph is at rest and settlement stops. */
const REST_EPSILON = 1e-4;
/** The furthest a note may move in the first pass; it cools to nothing by the last. */
const START_TEMPERATURE = 1.5;
const COMMUNITY_PASSES = 30;

export function shellRadiusFor(count: number): number {
  return Math.max(CORE_RADIUS * 1.6, Math.cbrt(CORE_RADIUS ** 3 + Math.max(0, count) * 4.5));
}

function normalize(point: Coordinate): Coordinate {
  const length = Math.hypot(point.x, point.y, point.z);

  if (length === 0) {
    return { x: 0, y: 1, z: 0 };
  }

  return { x: point.x / length, y: point.y / length, z: point.z / length };
}

function add(a: Coordinate, b: Coordinate, scale = 1): Coordinate {
  return { x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale };
}

function scaled(point: Coordinate, scale: number): Coordinate {
  return { x: point.x * scale, y: point.y * scale, z: point.z * scale };
}

export function distance(a: Coordinate, b: Coordinate): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Keeps a point between the core and the shell, along its own direction. */
function contain(point: Coordinate, inner = CORE_RADIUS, outer = SHELL_RADIUS): Coordinate {
  const length = Math.hypot(point.x, point.y, point.z);

  if (length >= inner && length <= outer) {
    return point;
  }

  return scaled(normalize(point), Math.min(outer, Math.max(inner, length)));
}

function volumePoints(count: number, radius: number): Coordinate[] {
  return Array.from({ length: count }, (_, index) => {
    const y = 1 - (2 * (index + 0.5)) / count;
    const ring = Math.sqrt(1 - y * y);
    const angle = index * 2.399963;
    const depth = (0.5 + index * 0.754877666) % 1;
    const reach = Math.cbrt(CORE_RADIUS ** 3 + depth * (radius ** 3 - CORE_RADIUS ** 3));

    return { x: reach * ring * Math.cos(angle), y: reach * y, z: reach * ring * Math.sin(angle) };
  });
}

function partition(
  points: Coordinate[],
  groups: Array<readonly [string, number]>,
): Map<string, Coordinate[]> {
  const regions = new Map<string, Coordinate[]>();
  const divide = (space: Coordinate[], entries: Array<readonly [string, number]>): void => {
    if (entries.length === 1) {
      regions.set(entries[0]![0], space);
      return;
    }
    if (entries.length === 0) {
      return;
    }

    // Split the longest dimension so a large group gets a broad region, not a thin strip.
    const axes = ["x", "y", "z"] as const;
    const spread = (axis: (typeof axes)[number]): number =>
      Math.max(...space.map((point) => point[axis])) -
      Math.min(...space.map((point) => point[axis]));
    const axis = [...axes].sort((a, b) => spread(b) - spread(a))[0]!;
    space.sort((a, b) => a[axis] - b[axis] || a.x - b.x || a.y - b.y || a.z - b.z);
    let cut = 1;
    let size = entries[0]![1];
    let total = size;
    for (let index = 1; index < entries.length - 1; index += 1) {
      total += entries[index]![1];
      if (Math.abs(total - space.length / 2) < Math.abs(size - space.length / 2)) {
        cut = index + 1;
        size = total;
      }
    }
    divide(space.slice(0, size), entries.slice(0, cut));
    divide(space.slice(size), entries.slice(cut));
  };
  divide(points, groups);
  return regions;
}

export interface SettleNode {
  entityId: string;
  key: string;
  type: VaultEntityType;
  neighbourIds: readonly string[];
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Topic groups, by label propagation: each note repeatedly takes the group
 * most of its links point into.
 *
 * A link counts for less the more links its two ends have, because a hub
 * linked to everything says nothing about which topic any one note is in, and
 * at full weight it pulls the whole Vault into its own group. Notes are
 * visited in id order and ties go to the smaller label, so the result cannot
 * depend on the order the notes arrived in.
 */
export function communities(nodes: readonly SettleNode[]): Map<string, string> {
  const ids = nodes.map((entry) => entry.entityId).sort(byId);
  const known = new Set(ids);
  const links = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));

  for (const entry of nodes) {
    for (const other of entry.neighbourIds) {
      if (other !== entry.entityId && known.has(other)) {
        links.get(entry.entityId)?.add(other);
        links.get(other)?.add(entry.entityId);
      }
    }
  }

  const label = new Map(ids.map((id) => [id, id]));

  for (let pass = 0; pass < COMMUNITY_PASSES; pass += 1) {
    let changed = false;

    for (const id of ids) {
      const own = links.get(id) ?? new Set<string>();
      const score = new Map<string, number>();

      for (const other of own) {
        const weight = 1 / Math.sqrt(own.size * (links.get(other)?.size ?? 1));
        const theirs = label.get(other) ?? other;
        score.set(theirs, (score.get(theirs) ?? 0) + weight);
      }

      const current = label.get(id) ?? id;
      let best = current;
      let bestScore = score.get(current) ?? 0;

      for (const [candidate, value] of score) {
        // A small margin before switching keeps two equal groups from trading
        // members forever.
        if (
          value > bestScore + 1e-9 ||
          (Math.abs(value - bestScore) <= 1e-9 && byId(candidate, best) < 0 && best !== current)
        ) {
          best = candidate;
          bestScore = value;
        }
      }

      if (best !== current) {
        label.set(id, best);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  return label;
}

export interface SettleInput {
  /** Coordinates outside the supplied graph are left alone. */
  placed: ReadonlyMap<string, Coordinate>;
  incoming: readonly SettleNode[];
  iterations?: number;
}

export interface SettleResult {
  placed: Map<string, Coordinate>;
  /** How many passes ran before the graph came to rest. Never exceeds the bound. */
  iterations: number;
}

/**
 * Rebalances the supplied graph into type regions and smaller topic regions.
 * Each region receives one volume slot per note, so its size follows its content.
 * Repulsion gives neighbouring notes breathing room without collapsing the volume.
 *
 * Bounded by construction: a fixed iteration ceiling, a step limit that cools
 * linearly to zero over it, an early stop once total movement falls under
 * `REST_EPSILON`, and no velocity carried between passes. There is nothing here
 * that can keep running — settlement is a pure function that returns final
 * coordinates, so "at rest" is the absence of further calls rather than a
 * damping constant that never quite reaches zero.
 */
export function settle(input: SettleInput): SettleResult {
  const placed = new Map(input.placed);
  // Sorted so the result cannot depend on the order the caller happened to
  // read rows in.
  const pending = [...input.incoming].sort(
    (a, b) => byId(a.key, b.key) || byId(a.entityId, b.entityId),
  );

  if (pending.length === 0) {
    return { placed, iterations: 0 };
  }

  const topic = communities(pending);
  const radius = shellRadiusFor(pending.length);
  const byType = new Map<VaultEntityType, SettleNode[]>();
  for (const entry of pending) {
    byType.set(entry.type, [...(byType.get(entry.type) ?? []), entry]);
  }
  const types = [...byType].sort(([a], [b]) => byId(a, b));
  const regions = partition(
    volumePoints(pending.length, radius),
    types.map(([type, entries]) => [type, entries.length]),
  );
  const anchors = new Map<string, Coordinate>();
  for (const [type, entries] of types) {
    const groups = new Map<string, SettleNode[]>();
    for (const entry of entries) {
      const group = topic.get(entry.entityId) ?? entry.entityId;
      groups.set(group, [...(groups.get(group) ?? []), entry]);
    }
    const ordered = [...groups].sort(([a], [b]) => byId(a, b));
    const topics = partition(
      regions.get(type) ?? [],
      ordered.map(([group, members]) => [group, members.length]),
    );
    for (const [group, members] of ordered) {
      const slots = topics.get(group) ?? [];
      const centre = slots.reduce((sum, point) => add(sum, point, 1 / slots.length), {
        x: 0,
        y: 0,
        z: 0,
      });
      members.forEach((entry, index) => {
        // Leave small gaps between topics without shrinking a type that has just one topic.
        const anchor = contain(
          add(centre, add(slots[index]!, centre, -1), ordered.length > 1 ? 0.7 : 1),
          CORE_RADIUS,
          radius,
        );
        anchors.set(entry.entityId, anchor);
        placed.set(entry.entityId, anchor);
      });
    }
  }

  const linkCount = new Map<string, number>();

  for (const candidate of pending) {
    for (const id of candidate.neighbourIds) {
      linkCount.set(id, (linkCount.get(id) ?? 0) + 1);
    }
  }

  const ceiling = input.iterations ?? DEFAULT_ITERATIONS;
  let iterations = 0;

  for (let pass = 0; pass < ceiling; pass += 1) {
    const temperature = START_TEMPERATURE * (1 - pass / ceiling);
    let movement = 0;
    iterations = pass + 1;

    for (const candidate of pending) {
      const current = placed.get(candidate.entityId);

      if (current === undefined) {
        continue;
      }

      const anchor = anchors.get(candidate.entityId)!;
      let force = scaled(add(anchor, current, -1), SLOT_PULL);

      for (const [otherId, other] of placed) {
        if (otherId === candidate.entityId) {
          continue;
        }

        const gap = distance(current, other);

        if (gap > REPULSION_REACH) {
          continue;
        }

        // Floored so two notes seeded on one point still push apart.
        const floored = Math.max(gap, 1e-3);
        force = add(force, add(current, other, -1), (SPACING * SPACING) / (floored * floored));
      }

      const ownLinks = Math.max(1, linkCount.get(candidate.entityId) ?? 0);

      for (const id of candidate.neighbourIds) {
        const other = placed.get(id);

        if (other === undefined || id === candidate.entityId) {
          continue;
        }

        const weight = LINK_PULL / Math.sqrt(ownLinks * Math.max(1, linkCount.get(id) ?? 0));
        force = add(force, add(other, current, -1), weight);
      }

      const strength = Math.hypot(force.x, force.y, force.z);
      const step = strength > temperature ? temperature / strength : 1;
      const next = contain(add(current, force, step), CORE_RADIUS, radius);

      movement += distance(current, next);
      placed.set(candidate.entityId, next);
    }

    if (movement < REST_EPSILON) {
      break;
    }
  }

  return { placed, iterations };
}
