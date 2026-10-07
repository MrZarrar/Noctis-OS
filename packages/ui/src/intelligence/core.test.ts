import { describe, expect, it } from "vitest";

import { buildCoreGeometry, coreAppearance, shouldAnimateCore, VESPER_PROFILE } from "./core.js";

describe("Presence core geometry", () => {
  it("uses local irregular connections and leaves space between centre fragments", () => {
    const core = buildCoreGeometry();
    const longEdges = core.edges.filter(([a, b]) => {
      const from = core.points[a]!;
      const to = core.points[b]!;
      return Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]) > 1;
    });
    expect(longEdges.length / core.edges.length).toBeLessThan(0.08);
    const heights = core.points.map(([, y]) => y).sort((a, b) => a - b);
    expect(Math.max(...heights.slice(1).map((y, index) => y - heights[index]!))).toBeLessThan(0.18);
    expect(core.fragments.length).toBeLessThanOrEqual(14);
    expect(
      core.fragments.every(
        (fragment) =>
          Math.max(...fragment.map(([, y]) => y)) - Math.min(...fragment.map(([, y]) => y)) < 0.27,
      ),
    ).toBe(true);
  });
  it("keeps the shard mesh deterministic, round, connected and bounded", () => {
    const core = buildCoreGeometry();
    expect(core).toEqual(buildCoreGeometry());
    expect(core.points.length).toBeGreaterThan(100);
    expect(core.points.length).toBeLessThan(300);
    expect(core.edges.length).toBeLessThan(1000);
    expect(core.edges.length).toBeGreaterThan(500);
    expect(core.shards.length).toBeGreaterThan(8);
    expect(core.fragments.length).toBeGreaterThan(8);
    expect(core.points.every((point) => point.every(Number.isFinite))).toBe(true);
    const width =
      Math.max(...core.points.map(([x]) => x)) - Math.min(...core.points.map(([x]) => x));
    const height =
      Math.max(...core.points.map(([, y]) => y)) - Math.min(...core.points.map(([, y]) => y));
    expect(height / width).toBeGreaterThan(0.85);
    expect(height / width).toBeLessThan(1.15);
    const shell = core.shards.flat();
    const shellWidth = Math.max(...shell.map(([x]) => x)) - Math.min(...shell.map(([x]) => x));
    const shellHeight = Math.max(...shell.map(([, y]) => y)) - Math.min(...shell.map(([, y]) => y));
    expect(shellHeight / shellWidth).toBeGreaterThan(0.85);
    expect(shellHeight / shellWidth).toBeLessThan(1.15);
    const connected = new Set([0]);
    for (let pass = 0; pass < core.points.length; pass += 1) {
      for (const [a, b] of core.edges) {
        if (connected.has(a) || connected.has(b)) {
          connected.add(a);
          connected.add(b);
        }
      }
    }
    expect(connected.size).toBe(core.points.length);
  });
});

describe("Presence core scheduling", () => {
  it("only animates visible active states", () => {
    for (const state of ["idle"] as const) {
      expect(shouldAnimateCore(state, false, true, false)).toBe(false);
    }
    for (const state of ["listening", "thinking", "speaking", "waiting_for_approval"] as const) {
      expect(shouldAnimateCore(state, false, true, false)).toBe(true);
      expect(shouldAnimateCore(state, true, true, false)).toBe(false);
      expect(shouldAnimateCore(state, false, false, false)).toBe(false);
      expect(shouldAnimateCore(state, false, true, true)).toBe(false);
    }
  });

  it("turns the whole heart amber for approval while preserving the violet shell", () => {
    expect(coreAppearance("waiting_for_approval", VESPER_PROFILE)).toMatchObject({
      approval: true,
      coreColor: VESPER_PROFILE.approval,
      color: VESPER_PROFILE.violet,
    });
    expect(coreAppearance("idle", VESPER_PROFILE)).toMatchObject({
      approval: false,
      coreColor: VESPER_PROFILE.violet,
    });
    expect(coreAppearance("speaking", VESPER_PROFILE).light).toBeGreaterThan(
      coreAppearance("idle", VESPER_PROFILE).light,
    );
  });
});
