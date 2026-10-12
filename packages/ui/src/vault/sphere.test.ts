import { SHELL_RADIUS } from "@noctis/domain";
import { describe, expect, it } from "vitest";

import type { LabelBox, SphereEdge } from "./sphere.js";
import {
  CONTENT_R,
  bezier,
  degreeOf,
  edgeControl,
  labelOpacity,
  placeLabels,
  radiusFor,
  thinEdges,
  toWorld,
  uniqueLinks,
} from "./sphere.js";

function edge(id: string, source: string, target: string): SphereEdge {
  return { id, source, target, lifecycle: "resolved" };
}

describe("toWorld", () => {
  it("puts a settled coordinate inside the shell rather than on it", () => {
    const world = toWorld({ x: SHELL_RADIUS, y: 0, z: 0 });

    expect(world.x).toBeCloseTo(CONTENT_R);
    // The donor's shell is drawn at R = 100; a node on it would sit in the
    // wireframe rather than inside the globe.
    expect(Math.hypot(world.x, world.y, world.z)).toBeLessThan(100);
  });

  it("is a pure scale, so relative geometry survives the conversion", () => {
    const a = toWorld({ x: 3, y: -4, z: 5 });
    const b = toWorld({ x: 6, y: -8, z: 10 });

    expect(b.x / a.x).toBeCloseTo(2);
    expect(b.y / a.y).toBeCloseTo(2);
    expect(b.z / a.z).toBeCloseTo(2);
  });
});

describe("thinEdges", () => {
  it("keeps every edge of a sparsely linked node", () => {
    const edges = [edge("e1", "leaf", "hub"), edge("e2", "hub", "other")];

    expect(thinEdges(edges, 4).map((kept) => kept.id)).toEqual(["e1", "e2"]);
  });

  it("sheds hub-to-hub crossings once both ends are already drawn", () => {
    // Two hubs, each with four cheap leaves, plus the crossing between them.
    const edges = [
      ...["a", "b", "c", "d"].map((leaf, index) =>
        edge(`la${String(index)}`, `leaf-a-${leaf}`, "hub-a"),
      ),
      ...["a", "b", "c", "d"].map((leaf, index) =>
        edge(`lb${String(index)}`, `leaf-b-${leaf}`, "hub-b"),
      ),
      edge("cross", "hub-a", "hub-b"),
    ];

    const kept = thinEdges(edges, 4).map((entry) => entry.id);

    expect(kept).not.toContain("cross");
    expect(kept).toHaveLength(8);
  });

  it("THE GATE: is deterministic under input order, so the drawn graph is stable", () => {
    const edges = [
      edge("e1", "a", "b"),
      edge("e2", "b", "c"),
      edge("e3", "c", "a"),
      edge("e4", "a", "d"),
      edge("e5", "b", "d"),
      edge("e6", "c", "d"),
      edge("e7", "d", "e"),
    ];

    const forward = thinEdges(edges, 2).map((entry) => entry.id);
    const reversed = thinEdges([...edges].reverse(), 2).map((entry) => entry.id);

    expect(reversed).toEqual(forward);
  });
});

describe("edgeControl", () => {
  it("bows the curve outward from the midpoint", () => {
    const a = { x: 40, y: 0, z: 0 };
    const b = { x: 0, y: 40, z: 0 };
    const control = edgeControl(a, b);

    expect(Math.hypot(control.x, control.y, control.z)).toBeGreaterThan(Math.hypot(20, 20, 0));
  });

  it("barely bends a short link, so a topic's links do not loop", () => {
    const a = { x: 50, y: 0, z: 0 };
    const b = { x: 50, y: 6, z: 0 };
    const control = edgeControl(a, b);
    const midpoint = { x: 50, y: 3, z: 0 };

    expect(
      Math.hypot(control.x - midpoint.x, control.y - midpoint.y, control.z - midpoint.z),
    ).toBeLessThan(2);
  });

  it("never lets a bowed edge leave the globe", () => {
    const a = { x: CONTENT_R, y: 0, z: 0 };
    const b = { x: -CONTENT_R * 0.2, y: CONTENT_R * 0.9, z: 0 };

    const control = edgeControl(a, b);

    expect(Math.hypot(control.x, control.y, control.z)).toBeLessThanOrEqual(CONTENT_R + 1e-9);
  });

  it("pushes an antipodal edge off the core instead of drawing through it", () => {
    const control = edgeControl({ x: 50, y: 0, z: 0 }, { x: -50, y: 0, z: 0 });

    expect(Math.hypot(control.x, control.y, control.z)).toBeGreaterThan(5);
  });
});

describe("bezier", () => {
  it("starts at a, ends at b, and bends toward the control point", () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 10, y: 0, z: 0 };
    const control = { x: 5, y: 10, z: 0 };

    expect(bezier(a, control, b, 0)).toEqual(a);
    expect(bezier(a, control, b, 1)).toEqual(b);
    expect(bezier(a, control, b, 0.5).y).toBeCloseTo(5);
  });
});

describe("labelOpacity", () => {
  it("hides labels on small nodes and fades them in as they grow", () => {
    expect(labelOpacity(4, false)).toBe(0);
    expect(labelOpacity(12, false)).toBe(0);
    expect(labelOpacity(15, false)).toBeCloseTo(0.6);
    expect(labelOpacity(40, false)).toBe(0.85);
  });

  it("always labels the node being talked about, however small", () => {
    expect(labelOpacity(1, true)).toBe(0.95);
  });
});

describe("uniqueLinks", () => {
  it("draws a mutual link once and drops a note linking to itself", () => {
    const kept = uniqueLinks([
      edge("ab", "a", "b"),
      edge("ba", "b", "a"),
      edge("aa", "a", "a"),
      edge("bc", "b", "c"),
    ]);

    expect(kept.map((entry) => entry.id)).toEqual(["ab", "bc"]);
  });
});

describe("placeLabels", () => {
  const label = (id: string, x: number, y: number, width = 60): LabelBox => ({
    id,
    x,
    y,
    width,
    height: 12,
  });

  it("drops a label that would overlap one already placed, keeping the first", () => {
    const kept = placeLabels([
      label("focus", 100, 100),
      label("crowded", 110, 104),
      label("clear", 100, 140),
    ]);

    expect([...kept]).toEqual(["focus", "clear"]);
  });

  it("keeps labels that only sit side by side", () => {
    expect(placeLabels([label("a", 0, 0, 50), label("b", 60, 0, 50)]).size).toBe(2);
  });
});

describe("radiusFor and degreeOf", () => {
  it("counts both ends of every edge", () => {
    const degree = degreeOf([edge("e1", "a", "b"), edge("e2", "b", "c")]);

    expect(degree.get("b")).toBe(2);
    expect(degree.get("a")).toBe(1);
    expect(degree.get("missing")).toBeUndefined();
  });

  it("grows with degree and stops, so one hub cannot swallow the globe", () => {
    expect(radiusFor(0)).toBeLessThan(radiusFor(4));
    expect(radiusFor(10_000)).toBe(4.5);
  });
});
