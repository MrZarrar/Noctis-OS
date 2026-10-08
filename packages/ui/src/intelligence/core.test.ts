import { describe, expect, it } from "vitest";

import {
  buildCoreGeometry,
  buildJesterMarks,
  coreAppearance,
  JESTER_PROFILE,
  profileFor,
  shouldAnimateCore,
  VESPER_PROFILE,
} from "./core.js";

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

describe("Jester's core profile (the owner's pick: the hidden grin)", () => {
  it("is the profile for Jester, and Vesper's stays Vesper's", () => {
    expect(profileFor("jester")).toBe(JESTER_PROFILE);
    expect(profileFor("vesper")).toBe(VESPER_PROFILE);
    expect(JESTER_PROFILE.jester).toEqual({ lime: "#b6ff3b", red: "#ff3b5c" });
    expect(VESPER_PROFILE.jester).toBeUndefined();
  });

  it("hides the face at rest and while listening, shows it thinking and speaking, and drops it for approval", () => {
    const face = (state: Parameters<typeof coreAppearance>[0]): number =>
      coreAppearance(state, JESTER_PROFILE).face;

    expect(face("idle")).toBe(0);
    expect(face("listening")).toBe(0);
    expect(face("thinking")).toBeGreaterThan(0.5);
    expect(face("speaking")).toBe(1);
    expect(face("waiting_for_approval")).toBe(0);
    expect(coreAppearance("waiting_for_approval", JESTER_PROFILE).coreColor).toBe(
      JESTER_PROFILE.approval,
    );
  });

  it("runs the lime faults brighter as Jester gets busier, and never on Vesper", () => {
    const fault = (state: Parameters<typeof coreAppearance>[0]): number =>
      coreAppearance(state, JESTER_PROFILE).fault;

    expect(fault("idle")).toBeGreaterThan(0);
    expect(fault("listening")).toBeGreaterThan(fault("idle"));
    expect(fault("thinking")).toBeGreaterThan(fault("listening"));
    expect(fault("speaking")).toBeGreaterThan(fault("thinking"));
    expect(fault("waiting_for_approval")).toBeLessThan(fault("idle"));
    for (const state of ["idle", "speaking", "waiting_for_approval"] as const) {
      expect(coreAppearance(state, VESPER_PROFILE)).toMatchObject({ face: 0, fault: 0 });
    }
  });

  it("cracks the cage along connected front-facing fault lines that cross it", () => {
    const core = buildCoreGeometry();
    const marks = buildJesterMarks(core);
    const edges = new Set(core.edges.map(([a, b]) => `${a}:${b}`));

    expect(marks).toEqual(buildJesterMarks(core));
    expect(marks.faults.length).toBe(2);
    for (const fault of marks.faults) {
      expect(fault.length).toBeGreaterThanOrEqual(6);
      fault.slice(1).forEach((point, index) => {
        const previous = fault[index]!;
        expect(edges.has(`${Math.min(previous, point)}:${Math.max(previous, point)}`)).toBe(true);
      });
      const ys = fault.map((index) => core.points[index]![1]);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1.5);
      expect(new Set(fault).size).toBe(fault.length);
    }
  });

  it("places a grin below the centre that curls up at the ends, with the red eye left and the violet eye right", () => {
    const marks = buildJesterMarks(buildCoreGeometry());
    const grin = marks.grin;
    const middle = grin[Math.floor(grin.length / 2)]!;

    expect(grin.length).toBeGreaterThanOrEqual(9);
    expect(middle[1]).toBeLessThan(-0.3);
    expect(grin[0]![1]).toBeGreaterThan(middle[1] + 0.2);
    expect(grin.at(-1)![1]).toBeGreaterThan(middle[1] + 0.2);
    expect(grin.every(([, , z]) => z > 0)).toBe(true);
    expect(marks.redEye[0]).toBeLessThan(0);
    expect(marks.violetEye[0]).toBeGreaterThan(0);
    expect(marks.redEye[1]).toBeGreaterThan(0.2);
    expect(marks.violetEye[1]).toBe(marks.redEye[1]);
  });

  it("hangs lime drips straight down from the shards and the faults", () => {
    const marks = buildJesterMarks(buildCoreGeometry());

    expect(marks.drips.length).toBeGreaterThanOrEqual(8);
    expect(marks.drips.length).toBeLessThanOrEqual(24);
    for (const [top, bottom] of marks.drips) {
      expect(bottom[0]).toBe(top[0]);
      expect(bottom[2]).toBe(top[2]);
      expect(top[1] - bottom[1]).toBeGreaterThan(0.1);
      expect(top[1] - bottom[1]).toBeLessThan(0.5);
    }
  });
});
