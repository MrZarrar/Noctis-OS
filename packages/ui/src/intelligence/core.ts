export type IntelligenceState =
  "idle" | "listening" | "thinking" | "speaking" | "waiting_for_approval";

export interface IntelligenceProfile {
  readonly name: "vesper";
  readonly violet: string;
  readonly glass: string;
  readonly approval: string;
}

export const VESPER_PROFILE: IntelligenceProfile = {
  name: "vesper",
  violet: "#8856ff",
  glass: "#afb9e6",
  approval: "#ffc16c",
};

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
): { light: number; expansion: number; approval: boolean; color: string; coreColor: string } {
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
  };
}
