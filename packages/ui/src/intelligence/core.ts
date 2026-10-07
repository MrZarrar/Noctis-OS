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
    const y = 2.3 - (index / 167) * 4.6 + (random(index + 400) - 0.5) * 0.18;
    const radius = 0.12 + (1 - Math.abs(y) / 2.5) * 1.12;
    const angle = index * 2.399 + random(index) * 0.9;
    const spread = radius * (0.32 + random(index + 200) * 0.77);
    points.push([Math.cos(angle) * spread, y, Math.sin(angle) * spread * 0.68]);
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

  const shards: CorePoint[][] = [
    [
      [-0.07, 2.48, 0.03],
      [-0.32, 2.03, 0.1],
      [-0.03, 1.85, 0.18],
    ],
    [
      [0.05, 1.94, 0.25],
      [0.72, 1.36, 0.19],
      [0.84, 1.02, 0.37],
      [0.16, 1.31, 0.49],
    ],
    [
      [-0.29, 1.53, 0.37],
      [-1.13, 0.78, 0.32],
      [-0.68, 0.38, 0.54],
      [-0.4, 0.76, 0.58],
    ],
    [
      [-1.01, 0.48, 0.16],
      [-1.46, -0.1, 0.01],
      [-1.12, -0.33, 0.37],
    ],
    [
      [0.11, 1.2, 0.5],
      [0.55, 0.44, 0.62],
      [0.23, 0.33, 0.77],
      [-0.03, 0.87, 0.66],
    ],
    [
      [1.07, 0.75, 0.03],
      [1.32, -0.18, 0.18],
      [0.94, 0.1, 0.41],
    ],
    [
      [0.92, -0.05, 0.43],
      [1.21, -0.42, 0.34],
      [0.61, -0.85, 0.49],
    ],
    [
      [-1.14, -0.6, 0.27],
      [-0.28, -0.48, 0.63],
      [-0.21, -1.52, 0.25],
      [-0.63, -1.12, 0.57],
    ],
    [
      [0.34, -1.25, 0.48],
      [1.05, -0.95, 0.19],
      [0.21, -2.17, 0.21],
    ],
    [
      [-0.55, -1.61, 0.27],
      [-0.08, -1.94, 0.44],
      [-0.16, -2.37, 0.15],
    ],
    [
      [-1.45, 0.89, -0.15],
      [-1.22, 0.87, 0.01],
      [-1.37, 0.5, 0.14],
    ],
    [
      [1.24, 1.13, -0.19],
      [1.48, 1.33, -0.05],
      [1.46, 0.94, 0.13],
    ],
    [
      [-0.91, -1.45, -0.1],
      [-0.87, -1.79, 0.16],
      [-1.08, -1.67, 0.05],
    ],
    [
      [1.21, -1.34, -0.09],
      [1.38, -1.5, 0.06],
      [1.18, -1.67, 0.15],
    ],
  ];
  const fragments: CorePoint[][] = [];
  for (let index = 0; index < 14; index += 1) {
    const angle = index * 2.399;
    const x = Math.cos(angle) * (0.07 + random(index + 800) * 0.24);
    const y = 0.48 - (index / 13) * 0.96 + (random(index + 900) - 0.5) * 0.09;
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
  return (
    !reduced &&
    visible &&
    !hidden &&
    (state === "listening" || state === "thinking" || state === "speaking")
  );
}

export function coreAppearance(
  state: IntelligenceState,
  profile: IntelligenceProfile,
): { light: number; expansion: number; approval: boolean; color: string; approvalColor: string } {
  const light = {
    idle: 0.72,
    listening: 1.02,
    thinking: 1.18,
    speaking: 1.52,
    waiting_for_approval: 0.67,
  }[state];
  return {
    light,
    expansion: state === "speaking" ? 1.035 : state === "listening" ? 1.02 : 1,
    approval: state === "waiting_for_approval",
    color: profile.violet,
    approvalColor: profile.approval,
  };
}
