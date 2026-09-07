/**
 * The focus rule: what a focused Vault view is allowed to show.
 *
 * Pure, so Section 7's "focus isolation" is testable without a renderer and a
 * renderer swap cannot silently change what focus means.
 *
 * This module used to also hold a camera — `project`, `clampCamera`, and a
 * perspective divide — for an SVG sphere that stood in until the donor's
 * Three.js view was ported. That renderer is gone, and with it the camera:
 * OrbitControls owns pan, zoom, and rotation now, and keeping a second
 * projection here would be a second way to draw one graph.
 */

export interface GraphEdge {
  source: string;
  target: string;
}

/**
 * The subgraph a focused view may show: the focused node and its neighbours out
 * to `depth` hops.
 *
 * Section 7: "focused recall opens only the relevant subgraph, not a miniature
 * full Vault". Returning `undefined` when nothing is focused is the honest
 * complement — an unfocused Vault view is the whole Vault, deliberately.
 */
export function focusSubgraph(
  edges: readonly GraphEdge[],
  focusId: string | undefined,
  depth = 1,
): Set<string> | undefined {
  if (focusId === undefined) {
    return undefined;
  }

  const adjacency = new Map<string, string[]>();

  for (const edge of edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
    adjacency.set(edge.target, [...(adjacency.get(edge.target) ?? []), edge.source]);
  }

  const visible = new Set<string>([focusId]);
  let frontier = [focusId];

  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = [];

    for (const id of frontier) {
      for (const neighbour of adjacency.get(id) ?? []) {
        if (!visible.has(neighbour)) {
          visible.add(neighbour);
          next.push(neighbour);
        }
      }
    }

    frontier = next;
  }

  return visible;
}
