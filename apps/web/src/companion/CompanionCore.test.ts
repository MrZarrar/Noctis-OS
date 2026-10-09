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
