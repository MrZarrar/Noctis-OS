import type { VaultEntityType } from "@noctis/contracts";

/**
 * Deterministic Vault sphere placement.
 *
 * The Fibonacci-sphere type anchor is ported from `Jarvis-Sub-Agent-Dashboard`
 * at commit `ee7b4527`, `client/src/components/VaultSphere.tsx` (`anchorFor`),
 * including its `2.399963` golden-angle increment, and so is the shape: a lobe
 * per note type, filling the sphere's depth, with the core kept clear. MIT
 * licence, Copyright (c) 2026 - Now, Son Nguyen. See
 * `docs/architecture/DONOR-PORT-LEDGER.md`.
 *
 * What changed, and why it is the point of this module: the donor derived a
 * node's position from its index in a list and its degree, so every note moved
 * whenever any other note was added, removed, or linked. Here a node's seed
 * comes from a hash of its own key, and settlement only ever moves nodes that
 * have never been placed. Section 7's "node coordinates are stable and
 * persisted" is therefore a property of the algorithm rather than a promise
 * about how it is called.
 *
 * Inside each lobe, notes gather by topic: groups found from who links to whom,
 * each sitting on the side of its lobe that faces the other lobes it links to.
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
 * 3: version 2 spread notes evenly over the shell, which read as a web with
 * nothing inside it. Notes now fill lobes by type, grouped by topic within.
 */
export const LAYOUT_VERSION = 3;

/** The outer bound of every coordinate. */
export const SHELL_RADIUS = 10;
/** Nothing is placed nearer the centre than this; the renderer draws its core there. */
export const CORE_RADIUS = 3.6;

/** How far a type's lobe sits from the centre. */
const LOBE_DISTANCE = 6.6;
/** How far a topic's clump sits from its lobe's centre. */
const TOPIC_OFFSET = 2.4;
/** Scatter of a seed around its topic, before settlement spreads it. */
const SEED_JITTER = 0.9;

// The three forces, tuned as a set: repulsion gives every note room, the
// topic pull holds a clump together, and links lean notes toward each other
// without dragging them out of their lobe.
const SPACING = 0.85;
const REPULSION_REACH = SPACING * 4;
const TOPIC_PULL = 0.8;
const LINK_PULL = 0.12;

// ponytail: every pass is all-pairs, so a few thousand notes take seconds to
// place. A spatial grid for the repulsion is the upgrade if the Vault gets there.
const DEFAULT_ITERATIONS = 300;
/** Below this much total movement the graph is at rest and settlement stops. */
const REST_EPSILON = 1e-4;
/** The furthest a note may move in the first pass; it cools to nothing by the last. */
const START_TEMPERATURE = 1.5;
const COMMUNITY_PASSES = 30;

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

/** Donor `anchorFor`: the Fibonacci direction for a type's slot, as a unit vector. */
export function anchorFor(type: VaultEntityType): Coordinate {
  const index = TYPE_SLOT[type] - 1;
  const y = 1 - (2 * (index + 0.5)) / 8;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = index * 2.399963;

  return { x: radius * Math.cos(theta), y, z: radius * Math.sin(theta) };
}

/** A unit direction chosen by hashing, uniform over the sphere. */
function hashedDirection(key: string, salt: number): Coordinate {
  const y = 1 - 2 * hash(key, salt);
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = 2 * Math.PI * hash(key, salt ^ 0x5bd1e995);

  return { x: ring * Math.cos(phi), y, z: ring * Math.sin(phi) };
}

function cross(a: Coordinate, b: Coordinate): Coordinate {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Two unit vectors at right angles to each other and to `axis`. */
function tangentBasis(axis: Coordinate): [Coordinate, Coordinate] {
  const reference = Math.abs(axis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const right = normalize(cross(axis, reference));

  return [right, normalize(cross(axis, right))];
}

/**
 * The i-th of n spots on a sunflower disc across a type's lobe, as an offset
 * of up to one unit. Evenly spaced however many there are, largest first at
 * the middle.
 */
function discSpot(type: VaultEntityType, index: number, count: number): Coordinate {
  const [right, up] = tangentBasis(anchorFor(type));
  const reach = Math.sqrt((index + 1) / count);
  const angle = index * 2.399963;

  return add(scaled(right, Math.cos(angle) * reach), up, Math.sin(angle) * reach);
}

function lobeCentre(type: VaultEntityType): Coordinate {
  return scaled(anchorFor(type), LOBE_DISTANCE);
}

/**
 * A topic's clump: across its lobe, never deeper or shallower, so that topics
 * spread sideways where they can be seen from outside the globe, and keeping
 * them off the core or the shell cannot squeeze two of them together.
 */
function topicAnchor(type: VaultEntityType, offset: Coordinate): Coordinate {
  const axis = anchorFor(type);
  const along = offset.x * axis.x + offset.y * axis.y + offset.z * axis.z;

  return add(lobeCentre(type), add(offset, axis, -along), TOPIC_OFFSET);
}

function jittered(anchor: Coordinate, key: string): Coordinate {
  const reach = SEED_JITTER * Math.cbrt(hash(key, 0x27d4eb2d));

  return contain(add(anchor, hashedDirection(key, 0x9e3779b9), reach));
}

/**
 * A node's position before anything is known about its links: a point in its
 * type's lobe, chosen by hashing the key, so the same note lands in the same
 * place in an empty Vault and in a Vault of ten thousand notes.
 */
export function seedCoordinate(key: string, type: VaultEntityType): Coordinate {
  return jittered(topicAnchor(type, hashedDirection(key, 0x85ebca6b)), key);
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
 * Each new note is held near its topic's clump in its type's lobe, pushed off
 * every note near it, and leaned toward the notes it links to. A link's pull
 * is divided by the root of both ends' link counts, for the same reason as in
 * `communities`. Every position is kept between the core and the shell.
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
    .sort((a, b) => byId(a.entityId, b.entityId));

  if (pending.length === 0) {
    return { placed, iterations: 0 };
  }

  const topic = communities(pending);

  // A topic's clump sits on the side of its lobe facing the other lobes the
  // topic reaches into, which keeps the links between lobes short. A topic
  // that stays inside one type has nowhere to face; see below.
  const facing = new Map<string, Coordinate>();
  const sameType = new Map<string, number>();
  const groupKey = (type: VaultEntityType, group: string): string => `${type}|${group}`;

  for (const entry of pending) {
    const group = topic.get(entry.entityId) ?? entry.entityId;
    facing.set(group, add(facing.get(group) ?? { x: 0, y: 0, z: 0 }, anchorFor(entry.type)));
    sameType.set(groupKey(entry.type, group), (sameType.get(groupKey(entry.type, group)) ?? 0) + 1);
  }

  // Topics that stay inside one type have no other lobe to face, so they are
  // spread evenly around their own, largest first. Hashed sides could land two
  // of them on the same spot.
  const inward = new Map<string, Coordinate>();
  const inwardByType = new Map<VaultEntityType, string[]>();

  for (const [key, count] of sameType) {
    const cut = key.indexOf("|");
    const type = key.slice(0, cut) as VaultEntityType;
    const group = key.slice(cut + 1);
    const total = facing.get(group) ?? { x: 0, y: 0, z: 0 };
    const own = anchorFor(type);

    if (
      Math.hypot(total.x - own.x * count, total.y - own.y * count, total.z - own.z * count) <= 1e-6
    ) {
      inwardByType.set(type, [...(inwardByType.get(type) ?? []), key]);
    }
  }

  for (const [type, keys] of inwardByType) {
    keys
      .sort((a, b) => (sameType.get(b) ?? 0) - (sameType.get(a) ?? 0) || byId(a, b))
      .forEach((key, index) => {
        inward.set(key, discSpot(type, index, keys.length));
      });
  }

  const anchorCache = new Map<string, Coordinate>();
  const anchorOf = (entry: SettleNode): Coordinate => {
    const group = topic.get(entry.entityId) ?? entry.entityId;
    const cacheKey = groupKey(entry.type, group);
    const cached = anchorCache.get(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    const own = anchorFor(entry.type);
    const sum = facing.get(group) ?? { x: 0, y: 0, z: 0 };
    const outward = add(sum, own, -(sameType.get(cacheKey) ?? 0));
    const towards =
      Math.hypot(outward.x, outward.y, outward.z) > 1e-6
        ? normalize(outward)
        : (inward.get(cacheKey) ?? hashedDirection(group, 0x85ebca6b));
    const anchor = topicAnchor(entry.type, towards);

    anchorCache.set(cacheKey, anchor);

    return anchor;
  };

  for (const candidate of pending) {
    placed.set(candidate.entityId, jittered(anchorOf(candidate), candidate.key));
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

      const anchor = anchorOf(candidate);
      let force = scaled(add(anchor, current, -1), TOPIC_PULL);

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
      const next = contain(add(current, force, step));

      movement += distance(current, next);
      placed.set(candidate.entityId, next);
    }

    if (movement < REST_EPSILON) {
      break;
    }
  }

  return { placed, iterations };
}
