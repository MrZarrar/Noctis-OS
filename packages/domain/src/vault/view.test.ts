import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAMERA,
  MAX_PITCH,
  MAX_ZOOM,
  MIN_ZOOM,
  clampCamera,
  focusSubgraph,
  project,
} from "./view.js";

const VIEWPORT = { width: 800, height: 600 };

describe("the Vault camera", () => {
  it("clamps zoom to a usable range", () => {
    expect(clampCamera({ ...DEFAULT_CAMERA, zoom: 0 }).zoom).toBe(MIN_ZOOM);
    expect(clampCamera({ ...DEFAULT_CAMERA, zoom: 100 }).zoom).toBe(MAX_ZOOM);
  });

  it("keeps the sphere upright by clamping pitch short of the poles", () => {
    expect(clampCamera({ ...DEFAULT_CAMERA, pitch: 10 }).pitch).toBe(MAX_PITCH);
    expect(clampCamera({ ...DEFAULT_CAMERA, pitch: -10 }).pitch).toBe(-MAX_PITCH);
  });

  it("wraps yaw instead of clamping it, so the sphere spins freely", () => {
    expect(clampCamera({ ...DEFAULT_CAMERA, yaw: Math.PI * 4 }).yaw).toBeCloseTo(0, 6);
  });

  it("leaves pan alone: the user decides where the sphere sits", () => {
    const panned = clampCamera({ ...DEFAULT_CAMERA, panX: -5000, panY: 9000 });

    expect(panned.panX).toBe(-5000);
    expect(panned.panY).toBe(9000);
  });
});

describe("projection", () => {
  const origin = { x: 0, y: 0, z: 0 };

  it("puts the centre of the sphere at the centre of the viewport", () => {
    const projected = project(origin, { ...DEFAULT_CAMERA, pitch: 0, yaw: 0 }, VIEWPORT);

    expect(projected.x).toBeCloseTo(VIEWPORT.width / 2, 6);
    expect(projected.y).toBeCloseTo(VIEWPORT.height / 2, 6);
  });

  it("moves the whole scene by the pan", () => {
    const camera = { ...DEFAULT_CAMERA, panX: 40, panY: -25 };
    const projected = project(origin, camera, VIEWPORT);

    expect(projected.x).toBeCloseTo(VIEWPORT.width / 2 + 40, 6);
    expect(projected.y).toBeCloseTo(VIEWPORT.height / 2 - 25, 6);
  });

  it("draws a nearer node larger than a farther one", () => {
    const camera = { ...DEFAULT_CAMERA, pitch: 0, yaw: 0 };
    const near = project({ x: 0, y: 0, z: 10 }, camera, VIEWPORT);
    const far = project({ x: 0, y: 0, z: -10 }, camera, VIEWPORT);

    expect(near.scale).toBeGreaterThan(far.scale);
    expect(near.depth).toBeGreaterThan(far.depth);
  });

  it("treats layout y as up, not down", () => {
    const camera = { ...DEFAULT_CAMERA, pitch: 0, yaw: 0 };
    const above = project({ x: 0, y: 10, z: 0 }, camera, VIEWPORT);

    expect(above.y).toBeLessThan(VIEWPORT.height / 2);
  });

  it("turns the sphere when yaw changes, and does so reversibly", () => {
    const point = { x: 10, y: 0, z: 0 };
    const straight = project(point, { ...DEFAULT_CAMERA, pitch: 0, yaw: 0 }, VIEWPORT);
    const turned = project(point, { ...DEFAULT_CAMERA, pitch: 0, yaw: Math.PI / 2 }, VIEWPORT);
    const back = project(point, { ...DEFAULT_CAMERA, pitch: 0, yaw: Math.PI * 2 }, VIEWPORT);

    expect(turned.x).not.toBeCloseTo(straight.x, 3);
    expect(back.x).toBeCloseTo(straight.x, 6);
  });

  it("scales the scene by zoom", () => {
    const point = { x: 10, y: 0, z: 0 };
    const camera = { ...DEFAULT_CAMERA, pitch: 0, yaw: 0 };
    const one = project(point, { ...camera, zoom: 1 }, VIEWPORT);
    const two = project(point, { ...camera, zoom: 2 }, VIEWPORT);

    expect(two.x - VIEWPORT.width / 2).toBeCloseTo((one.x - VIEWPORT.width / 2) * 2, 6);
  });
});

describe("focus isolation", () => {
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "c", target: "d" },
    { source: "x", target: "y" },
  ];

  it("shows the whole graph when nothing is focused", () => {
    expect(focusSubgraph(edges, undefined)).toBeUndefined();
  });

  it("THE GATE: opens only the focused subgraph, not the whole Vault", () => {
    const visible = focusSubgraph(edges, "a");

    expect(visible).toEqual(new Set(["a", "b"]));
    expect(visible?.has("x")).toBe(false);
    expect(visible?.has("d")).toBe(false);
  });

  it("reaches further when asked for more hops", () => {
    expect(focusSubgraph(edges, "a", 2)).toEqual(new Set(["a", "b", "c"]));
  });

  it("follows an edge in either direction", () => {
    expect(focusSubgraph(edges, "b")).toEqual(new Set(["a", "b", "c"]));
  });

  it("isolates a node nothing links to", () => {
    expect(focusSubgraph(edges, "lonely")).toEqual(new Set(["lonely"]));
  });
});
