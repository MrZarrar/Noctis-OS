import type { VaultEntityType } from "@noctis/contracts";

/**
 * Deterministic Vault sphere placement.
 *
 * The Fibonacci-sphere type anchor is ported from `Jarvis-Sub-Agent-Dashboard`
 * at commit `ee7b4527`, `client/src/components/VaultSphere.tsx` (`anchorFor`),
 * including its `2.399963` golden-angle increment. MIT licence, Copyright (c)
 * 2026 - Now, Son Nguyen. See `docs/architecture/DONOR-PORT-LEDGER.md`.
 *
 * What changed, and why it is the point of this module: the donor derived a
 * node's position from its index in a list and its degree, so every note moved
 * whenever any other note was added, removed, or linked. Here a node's seed
 * comes from a hash of its own key, and settlement only ever moves nodes that
 * have never been placed. Section 7's "node coordinates are stable and
 * persisted" is therefore a property of the algorithm rather than a promise
 * about how it is called.
 */

export interface Coordinate {
  x: number;
  y: number;
  z: number;
}

/**
 * Bumped when placement changes, so persisted coordinates can be recognised as old.
 *
 * 2: version 1 pulled each note onto the average of its neighbours, which in a
 * Vault averaging a dozen links per note collapsed everything into one blob.
 */
export const LAYOUT_VERSION = 2;

export const SHELL_RADIUS = 10;

/** Half-angle of a type's cluster cap. Wide enough to spread, tight enough to read as a cluster. */
const CLUSTER_SPREAD = Math.PI / 5;

// ponytail: every pass is all-pairs, so a few thousand notes take seconds to
// place. A spatial grid for the repulsion is the upgrade if the Vault gets there.
const DEFAULT_ITERATIONS = 200;
/** Below this much total movement the graph is at rest and settlement stops. */
const REST_EPSILON = 1e-4;
/**
 * Upper bound on the natural spacing. A Vault of two notes would otherwise
 * want them a sphere apart, and repulsion would beat the link between them.
 */
const MAX_SPACING = 3;
/** The furthest a note may move in the first pass; it cools to nothing by the last. */
const START_TEMPERATURE = SHELL_RADIUS * 0.3;

/** The donor's eight fixed cluster directions, one slot per note type. */
const TYPE_SLOT: Readonly<Record<VaultEntityType, number>> = {
  capture: 1,
  project: 2,
  person: 3,
  reference: 4,
  daily: 5,
  agent: 6,
  note: 7,
};

/** FNV-1a. A spreading function, not a security primitive. */
function hash(value: string, salt: number): number {
  let result = 0x811c9dc5 ^ salt;

  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }

  return (result >>> 0) / 0x100000000;
}

function normalize(point: Coordinate): Coordinate {
  const length = Math.hypot(point.x, point.y, point.z);

  if (length === 0) {
    return { x: 0, y: 1, z: 0 };
  }

  return { x: point.x / length, y: point.y / length, z: point.z / length };
}

export function distance(a: Coordinate, b: Coordinate): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Donor `anchorFor`: the Fibonacci direction for a type's slot. */
export function anchorFor(type: VaultEntityType): Coordinate {
  const index = TYPE_SLOT[type] - 1;
  const y = 1 - (2 * (index + 0.5)) / 8;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = index * 2.399963;

  return { x: radius * Math.cos(theta), y, z: radius * Math.sin(theta) };
}

/** Any unit vector perpendicular to `axis`, chosen without a branch on magnitude alone. */
function perpendicular(axis: Coordinate): Coordinate {
  const reference = Math.abs(axis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };

  return normalize({
    x: axis.y * reference.z - axis.z * reference.y,
    y: axis.z * reference.x - axis.x * reference.z,
    z: axis.x * reference.y - axis.y * reference.x,
  });
}

/**
 * A node's position before anything is known about its links.
 *
 * A point inside the type's cluster cap, chosen by hashing the key. Two hashes
 * give the two angles a cap needs, so the same note lands in the same place in
 * an empty Vault and in a Vault of ten thousand notes.
 */
export function seedCoordinate(key: string, type: VaultEntityType): Coordinate {
  const axis = anchorFor(type);
  const u = hash(key, 0x9e3779b9);
  const v = hash(key, 0x85ebca6b);

  const cosTheta = 1 - u * (1 - Math.cos(CLUSTER_SPREAD));
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = 2 * Math.PI * v;

  const right = perpendicular(axis);
  const up = normalize({
    x: axis.y * right.z - axis.z * right.y,
    y: axis.z * right.x - axis.x * right.z,
    z: axis.x * right.y - axis.y * right.x,
  });

  const direction = normalize({
    x: axis.x * cosTheta + (right.x * Math.cos(phi) + up.x * Math.sin(phi)) * sinTheta,
    y: axis.y * cosTheta + (right.y * Math.cos(phi) + up.y * Math.sin(phi)) * sinTheta,
    z: axis.z * cosTheta + (right.z * Math.cos(phi) + up.z * Math.sin(phi)) * sinTheta,
  });

  return {
    x: direction.x * SHELL_RADIUS,
    y: direction.y * SHELL_RADIUS,
    z: direction.z * SHELL_RADIUS,
  };
}

export interface SettleNode {
  entityId: string;
  key: string;
  type: VaultEntityType;
  neighbourIds: readonly string[];
}

export interface SettleInput {
  /** Already-placed nodes. Pinned: settlement reads them and never writes them. */
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
 * Places new nodes, and only new nodes.
 *
 * A force layout confined to the shell: every note pushes every other away, and
 * each link pulls its two ends together. A link's pull is divided by the root
 * of both ends' link counts, because a hub linked to everything says nothing
 * about where any one note belongs, and at full strength it drags the whole
 * Vault onto itself.
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
  const pending = [...input.incoming]
    .filter((candidate) => !placed.has(candidate.entityId))
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));

  for (const candidate of pending) {
    placed.set(candidate.entityId, seedCoordinate(candidate.key, candidate.type));
  }

  if (pending.length === 0) {
    return { placed, iterations: 0 };
  }

  const linkCount = new Map<string, number>();

  for (const candidate of pending) {
    for (const id of candidate.neighbourIds) {
      linkCount.set(id, (linkCount.get(id) ?? 0) + 1);
    }
  }

  const spacing = Math.min(
    MAX_SPACING,
    Math.sqrt((4 * Math.PI * SHELL_RADIUS * SHELL_RADIUS) / placed.size),
  );
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

      const force = { x: 0, y: 0, z: 0 };

      for (const [otherId, other] of placed) {
        if (otherId === candidate.entityId) {
          continue;
        }

        // Floored so two notes seeded on one point still push apart.
        const gap = Math.max(distance(current, other), 1e-3);
        const push = (spacing * spacing) / (gap * gap);

        force.x += (current.x - other.x) * push;
        force.y += (current.y - other.y) * push;
        force.z += (current.z - other.z) * push;
      }

      const ownLinks = Math.max(1, linkCount.get(candidate.entityId) ?? 0);

      for (const id of candidate.neighbourIds) {
        const other = placed.get(id);

        if (other === undefined || id === candidate.entityId) {
          continue;
        }

        const pull =
          distance(current, other) /
          spacing /
          Math.sqrt(ownLinks * Math.max(1, linkCount.get(id) ?? 0));

        force.x += (other.x - current.x) * pull;
        force.y += (other.y - current.y) * pull;
        force.z += (other.z - current.z) * pull;
      }

      // Only the part of the force along the shell can move a note on it.
      const radial = normalize(current);
      const outward = force.x * radial.x + force.y * radial.y + force.z * radial.z;
      const along = {
        x: force.x - radial.x * outward,
        y: force.y - radial.y * outward,
        z: force.z - radial.z * outward,
      };
      const strength = Math.hypot(along.x, along.y, along.z);
      const step = strength > temperature ? temperature / strength : 1;

      const direction = normalize({
        x: current.x + along.x * step,
        y: current.y + along.y * step,
        z: current.z + along.z * step,
      });
      const shell = {
        x: direction.x * SHELL_RADIUS,
        y: direction.y * SHELL_RADIUS,
        z: direction.z * SHELL_RADIUS,
      };

      movement += distance(current, shell);
      placed.set(candidate.entityId, shell);
    }

    if (movement < REST_EPSILON) {
      break;
    }
  }

  return { placed, iterations };
}
