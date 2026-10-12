import { describe, expect, it } from "vitest";

import type { Coordinate, SettleNode } from "./layout.js";
import {
  LAYOUT_VERSION,
  SHELL_RADIUS,
  anchorFor,
  distance,
  seedCoordinate,
  settle,
} from "./layout.js";

function node(entityId: string, over: Partial<SettleNode> = {}): SettleNode {
  return { entityId, key: entityId, type: "note", neighbourIds: [], ...over };
}

const ORIGIN: Coordinate = { x: 0, y: 0, z: 0 };

describe("seeded coordinates", () => {
  it("depends only on the key and type", () => {
    expect(seedCoordinate("alex-kerr", "person")).toEqual(seedCoordinate("alex-kerr", "person"));
    expect(seedCoordinate("alex-kerr", "person")).not.toEqual(
      seedCoordinate("alex-kerr", "project"),
    );
    expect(seedCoordinate("alex-kerr", "person")).not.toEqual(seedCoordinate("acme", "person"));
  });

  it("places every node on the shell", () => {
    for (const key of ["a", "bb", "ccc", "a-much-longer-key", "üñî"]) {
      expect(distance(seedCoordinate(key, "note"), ORIGIN)).toBeCloseTo(SHELL_RADIUS, 6);
    }
  });

  it("clusters a type around its own anchor", () => {
    const anchor = anchorFor("person");

    for (const key of ["alex", "sam", "kim", "jo"]) {
      const seeded = seedCoordinate(key, "person");
      const cosine =
        (seeded.x * anchor.x + seeded.y * anchor.y + seeded.z * anchor.z) / SHELL_RADIUS;

      // Inside the cluster cap rather than anywhere on the sphere.
      expect(cosine).toBeGreaterThan(0.5);
    }
  });

  it("gives different types different anchors", () => {
    const anchors = (
      ["capture", "project", "person", "reference", "daily", "agent", "note"] as const
    ).map((type) => JSON.stringify(anchorFor(type)));

    expect(new Set(anchors).size).toBe(anchors.length);
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
    const incoming = [
      node("a", { type: "person", neighbourIds: ["b"] }),
      node("b", { type: "project", neighbourIds: ["a"] }),
      node("c", { type: "daily" }),
    ];

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
    const anchor = anchorFor("agent");
    const target: Coordinate = {
      x: anchor.x * SHELL_RADIUS,
      y: anchor.y * SHELL_RADIUS,
      z: anchor.z * SHELL_RADIUS,
    };

    const seeded = seedCoordinate("lonely", "person");
    const result = settle({
      placed: new Map([["far", target]]),
      incoming: [node("lonely", { type: "person", neighbourIds: ["far"] })],
    });

    const settled = result.placed.get("lonely");

    expect(settled).toBeDefined();
    expect(distance(settled as Coordinate, target)).toBeLessThan(distance(seeded, target));
  });

  it("keeps every settled node on the shell and finite", () => {
    const result = settle({
      placed: new Map(),
      incoming: [
        node("a", { type: "person", neighbourIds: ["b"] }),
        node("b", { type: "capture", neighbourIds: ["a"] }),
      ],
    });

    for (const coordinate of result.placed.values()) {
      expect(Number.isFinite(coordinate.x)).toBe(true);
      expect(distance(coordinate, ORIGIN)).toBeCloseTo(SHELL_RADIUS, 6);
    }
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

  it("spreads a densely linked Vault over the sphere instead of piling it into a blob", () => {
    // Shaped like a real personal Vault: a dozen links per note, and one hub
    // that links to nearly everything.
    const count = 150;
    const types = ["capture", "project", "person", "reference", "note", "daily"] as const;
    const links = new Map<string, Set<string>>();
    const link = (a: number, b: number): void => {
      if (a === b) {
        return;
      }
      const [x, y] = [`n${String(a)}`, `n${String(b)}`];
      links.set(x, (links.get(x) ?? new Set()).add(y));
      links.set(y, (links.get(y) ?? new Set()).add(x));
    };

    for (let index = 0; index < count; index += 1) {
      link(0, index);
      for (let step = 1; step <= 6; step += 1) {
        link(index, (index * 7 + step * 13) % count);
      }
    }

    const incoming = Array.from({ length: count }, (_unused, index) =>
      node(`n${String(index)}`, {
        type: types[index % types.length] ?? "note",
        neighbourIds: [...(links.get(`n${String(index)}`) ?? [])],
      }),
    );

    const placed = settle({ placed: new Map(), incoming }).placed;
    const points = [...placed.values()];
    const nearest = points
      .map((point) =>
        Math.min(
          ...points.filter((other) => other !== point).map((other) => distance(point, other)),
        ),
      )
      .sort((a, b) => a - b);
    const ideal = Math.sqrt((4 * Math.PI * SHELL_RADIUS ** 2) / count);
    const centroid = points.reduce(
      (total, point) => ({
        x: total.x + point.x / (SHELL_RADIUS * count),
        y: total.y + point.y / (SHELL_RADIUS * count),
        z: total.z + point.z / (SHELL_RADIUS * count),
      }),
      ORIGIN,
    );

    expect(nearest[0]).toBeGreaterThan(ideal * 0.3);
    expect(nearest[Math.floor(count / 2)]).toBeGreaterThan(ideal * 0.6);
    // Balanced over the whole shell, not crowded onto one side of it.
    expect(distance(centroid, ORIGIN)).toBeLessThan(0.25);

    // Spreading out must not throw away the point of a graph: linked notes
    // still sit nearer each other than two notes picked at random (4R/3 apart
    // on average).
    const edgeLengths = [...links].flatMap(([id, others]) =>
      [...others].map((other) =>
        distance(placed.get(id) as Coordinate, placed.get(other) as Coordinate),
      ),
    );
    const meanEdge = edgeLengths.reduce((total, length) => total + length, 0) / edgeLengths.length;

    expect(meanEdge).toBeLessThan((4 * SHELL_RADIUS) / 3);
  });

  it("declares a layout version so old coordinates can be recognised", () => {
    expect(LAYOUT_VERSION).toBeGreaterThan(0);
  });
});
