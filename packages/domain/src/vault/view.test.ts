import { describe, expect, it } from "vitest";

import { focusSubgraph } from "./view.js";

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
