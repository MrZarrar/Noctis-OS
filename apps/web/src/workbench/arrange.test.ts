import { describe, expect, it } from "vitest";
import {
  defaultRect,
  fitRect,
  geometryKey,
  openingRect,
  presetRect,
  readWindows,
  resizeRect,
  stackOpened,
  writeWindows,
  type WindowRect,
} from "./arrange.js";

const viewport = { width: 1600, height: 900 };

describe("floating panel windows", () => {
  it("uses a saved position only when its fitted rectangle is free", () => {
    const saved = { x: 1100, y: 72, w: 460, h: 560 };
    expect(openingRect("standard", saved, [], viewport, 240)).toEqual(saved);
    expect(openingRect("standard", saved, [saved], viewport, 240)).toEqual(
      defaultRect("standard", [saved], viewport),
    );
    const offscreen = { ...saved, x: 3000 };
    const fitted = fitRect(offscreen, viewport, 240);
    expect(openingRect("standard", offscreen, [fitted], viewport, 240)).not.toEqual(fitted);
  });
  it("opens new panels side by side from the right, clear of every open window", () => {
    const overlaps = (a: WindowRect, b: WindowRect): boolean =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const first = defaultRect("standard", [], viewport);
    const second = defaultRect("standard", [first], viewport);
    expect(first.x + first.w).toBeLessThanOrEqual(viewport.width);
    expect(first.x).toBeGreaterThan(viewport.width / 2);
    expect(second.x + second.w).toBeLessThan(first.x);
    expect(overlaps(first, second)).toBe(false);
    const moved = { x: 1000, y: 60, w: 300, h: 300 };
    expect(overlaps(defaultRect("standard", [moved], viewport), moved)).toBe(false);
    expect(defaultRect("wide", [], viewport).w).toBeGreaterThan(first.w);
  });
  it("cascades once the row is full, so a new panel never lands exactly on another", () => {
    const small = { width: 800, height: 700 };
    const first = defaultRect("standard", [], small);
    const second = defaultRect("standard", [first], small);
    expect(second.x + second.w).toBeLessThanOrEqual(small.width);
    expect([second.x, second.y]).not.toEqual([first.x, first.y]);
  });
  it("keeps a window reachable on a smaller screen without losing its stored size", () => {
    const stored = { x: 1500, y: 880, w: 640, h: 600 };
    const fitted = fitRect(stored, { width: 800, height: 600 }, 240);
    expect(fitted.x + fitted.w).toBeLessThanOrEqual(800);
    expect(fitted.y + 48).toBeLessThanOrEqual(600);
    expect(fitted.h).toBeLessThanOrEqual(600);
    expect(fitRect({ x: -50, y: -20, w: 100, h: 100 }, viewport, 240)).toEqual({
      x: 0,
      y: 0,
      w: 240,
      h: 160,
    });
  });
  it("resizes from any edge, never below the kind's minimum, keeping the opposite edge still", () => {
    const rect = { x: 400, y: 200, w: 400, h: 400 };
    expect(resizeRect(rect, "se", 50, 30, 240)).toEqual({ x: 400, y: 200, w: 450, h: 430 });
    expect(resizeRect(rect, "nw", 50, 30, 240)).toEqual({ x: 450, y: 230, w: 350, h: 370 });
    expect(resizeRect(rect, "w", 300, 0, 240)).toEqual({ x: 560, y: 200, w: 240, h: 400 });
    expect(resizeRect(rect, "n", 0, 500, 240)).toEqual({ x: 400, y: 440, w: 400, h: 160 });
    expect(resizeRect(rect, "e", -500, 99, 240)).toEqual({ x: 400, y: 200, w: 240, h: 400 });
  });
  it("applies a size preset in place and keeps it on screen", () => {
    const rect = { x: 1200, y: 100, w: 340, h: 440 };
    const large = presetRect(rect, "wide", viewport, 240);
    expect(large.w).toBe(defaultRect("wide", [], viewport).w);
    expect(large.x + large.w).toBeLessThanOrEqual(viewport.width);
    expect(large.y).toBe(100);
  });
  it("rejects corrupt storage, separates owners and reports a refused save", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const key = geometryKey("client", "1920x1080@1", "thread:a");
    const windows = { detail: { x: 10, y: 20, w: 300, h: 400 } };
    expect(writeWindows(storage, key, windows)).toBe(true);
    expect(readWindows(storage, key)).toEqual(windows);
    expect(readWindows(storage, geometryKey("client", "1920x1080@1", "thread:b"))).toBeUndefined();
    values.set(key, '{"columns":{"centre":0.5},"bottom":0.3}');
    expect(readWindows(storage, key)).toBeUndefined();
    values.set(key, '{"detail":{"x":0,"y":0,"w":-1,"h":5}}');
    expect(readWindows(storage, key)).toBeUndefined();
    expect(
      writeWindows(
        {
          setItem: () => {
            throw new Error("blocked");
          },
        },
        key,
        windows,
      ),
    ).toBe(false);
  });
});

describe("stacking newly opened windows", () => {
  it("puts a newly opened window on top of every window already open", () => {
    expect(stackOpened(["a", "b"], new Map(), [{ id: "c", at: "2026-10-16T10:00:00Z" }])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps the newest window highest when an older one is announced after it", () => {
    const openedAt = new Map([["new", "2026-10-16T10:00:02Z"]]);
    expect(
      stackOpened(["a", "new"], openedAt, [{ id: "old", at: "2026-10-16T10:00:01Z" }]),
    ).toEqual(["a", "old", "new"]);
  });

  it("does not hold back a window behind one the owner has since raised", () => {
    // `a` was opened later but clicked since, so it no longer carries an opened time.
    expect(stackOpened(["a"], new Map(), [{ id: "b", at: "2026-10-16T10:00:00Z" }])).toEqual([
      "a",
      "b",
    ]);
  });
});
