import { createElement } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { CompositionState } from "./useComposition.js";
import { Workbench, panelTitle } from "./Workbench.js";
import { floatingPanels } from "./floating.js";

const effects = vi.hoisted(() => ({
  layout: [] as (() => unknown)[],
  passive: [] as (() => unknown)[],
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useId: () => "owner",
  useLayoutEffect: (effect: () => unknown) => effects.layout.push(effect),
  useEffect: (effect: () => unknown) => effects.passive.push(effect),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

afterEach(() => {
  floatingPanels.remove("owner");
  effects.layout.length = 0;
  effects.passive.length = 0;
  vi.unstubAllGlobals();
});

it("does not save stale geometry after the layout effect acknowledges an owner move", () => {
  const initial = { x: 1100, y: 72, w: 460, h: 560 };
  const moved = { ...initial, x: 900 };
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("window", {
    innerWidth: 1600,
    innerHeight: 900,
    localStorage: storage,
    addEventListener() {},
    removeEventListener() {},
  });
  const intent = {
    id: "panel",
    threadId: "thread",
    kind: "document",
    role: "supporting" as const,
    persistence: "ephemeral" as const,
    lifecycle: "active" as const,
    priority: 0,
    minSize: "standard" as const,
    sourceIds: [],
    artifactIds: [],
    payloadVersion: 1,
    payload: {
      title: "Build script",
      format: "text",
      content: { from: "inline", text: "build" },
      actions: [],
    },
    requestedAt: "2026-10-16T10:00:00Z",
  };
  floatingPanels.sync("owner", {
    scope: "geometry-effect",
    panels: [
      {
        id: intent.id,
        title: "Build script",
        revision: intent.requestedAt,
        requestedAt: Date.parse(intent.requestedAt),
        pinned: false,
        size: "standard",
        minWidth: 300,
      },
    ],
    liveIds: [intent.id],
    windows: { panel: initial },
    viewport: { width: 1600, height: 900 },
    floating: true,
  });
  storage.setItem("geometry-effect", JSON.stringify({ panel: moved }));
  const composition: CompositionState = {
    geometryScope: "geometry-effect",
    intents: [intent],
    overrides: [],
    focusedSurfaceId: undefined,
    attentionState: "active_canvas",
    error: undefined,
    plan: {
      threadId: "thread",
      layoutId: "canvas.split",
      displayFingerprint: "screen",
      slots: [{ surfaceId: intent.id, region: "right", size: "standard", order: 0, layer: 0 }],
      overflowSurfaceIds: [],
      reasonCodes: [],
      generatedAt: intent.requestedAt,
    },
    focus() {},
    move: () => Promise.resolve(true),
    release: async () => {},
    dismiss: async () => {},
    restore: () => Promise.resolve(true),
    refresh() {},
  };
  renderToStaticMarkup(createElement(Workbench, { composition }));
  effects.layout.forEach((effect) => effect());
  expect(floatingPanels.snapshot()[0]?.geometry).toEqual(moved);
  effects.passive.forEach((effect) => effect());
  expect(JSON.parse(storage.getItem("geometry-effect") ?? "null")).toEqual({ panel: moved });
});

it("names a panel by its own title, and by its kind only when it cannot render", () => {
  expect(
    panelTitle({
      kind: "document",
      payloadVersion: 1,
      minSize: "compact",
      payload: {
        title: "The Dreamer - draft A",
        format: "markdown",
        content: { from: "inline", text: "Verse one" },
      },
    }),
  ).toBe("The Dreamer - draft A");
  expect(
    panelTitle({ kind: "no_such_kind", payloadVersion: 1, minSize: "compact", payload: {} }),
  ).toBe("no_such_kind");
});
