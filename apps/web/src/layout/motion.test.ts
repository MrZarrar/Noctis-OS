import { describe, expect, it } from "vitest";

import { arrivals, moveFrom } from "./motion.js";

const fresh = (
  memory: Parameters<typeof arrivals>[0],
  keys: string[],
  handoff?: Parameters<typeof arrivals>[2],
) => arrivals(memory, keys, handoff);

describe("arrivals", () => {
  it("treats the first sight of a list as history", () => {
    expect([...fresh(undefined, ["a", "b"]).fresh]).toEqual([]);
  });

  it("plays a key once, the render it first appears", () => {
    const first = fresh(undefined, ["a"]);
    const second = fresh(first.memory, ["a", "b"]);
    expect([...second.fresh]).toEqual(["b"]);
    expect([...fresh(second.memory, ["a", "b"]).fresh]).toEqual([]);
  });

  it("does not replay a key that left and came back", () => {
    const first = fresh(undefined, ["a", "b"]);
    const gone = fresh(first.memory, ["a"]);
    expect([...fresh(gone.memory, ["a", "b"]).fresh]).toEqual([]);
  });

  it("treats a large batch as a load, not an arrival", () => {
    const first = fresh(undefined, []);
    expect([...fresh(first.memory, ["a", "b", "c", "d", "e"]).fresh]).toEqual([]);
  });

  it("lets a committed message take over from its stream without a second entrance", () => {
    const handoff = {
      from: (key: string) => key.startsWith("streaming-"),
      to: (key: string) => key.startsWith("identity:"),
    };
    const first = fresh(undefined, ["user:1"], handoff);
    const streaming = fresh(first.memory, ["user:1", "streaming-x"], handoff);
    expect([...streaming.fresh]).toEqual(["streaming-x"]);
    // The stream clears before the message is read back, so they land in separate renders.
    const cleared = fresh(streaming.memory, ["user:1"], handoff);
    const landed = fresh(cleared.memory, ["user:1", "identity:2"], handoff);
    expect([...landed.fresh]).toEqual([]);
    expect([
      ...fresh(landed.memory, ["user:1", "identity:2", "identity:3"], handoff).fresh,
    ]).toEqual(["identity:3"]);
  });
});

describe("moveFrom", () => {
  const box = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    width,
    height,
  });

  it("starts a panel where it was, at the size it was", () => {
    expect(moveFrom(box(100, 50, 300, 200), box(400, 80, 600, 400))).toBe(
      "translate(-300px, -30px) scale(0.5, 0.5)",
    );
  });

  it("has nothing to play when the panel did not move", () => {
    expect(moveFrom(box(10, 10, 200, 100), box(10, 10, 200, 100))).toBeUndefined();
  });

  it("has nothing to play for a box with no size", () => {
    expect(moveFrom(box(10, 10, 200, 100), box(10, 10, 0, 0))).toBeUndefined();
  });
});
