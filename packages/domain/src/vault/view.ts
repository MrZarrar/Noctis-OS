import type { Coordinate } from "./layout.js";

/**
 * The camera over the Vault sphere, and the focus rule that decides what a
 * focused view is allowed to show.
 *
 * Both are pure. Section 7 asks the dedicated view to "preserve pan, zoom,
 * rotation, labels, relationships, and focus isolation" — every one of those is
 * a function of state here, so the behaviour is testable without a renderer and
 * a renderer swap cannot silently change it.
 */

export interface Camera {
  /** Radians. Rotation about the horizontal axis, clamped to keep the sphere upright. */
  pitch: number;
  /** Radians. Rotation about the vertical axis; wraps freely. */
  yaw: number;
  zoom: number;
  panX: number;
  panY: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Projected {
  x: number;
  y: number;
  /** Rotated z. Larger is nearer the viewer; used for draw order and fading. */
  depth: number;
  /** Perspective foreshortening, for dot size and label legibility. */
  scale: number;
}

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 6;
/** Straight up and straight down are the poles; stopping short keeps the sphere upright. */
export const MAX_PITCH = Math.PI / 2 - 0.05;

export const DEFAULT_CAMERA: Camera = { pitch: 0.25, yaw: 0.6, zoom: 1, panX: 0, panY: 0 };

export function clampCamera(camera: Camera): Camera {
  return {
    pitch: Math.min(MAX_PITCH, Math.max(-MAX_PITCH, camera.pitch)),
    // Yaw wraps rather than clamps: spinning the sphere has no end.
    yaw: camera.yaw % (Math.PI * 2),
    zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom)),
    panX: camera.panX,
    panY: camera.panY,
  };
}

/** Perspective distance, in the same units as the layout shell radius. */
const EYE = 42;

/**
 * Rotates a point by the camera and flattens it to the viewport.
 *
 * Yaw first, then pitch, then a perspective divide. The divide is what makes
 * near nodes larger and gives the sphere depth without a 3D renderer; `depth`
 * is returned unflattened so a caller can sort back-to-front and fade the far
 * side rather than drawing a flat disc of overlapping dots.
 */
export function project(point: Coordinate, camera: Camera, viewport: Viewport): Projected {
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const x1 = point.x * cosYaw - point.z * sinYaw;
  const z1 = point.x * sinYaw + point.z * cosYaw;

  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const y2 = point.y * cosPitch - z1 * sinPitch;
  const z2 = point.y * sinPitch + z1 * cosPitch;

  const perspective = EYE / (EYE - z2);
  const scale = perspective * camera.zoom;

  return {
    x: viewport.width / 2 + x1 * scale + camera.panX,
    // Screen y grows downward; the layout's y grows upward.
    y: viewport.height / 2 - y2 * scale + camera.panY,
    depth: z2,
    scale,
  };
}

export interface GraphNode {
  id: string;
}

export interface GraphEdge {
  source: string;
  target: string;
}

/**
 * The subgraph a focused view may show: the focused node and its neighbours out
 * to `depth` hops.
 *
 * Section 7: "focused recall opens only the relevant subgraph, not a miniature
 * full Vault". Returning the whole graph when nothing is focused is the honest
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
