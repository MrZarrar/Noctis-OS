import type { VaultEntityType } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import type { Coordinate, SettleNode } from "./layout.js";
import {
  CORE_RADIUS,
  LAYOUT_VERSION,
  SHELL_RADIUS,
  anchorFor,
  communities,
  distance,
  seedCoordinate,
  settle,
} from "./layout.js";

function node(entityId: string, over: Partial<SettleNode> = {}): SettleNode {
  return { entityId, key: entityId, type: "note", neighbourIds: [], ...over };
}

const ORIGIN: Coordinate = { x: 0, y: 0, z: 0 };

/** Symmetric neighbour lists, as the indexer builds them. */
function graph(
  types: ReadonlyMap<string, VaultEntityType>,
  pairs: ReadonlyArray<readonly [string, string]>,
): SettleNode[] {
  const links = new Map<string, Set<string>>();

  for (const [a, b] of pairs) {
    links.set(a, (links.get(a) ?? new Set()).add(b));
    links.set(b, (links.get(b) ?? new Set()).add(a));
  }

  return [...types].map(([id, type]) =>
    node(id, { type, neighbourIds: [...(links.get(id) ?? [])] }),
  );
}

function clique(ids: readonly string[]): Array<[string, string]> {
  return ids.flatMap((a, index) => ids.slice(index + 1).map((b): [string, string] => [a, b]));
}

function centroid(points: readonly Coordinate[]): Coordinate {
  return points.reduce(
    (total, point) => ({
      x: total.x + point.x / points.length,
      y: total.y + point.y / points.length,
      z: total.z + point.z / points.length,
    }),
    ORIGIN,
  );
}

function meanDistance(a: readonly Coordinate[], b: readonly Coordinate[]): number {
  const gaps = a.flatMap((p) => b.filter((q) => q !== p).map((q) => distance(p, q)));

  return gaps.reduce((total, gap) => total + gap, 0) / gaps.length;
}

/** Shaped like a real personal Vault: a dozen links per note, and one hub linked to nearly everything. */
function denseVault(count: number): SettleNode[] {
  const types = ["capture", "project", "person", "reference", "note", "daily"] as const;
  const pairs: Array<[string, string]> = [];

  for (let index = 1; index < count; index += 1) {
    pairs.push(["n0", `n${String(index)}`]);
    for (let step = 1; step <= 6; step += 1) {
      const other = (index * 7 + step * 13) % count;
      if (other !== index) {
        pairs.push([`n${String(index)}`, `n${String(other)}`]);
      }
    }
  }

  return graph(
    new Map(
      Array.from({ length: count }, (_unused, index) => [
        `n${String(index)}`,
        types[index % types.length] ?? "note",
      ]),
    ),
    pairs,
  );
}

describe("seeded coordinates", () => {
  it("depends only on the key and type", () => {
    expect(seedCoordinate("alex-kerr", "person")).toEqual(seedCoordinate("alex-kerr", "person"));
    expect(seedCoordinate("alex-kerr", "person")).not.toEqual(
      seedCoordinate("alex-kerr", "project"),
    );
    expect(seedCoordinate("alex-kerr", "person")).not.toEqual(seedCoordinate("acme", "person"));
  });

  it("puts every seed inside the sphere and clear of the core", () => {
    for (const key of ["a", "bb", "ccc", "a-much-longer-key", "üñî"]) {
      const radius = distance(seedCoordinate(key, "note"), ORIGIN);

      expect(radius).toBeGreaterThanOrEqual(CORE_RADIUS);
      expect(radius).toBeLessThanOrEqual(SHELL_RADIUS);
    }
  });

  it("seeds a type in its own lobe", () => {
    const anchor = anchorFor("person");

    for (const key of ["alex", "sam", "kim", "jo"]) {
      const seeded = seedCoordinate(key, "person");
      const cosine =
        (seeded.x * anchor.x + seeded.y * anchor.y + seeded.z * anchor.z) /
        distance(seeded, ORIGIN);

      expect(cosine).toBeGreaterThan(0.8);
    }
  });

  it("gives different types different anchors", () => {
    const anchors = (
      ["capture", "project", "person", "reference", "daily", "agent", "note"] as const
    ).map((type) => JSON.stringify(anchorFor(type)));

    expect(new Set(anchors).size).toBe(anchors.length);
  });
});

describe("topic communities", () => {
  it("finds two groups joined by one link", () => {
    const pairs = [...clique(["a1", "a2", "a3", "a4"]), ...clique(["b1", "b2", "b3", "b4"])];
    pairs.push(["a1", "b1"]);
    const nodes = graph(new Map([...pairs.flat()].map((id) => [id, "note"])), pairs);
    const found = communities(nodes);

    expect(new Set(["a1", "a2", "a3", "a4"].map((id) => found.get(id))).size).toBe(1);
    expect(new Set(["b1", "b2", "b3", "b4"].map((id) => found.get(id))).size).toBe(1);
    expect(found.get("a2")).not.toBe(found.get("b2"));
  });

  it("is not merged into one group by a hub linked to everything", () => {
    const pairs = [...clique(["a1", "a2", "a3", "a4"]), ...clique(["b1", "b2", "b3", "b4"])];
    for (const id of ["a1", "a2", "a3", "a4", "b1", "b2", "b3", "b4"]) {
      pairs.push(["hub", id]);
    }
    const nodes = graph(new Map([...pairs.flat()].map((id) => [id, "note"])), pairs);
    const found = communities(nodes);

    expect(found.get("a2")).not.toBe(found.get("b2"));
  });

  it("does not depend on the order the notes arrive in", () => {
    const nodes = denseVault(60);

    expect(communities([...nodes].reverse())).toEqual(communities(nodes));
  });
});

describe("bounded settlement", () => {
  it("THE GATE: never moves a node that is already placed", () => {
    const placed = new Map<string, Coordinate>([["existing", { x: 1, y: 2, z: 3 }]]);
    const result = settle({
      placed,
      incoming: [node("fresh", { neighbourIds: ["existing"] })],
    });

    expect(result.placed.get("existing")).toEqual({ x: 1, y: 2, z: 3 });
    expect(result.placed.has("fresh")).toBe(true);
  });

  it("THE GATE: a settled graph is a fixed point, so nothing wanders at rest", () => {
    const first = settle({
      placed: new Map(),
      incoming: [
        node("a", { type: "person", neighbourIds: ["b"] }),
        node("b", { type: "project", neighbourIds: ["a"] }),
        node("c", { type: "note" }),
      ],
    });

    // Re-settling with everything already placed has nothing left to do. This
    // is what "remove continuous force wandering when the graph is at rest"
    // means as a property rather than as an animation setting.
    const again = settle({ placed: first.placed, incoming: [] });

    expect(again.placed).toEqual(first.placed);
    expect(again.iterations).toBe(0);
  });

  it("is deterministic across runs", () => {
    const incoming = [
      node("a", { type: "person", neighbourIds: ["b", "c"] }),
      node("b", { type: "project", neighbourIds: ["a"] }),
      node("c", { type: "reference", neighbourIds: ["a"] }),
    ];

    expect(settle({ placed: new Map(), incoming }).placed).toEqual(
      settle({ placed: new Map(), incoming }).placed,
    );
  });

  it("does not depend on the order the new nodes arrive in", () => {
    const incoming = denseVault(40);

    expect(settle({ placed: new Map(), incoming: [...incoming].reverse() }).placed).toEqual(
      settle({ placed: new Map(), incoming }).placed,
    );
  });

  it("terminates within its iteration bound", () => {
    const incoming = Array.from({ length: 40 }, (_unused, index) =>
      node(`n${String(index)}`, { neighbourIds: index === 0 ? [] : [`n${String(index - 1)}`] }),
    );

    const result = settle({ placed: new Map(), incoming, iterations: 12 });

    expect(result.iterations).toBeLessThanOrEqual(12);
    expect(result.placed.size).toBe(40);
  });

  it("pulls a new node toward the neighbour it links to", () => {
    const target = seedCoordinate("far", "agent");
    const seeded = seedCoordinate("lonely", "person");
    const result = settle({
      placed: new Map([["far", target]]),
      incoming: [node("lonely", { type: "person", neighbourIds: ["far"] })],
    });

    const settled = result.placed.get("lonely");

    expect(settled).toBeDefined();
    expect(distance(settled as Coordinate, target)).toBeLessThan(distance(seeded, target));
  });

  it("keeps every settled node inside the sphere, clear of the core, and finite", () => {
    const result = settle({ placed: new Map(), incoming: denseVault(120) });

    for (const coordinate of result.placed.values()) {
      const radius = distance(coordinate, ORIGIN);

      expect(Number.isFinite(coordinate.x)).toBe(true);
      expect(radius).toBeGreaterThanOrEqual(CORE_RADIUS - 1e-9);
      expect(radius).toBeLessThanOrEqual(SHELL_RADIUS + 1e-9);
    }
  });

  it("fills the sphere's depth instead of lining the shell", () => {
    const radii = [...settle({ placed: new Map(), incoming: denseVault(120) }).placed.values()]
      .map((coordinate) => distance(coordinate, ORIGIN))
      .sort((a, b) => a - b);

    expect(radii[Math.floor(radii.length / 2)]).toBeLessThan(SHELL_RADIUS * 0.9);
    expect((radii.at(-1) ?? 0) - (radii[0] ?? 0)).toBeGreaterThan(SHELL_RADIUS * 0.2);
  });

  it("separates two nodes that would otherwise land on top of each other", () => {
    const result = settle({
      placed: new Map(),
      // Same type and both linked to the same place: without separation these
      // converge on one point and the graph reads as a single node.
      incoming: [
        node("a", { type: "person", neighbourIds: ["c"] }),
        node("b", { type: "person", neighbourIds: ["c"] }),
        node("c", { type: "person" }),
      ],
    });

    const a = result.placed.get("a") as Coordinate;
    const b = result.placed.get("b") as Coordinate;

    expect(distance(a, b)).toBeGreaterThan(0.1);
  });

  it("never stacks notes on one another in a dense Vault", () => {
    const points = [...settle({ placed: new Map(), incoming: denseVault(150) }).placed.values()];
    const nearest = points.map((point) =>
      Math.min(...points.filter((other) => other !== point).map((other) => distance(point, other))),
    );

    expect(Math.min(...nearest)).toBeGreaterThan(0.5);
  });

  it("gathers each type into its own lobe", () => {
    const incoming = denseVault(150);
    const placed = settle({ placed: new Map(), incoming }).placed;
    const byType = new Map<VaultEntityType, Coordinate[]>();

    for (const entry of incoming) {
      byType.set(entry.type, [
        ...(byType.get(entry.type) ?? []),
        placed.get(entry.entityId) as Coordinate,
      ]);
    }

    const centres = new Map([...byType].map(([type, points]) => [type, centroid(points)]));
    const home = incoming.filter((entry) => {
      const point = placed.get(entry.entityId) as Coordinate;
      const own = distance(point, centres.get(entry.type) as Coordinate);

      return [...centres.values()].every((centre) => distance(point, centre) >= own);
    });

    expect(home.length / incoming.length).toBeGreaterThan(0.85);
  });

  it("clumps a type's separate topics apart inside its lobe", () => {
    const left = ["l1", "l2", "l3", "l4", "l5", "l6"];
    const right = ["r1", "r2", "r3", "r4", "r5", "r6"];
    const pairs = [...clique(left), ...clique(right)];
    const types = new Map<string, VaultEntityType>([...left, ...right].map((id) => [id, "person"]));
    const placed = settle({ placed: new Map(), incoming: graph(types, pairs) }).placed;
    const at = (ids: readonly string[]): Coordinate[] =>
      ids.map((id) => placed.get(id) as Coordinate);

    const within = (meanDistance(at(left), at(left)) + meanDistance(at(right), at(right))) / 2;

    expect(within).toBeLessThan(meanDistance(at(left), at(right)) * 0.7);
  });

  it("declares a layout version so old coordinates can be recognised", () => {
    expect(LAYOUT_VERSION).toBeGreaterThan(2);
  });
});
