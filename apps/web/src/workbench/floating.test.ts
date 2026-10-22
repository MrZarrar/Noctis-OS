import { describe, expect, it } from "vitest";
import {
  FloatingPanels,
  floatingSlots,
  type FloatingGroup,
  type FloatingPanel,
} from "./floating.js";
import type { CompositionPlan, SurfaceIntent } from "@noctis/contracts";

const panel = (id: string, at = Number(id)): FloatingPanel => ({
  id,
  title: `Panel ${id}`,
  revision: String(at),
  requestedAt: at,
  pinned: false,
  size: "standard",
  minWidth: 240,
});
const group = (panels: FloatingPanel[], scope = "thread"): FloatingGroup => ({
  scope,
  panels,
  liveIds: panels.map(({ id }) => id),
  windows: {},
  viewport: { width: 2400, height: 1200 },
  floating: true,
});
const visible = (store: FloatingPanels) =>
  store
    .snapshot()
    .filter((entry) => entry.rect !== undefined)
    .map(({ id }) => id);

describe("browser floating panels", () => {
  it("keeps a previously opened panel reachable when the core moves it to overflow", () => {
    const slot = {
      surfaceId: "2",
      region: "right" as const,
      size: "standard" as const,
      order: 0,
      layer: 0,
    };
    const plan = { slots: [slot], overflowSurfaceIds: ["1", "3"] } as CompositionPlan;
    const intents = [1, 2, 3].map((id) => ({
      id: String(id),
      minSize: "compact",
      lifecycle: "active",
    })) as SurfaceIntent[];
    expect(floatingSlots(plan, intents, ["1"])).toEqual([
      slot,
      { surfaceId: "1", region: "right", size: "compact", order: 0, layer: 0 },
    ]);
  });

  it("keeps the cap when a protected pinned panel is unpinned", () => {
    const store = new FloatingPanels();
    const initial = [1, 2, 3, 4].map((id) => panel(String(id)));
    store.sync("owner", group([...initial, { ...panel("5"), pinned: true }]));
    [...initial, panel("5")].forEach(({ id }) => store.touch("thread", id));
    store.sync("owner", group([...initial, panel("5")]));
    expect(visible(store)).toEqual(["1", "2", "3", "4"]);
    expect(store.snapshot().find(({ id }) => id === "5")?.tucked).toBe(true);
  });

  it("marks a hidden primary update even while its displayed revision is retained", () => {
    const store = new FloatingPanels();
    const panels = [1, 2, 3, 4, 5].map((id) => panel(String(id)));
    store.sync("owner", group(panels));
    store.sync(
      "owner",
      group(panels.map((value) => (value.id === "1" ? { ...value, pendingPrimary: true } : value))),
    );
    expect(store.snapshot().find(({ id }) => id === "1")).toMatchObject({
      tucked: true,
      updated: true,
    });
  });
  it("keeps every panel open when the store allows more windows, as LARP mode's storm does", () => {
    const store = new FloatingPanels(undefined, 12);
    store.sync("owner", group([7, 3, 1, 6, 2, 5, 4].map((id) => panel(String(id)))));
    expect(visible(store).sort()).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    const rects = store.snapshot().flatMap(({ rect }) => (rect === undefined ? [] : [rect]));
    expect(new Set(rects.map(({ x, y }) => `${String(x)},${String(y)}`)).size).toBe(7);
  });

  it("tucks the oldest openings after four, regardless of plan order", () => {
    const store = new FloatingPanels();
    store.sync("owner", group([7, 3, 1, 6, 2, 5, 4].map((id) => panel(String(id)))));
    expect(visible(store).sort()).toEqual(["4", "5", "6", "7"]);
    expect(
      store
        .snapshot()
        .filter((entry) => entry.tucked)
        .map(({ id }) => id)
        .sort(),
    ).toEqual(["1", "2", "3"]);
  });

  it("shares the four-panel limit and placement across mounted owners", () => {
    const store = new FloatingPanels();
    store.sync("thread", group([1, 2, 3].map((id) => panel(String(id)))));
    const before = store.snapshot().find(({ id }) => id === "3")?.rect;
    store.sync("objective", group([panel("4"), panel("5")], "objective"));
    expect(visible(store).sort()).toEqual(["2", "3", "4", "5"]);
    const rects = store.snapshot().flatMap(({ rect }) => (rect === undefined ? [] : [rect]));
    expect(new Set(rects.map(({ x, y }) => `${String(x)},${String(y)}`)).size).toBe(4);
    expect(store.snapshot().find(({ id }) => id === "3")?.rect).toEqual(before);
  });

  it("keeps the more control with a floating owner when an earlier owner is focused", () => {
    const store = new FloatingPanels();
    store.sync("thread", group([panel("1")]));
    store.sync(
      "objective",
      group(
        [2, 3, 4, 5, 6].map((id) => panel(String(id))),
        "objective",
      ),
    );
    store.sync("thread", { ...group([panel("1")]), floating: false });
    const floating = store.snapshot().filter((entry) => entry.floating);
    expect(floating[0]?.scope).toBe("objective");
    expect(floating.some((entry) => entry.tucked)).toBe(true);
  });

  it("protects owner-touched panels and excludes pinned panels from the limit", () => {
    const store = new FloatingPanels();
    const initial = [1, 2, 3, 4].map((id) => panel(String(id)));
    store.sync("owner", group(initial));
    store.touch("thread", "1");
    store.sync("owner", group([...initial, { ...panel("5"), pinned: true }, panel("6")]));
    expect(visible(store).sort()).toEqual(["1", "3", "4", "5", "6"]);
    expect(store.snapshot().find(({ id }) => id === "2")?.tucked).toBe(true);
  });

  it("tucks an arriving panel if every open panel is protected", () => {
    const store = new FloatingPanels();
    const initial = [1, 2, 3, 4].map((id) => panel(String(id)));
    store.sync("owner", group(initial));
    initial.forEach(({ id }) => store.touch("thread", id));
    store.sync("owner", group([...initial, panel("5")]));
    expect(visible(store)).toEqual(["1", "2", "3", "4"]);
    expect(store.reopen("thread", "5")).toBe(false);
    expect(visible(store)).toHaveLength(4);
  });

  it("keeps updates tucked and gives a restored panel a fresh opening", () => {
    const store = new FloatingPanels();
    const panels = [1, 2, 3, 4, 5].map((id) => panel(String(id)));
    store.sync("owner", group(panels));
    const openAt = store.snapshot().find(({ id }) => id === "1")?.openedAt;
    store.sync(
      "owner",
      group(
        panels.map((value) =>
          value.id === "1" ? { ...value, revision: "updated", requestedAt: 20 } : value,
        ),
      ),
    );
    expect(store.snapshot().find(({ id }) => id === "1")).toMatchObject({
      tucked: true,
      updated: true,
      openedAt: openAt,
    });
    expect(store.reopen("thread", "1")).toBe(true);
    expect(visible(store).sort()).toEqual(["1", "3", "4", "5"]);
    expect(store.snapshot().find(({ id }) => id === "1")).toMatchObject({
      tucked: false,
      updated: false,
    });
    expect(store.snapshot().find(({ id }) => id === "1")?.openedAt).toBeGreaterThan(5);
  });

  it("persists hiding, interaction and update marks per browser and scope", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const first = new FloatingPanels(() => storage);
    const panels = [1, 2, 3, 4, 5].map((id) => panel(String(id)));
    first.sync("owner", group(panels));
    first.touch("thread", "2");
    const restored = new FloatingPanels(() => storage);
    restored.sync(
      "owner",
      group(panels.map((value) => (value.id === "1" ? { ...value, revision: "new" } : value))),
    );
    expect(restored.snapshot().find(({ id }) => id === "1")).toMatchObject({
      tucked: true,
      updated: true,
    });
    restored.sync("owner", group([...panels, panel("6")]));
    expect(visible(restored).sort()).toEqual(["2", "4", "5", "6"]);
    restored.sync("owner", group([panel("1")], "other-thread"));
    expect(visible(restored)).toEqual(["1"]);
  });

  it("leaves mobile and focused layouts alone and frees departed owners", () => {
    const store = new FloatingPanels();
    const panels = [1, 2, 3, 4, 5].map((id) => panel(String(id)));
    store.sync("phone", { ...group(panels), floating: false });
    expect(store.snapshot()).toEqual([]);
    store.sync("phone", group(panels));
    store.remove("phone");
    expect(visible(store)).toEqual([]);
    store.sync("other", group([panel("6")], "other"));
    expect(visible(store)).toEqual(["6"]);
  });

  it("validates storage, tolerates disabled storage and keeps stable snapshots", () => {
    const store = new FloatingPanels(() => ({
      getItem: () => '{"bad":true}',
      setItem: () => {
        throw new Error("blocked");
      },
    }));
    store.sync("owner", group([panel("1")]));
    const snapshot = store.snapshot();
    store.sync("owner", group([panel("1")]));
    expect(store.snapshot()).toBe(snapshot);
    expect(visible(store)).toEqual(["1"]);
  });

  it("does not reuse an occupied saved spot on first opening or reopening", () => {
    const store = new FloatingPanels();
    const saved = { x: 1900, y: 72, w: 460, h: 560 };
    const input = { ...group([panel("1"), panel("2")]), windows: { "1": saved, "2": saved } };
    store.sync("owner", input);
    const first = store.snapshot().find(({ id }) => id === "1")?.rect;
    const second = store.snapshot().find(({ id }) => id === "2")?.rect;
    expect(first).toEqual(saved);
    expect(second).not.toEqual(saved);
    store.sync("owner", input);
    expect(store.snapshot().find(({ id }) => id === "2")?.rect).toEqual(second);
    store.sync("owner", {
      ...input,
      panels: [...input.panels, panel("3"), panel("4"), panel("5")],
    });
    expect(store.reopen("thread", "1")).toBe(true);
    expect(visible(store)).toHaveLength(4);
  });

  it("keeps the original size when a viewport shrinks and grows", () => {
    const store = new FloatingPanels();
    const saved = { x: 1400, y: 72, w: 800, h: 900 };
    const input = { ...group([panel("1")]), windows: { "1": saved } };
    store.sync("owner", input);
    store.sync("owner", { ...input, viewport: { width: 800, height: 700 } });
    expect(store.snapshot()[0]?.rect?.h).toBe(700);
    expect(store.snapshot()[0]?.geometry).toEqual(saved);
    store.sync("owner", input);
    expect(store.snapshot()[0]?.rect).toEqual(saved);
  });

  it("keeps hidden entries through focus layouts and drops dismissed entries", () => {
    const store = new FloatingPanels();
    const input = group([1, 2, 3, 4, 5].map((id) => panel(String(id))));
    store.sync("owner", input);
    store.sync("owner", { ...input, floating: false });
    expect(visible(store)).toEqual([]);
    expect(store.snapshot().find(({ id }) => id === "1")?.tucked).toBe(true);
    store.sync("owner", { ...input, liveIds: ["2", "3", "4", "5"], panels: input.panels.slice(1) });
    expect(store.snapshot().some(({ id }) => id === "1")).toBe(false);
    expect(visible(store)).toHaveLength(4);
  });
});
