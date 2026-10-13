import { createElement, useLayoutEffect } from "react";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CompanionCore, type CompanionCoreProps } from "./CompanionCore.js";

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useEffect: vi.fn(),
  useLayoutEffect: vi.fn(),
  useRef: () => ({ current: undefined }),
  useState: (initial: unknown) => [
    initial === undefined ? { at: "corner", x: 0, y: 0, width: 96, height: 96 } : initial,
    vi.fn(),
  ],
}));

const props: CompanionCoreProps = {
  page: "Threads",
  identityId: "vesper",
  protocolIds: [],
  conversation: { messages: [], turns: [], streaming: new Map(), pendingApprovals: [] },
  listening: false,
  mobile: false,
  onOpenThreads: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

it("labels a missing Threads slot as a return to the conversation", () => {
  const label = (page: CompanionCoreProps["page"]): string | undefined =>
    renderToStaticMarkup(createElement(CompanionCore, { ...props, page })).match(
      /<button[^>]*aria-label="([^"]+)"/,
    )?.[1];
  expect(label("Threads")).toBe("Back to the conversation");
  expect(label("Files")).toBe("Open Threads");
});

it("removes the document's clearance when the core unmounts", () => {
  const properties = new Map<string, string>();
  vi.stubGlobal("document", {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    },
  });
  renderToStaticMarkup(createElement(CompanionCore, props));
  const effect = vi.mocked(useLayoutEffect).mock.calls[1]?.[0];
  const cleanup = effect?.();
  expect(properties.get("--noctis-core-clearance")).toBe("120px");
  if (typeof cleanup === "function") cleanup();
  expect(properties.has("--noctis-core-clearance")).toBe(false);
});

it("measures the first drawn ordered slot, then the composer and corner fallbacks", () => {
  const observe = vi.fn();
  class Observer {
    observe = observe;
    disconnect = vi.fn();
  }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("removeEventListener", vi.fn());
  const slot = (name: string, drawn: boolean) => ({
    dataset: { coreSlot: name },
    parentElement: null,
    getClientRects: () => (drawn ? [{}] : []),
    getBoundingClientRect: () => ({ x: 1, y: 2, width: 76, height: 76 }),
  });
  for (const available of ["companion", "composer", "corner"]) {
    vi.mocked(useLayoutEffect).mockClear();
    observe.mockClear();
    const slots = ["companion", "composer", "corner"].map((name) =>
      slot(name, name === available || name === "corner"),
    );
    vi.stubGlobal("document", {
      body: {},
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      querySelectorAll: (selector: string) =>
        slots.filter((node) => selector.includes(`"${node.dataset.coreSlot}"`)),
    });
    renderToStaticMarkup(createElement(CompanionCore, props));
    const cleanup = vi.mocked(useLayoutEffect).mock.calls[0]?.[0]();
    const observed = observe.mock.calls[0]?.[0] as ReturnType<typeof slot> | undefined;
    expect(observed?.dataset.coreSlot).toBe(available);
    if (typeof cleanup === "function") cleanup();
  }
});
