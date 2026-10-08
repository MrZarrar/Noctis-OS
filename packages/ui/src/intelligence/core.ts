export type IntelligenceState =
  "idle" | "listening" | "thinking" | "speaking" | "waiting_for_approval";

export interface IntelligenceProfile {
  readonly name: "vesper" | "jester";
  readonly violet: string;
  readonly glass: string;
  readonly approval: string;
  /**
   * Jester's irregular energy (master plan §6: "lime and red provocation
   * annotations, never merely a colour swap"). Absent for Vesper.
   */
  readonly jester?: { readonly lime: string; readonly red: string };
}

export const VESPER_PROFILE: IntelligenceProfile = {
  name: "vesper",
  violet: "#8856ff",
  glass: "#afb9e6",
  approval: "#ffc16c",
};

/**
 * The owner's pick (2026-10-08, `docs/design/assets/jester/core-c-hidden-grin.png`):
 * Vesper's cage cracked along lime fault lines, whose red eye and grin surface
 * only while Jester is thinking or speaking.
 */
export const JESTER_PROFILE: IntelligenceProfile = {
  name: "jester",
  violet: "#8856ff",
  glass: "#afb9e6",
  approval: "#ffc16c",
  jester: { lime: "#b6ff3b", red: "#ff3b5c" },
};

export function profileFor(identityId: "vesper" | "jester"): IntelligenceProfile {
  return identityId === "jester" ? JESTER_PROFILE : VESPER_PROFILE;
}

export type CorePoint = readonly [number, number, number];

export function buildCoreGeometry(): {
  points: CorePoint[];
  edges: Array<readonly [number, number]>;
  shards: CorePoint[][];
  fragments: CorePoint[][];
} {
  const points: CorePoint[] = [];
  const edges: Array<readonly [number, number]> = [];
  const random = (index: number): number => {
    const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
  };

  for (let index = 0; index < 168; index += 1) {
    const y = 1 - (index / 167) * 2;
    const radius = Math.sqrt(1 - y * y);
    const angle = index * 2.399 + random(index) * 0.9;
    const scale = 1.78 * (0.85 + random(index + 200) * 0.23);
    points.push([
      Math.cos(angle) * radius * scale,
      y * scale,
      Math.sin(angle) * radius * scale * 0.72,
    ]);
  }
  const connected = new Set<string>();
  points.forEach((point, index) => {
    const neighbors = points
      .map((other, target) => ({
        target,
        distance: Math.hypot(point[0] - other[0], point[1] - other[1], point[2] - other[2]),
      }))
      .filter(({ target }) => target !== index)
      .sort((a, b) => a.distance - b.distance);
    const targets = neighbors.slice(0, 6).map(({ target }) => target);
    const earlier = neighbors.find(({ target }) => target < index);
    if (earlier !== undefined) targets.push(earlier.target);
    for (const target of targets) {
      const a = Math.min(index, target);
      const b = Math.max(index, target);
      const key = `${a}:${b}`;
      if (!connected.has(key)) {
        connected.add(key);
        edges.push([a, b]);
      }
    }
  });

  const shards: CorePoint[][] = [];
  for (let index = 0; index < 14; index += 1) {
    const angle = (index / 14) * Math.PI * 2 + (random(index + 500) - 0.5) * 0.12;
    const radius = 1.63 + random(index + 600) * 0.3;
    const point = (offset: number, distance: number, z: number): CorePoint => [
      Math.cos(angle + offset) * distance,
      Math.sin(angle + offset) * distance,
      z,
    ];
    shards.push([
      point(-0.2, radius * 0.84, 0.12),
      point(0.01, radius + 0.18, 0.25),
      point(0.22, radius * 0.93, 0.44),
      point(0.08, radius * 0.59, 0.65),
    ]);
  }
  const fragments: CorePoint[][] = [];
  for (let index = 0; index < 14; index += 1) {
    const angle = index * 2.399;
    const radius = 0.18 + random(index + 800) * 0.27;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    const z = 0.25 + random(index + 1000) * 0.4;
    const size = 0.045 + random(index + 1100) * 0.073;
    fragments.push([
      [x, y + size, z],
      [x - size * 0.63, y - size * 0.6, z + size],
      [x + size * 0.74, y - size, z - size * 0.2],
    ]);
  }
  return { points, edges, shards, fragments };
}

export function shouldAnimateCore(
  state: IntelligenceState,
  reduced: boolean,
  visible: boolean,
  hidden: boolean,
): boolean {
  return !reduced && visible && !hidden && state !== "idle";
}

export function coreAppearance(
  state: IntelligenceState,
  profile: IntelligenceProfile,
): {
  light: number;
  expansion: number;
  approval: boolean;
  color: string;
  coreColor: string;
  /** How far Jester's red eye and grin have surfaced, 0 to 1; always 0 for Vesper. */
  face: number;
  /** How bright Jester's lime faults and drips run, 0 to 1; always 0 for Vesper. */
  fault: number;
} {
  const light = {
    idle: 0.72,
    listening: 1.02,
    thinking: 1.18,
    speaking: 1.52,
    waiting_for_approval: 0.92,
  }[state];
  return {
    light,
    expansion: state === "speaking" ? 1.035 : state === "listening" ? 1.02 : 1,
    approval: state === "waiting_for_approval",
    color: profile.violet,
    coreColor: state === "waiting_for_approval" ? profile.approval : profile.violet,
    face: profile.jester === undefined ? 0 : JESTER_FACE[state],
    fault: profile.jester === undefined ? 0 : JESTER_FAULT[state],
  };
}

const JESTER_FACE: Record<IntelligenceState, number> = {
  idle: 0,
  listening: 0,
  thinking: 0.75,
  speaking: 1,
  waiting_for_approval: 0,
};
const JESTER_FAULT: Record<IntelligenceState, number> = {
  idle: 0.45,
  listening: 0.6,
  thinking: 0.8,
  speaking: 1,
  waiting_for_approval: 0.25,
};

export interface JesterMarks {
  /** Two chains of point indices along the cage's own edges, lit lime. */
  faults: number[][];
  /** Lit nodes in a smile below the centre, on the cage's front. */
  grin: CorePoint[];
  redEye: CorePoint;
  /** Where the violet heart moves to as the face surfaces. */
  violetEye: CorePoint;
  /** Lime drips: [top, bottom], straight down. */
  drips: Array<readonly [CorePoint, CorePoint]>;
}

/** On the cage's front surface at (x, y), a little proud of it. */
function front(x: number, y: number): CorePoint {
  return [x, y, 0.72 * Math.sqrt(Math.max(0.04, 1.78 * 1.78 - x * x - y * y)) + 0.05];
}

/**
 * Where Jester's marks sit on the shared cage. Deterministic, like the cage,
 * so the static fallback and the WebGL scene draw the same face.
 */
export function buildJesterMarks(core: ReturnType<typeof buildCoreGeometry>): JesterMarks {
  const { points, edges, shards } = core;
  const neighbours = points.map((): number[] => []);
  for (const [a, b] of edges) {
    neighbours[a]!.push(b);
    neighbours[b]!.push(a);
  }
  const distance = (index: number, [x, y]: readonly [number, number]): number =>
    Math.hypot(points[index]![0] - x, points[index]![1] - y);

  // Greedy walk across the front of the cage, along edges it already has.
  const walk = (from: readonly [number, number], to: readonly [number, number]): number[] => {
    const facing = points.map((_, index) => index).filter((index) => points[index]![2] > 0);
    let current = facing.reduce((best, index) =>
      distance(index, from) < distance(best, from) ? index : best,
    );
    const path = [current];
    while (distance(current, to) > 0.3) {
      const next = neighbours[current]!.filter(
        (index) => points[index]![2] > 0 && !path.includes(index),
      ).sort((a, b) => distance(a, to) - distance(b, to))[0];
      if (next === undefined || distance(next, to) >= distance(current, to)) break;
      path.push(next);
      current = next;
    }
    return path;
  };
  const faults = [walk([-1.1, 1.35], [0.85, -1.45]), walk([0.55, 1.6], [1.35, -0.35])];

  const grin: CorePoint[] = [];
  for (let step = 0; step <= 10; step += 1) {
    const t = step / 5 - 1;
    grin.push(front(t * 0.95, -0.62 + 0.42 * t * t));
  }

  const drips: Array<readonly [CorePoint, CorePoint]> = [];
  const drip = (top: CorePoint, index: number): void => {
    const length = 0.15 + ((index * 37) % 10) * 0.03;
    drips.push([top, [top[0], top[1] - length, top[2]]]);
  };
  shards.forEach((shard, index) => {
    const lowest = shard.reduce((low, point) => (point[1] < low[1] ? point : low));
    if (lowest[1] < 0) drip(lowest, index);
  });
  faults
    .flat()
    .filter((index, order) => points[index]![1] < 0 && order % 2 === 0)
    .forEach((index) => drip(points[index]!, index));

  return {
    faults,
    grin,
    redEye: front(-0.62, 0.42),
    violetEye: front(0.62, 0.42),
    drips: drips.slice(0, 24),
  };
}
