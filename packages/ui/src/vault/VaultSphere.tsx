import type { VaultEntityType } from "@noctis/contracts";
import type { Camera, Viewport } from "@noctis/domain";
import { DEFAULT_CAMERA, clampCamera, focusSubgraph, project } from "@noctis/domain";
import { useMemo, useState } from "react";

import {
  corner,
  depth as depthTokens,
  identityAccent,
  material,
  semantic,
  spacing,
  typography,
} from "../tokens/index.js";

/**
 * The dedicated Vault view.
 *
 * SVG over projected coordinates rather than Three.js: the donor's sphere is
 * `REPLACE` in the Section 13.1 matrix, the cinematic renderer is still the
 * deferred pass Phase 5 named, and every behaviour Section 7 actually requires
 * — pan, zoom, rotation, labels, relationships, focus isolation — is a
 * function of the camera and the focus, both of which live in `@noctis/domain`
 * and are tested there. Swapping in a canvas renderer later changes what this
 * draws, not what it means.
 *
 * Coordinates arrive already settled from `vault_layout`. Nothing here moves a
 * node, so the view cannot reintroduce the wandering Section 7 asks to remove.
 */

export interface VaultSphereNode {
  id: string;
  name: string;
  type: VaultEntityType;
  /** Absent while an entity has no persisted coordinate yet. */
  x?: number;
  y?: number;
  z?: number;
  /** Notes have one; a linked-but-unwritten target does not. */
  path?: string | null;
}

export interface VaultSphereEdge {
  id: string;
  source: string;
  target: string;
  lifecycle: "resolved" | "unresolved";
}

export interface VaultSphereProps {
  nodes: readonly VaultSphereNode[];
  edges: readonly VaultSphereEdge[];
  focusId?: string;
  onFocus?: (id: string | undefined) => void;
  /** "Open in Vault" arrives here with the note to open. */
  onOpen?: (node: VaultSphereNode) => void;
  viewport?: Viewport;
}

const TYPE_COLOUR: Readonly<Record<VaultEntityType, string>> = {
  person: identityAccent.vesper.primary,
  project: semantic.success,
  reference: semantic.approval,
  daily: semantic.warning,
  capture: identityAccent.jester.primary,
  agent: identityAccent.noir.structure,
  note: typography.color.muted,
};

const ROTATE_STEP = Math.PI / 12;
const ZOOM_STEP = 1.25;
const PAN_STEP = 40;

export function VaultSphere({
  nodes,
  edges,
  focusId,
  onFocus,
  onOpen,
  viewport = { width: 880, height: 560 },
}: VaultSphereProps): JSX.Element {
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);

  const move = (patch: Partial<Camera>): void => {
    setCamera((current) => clampCamera({ ...current, ...patch }));
  };

  const visible = useMemo(() => focusSubgraph(edges, focusId), [edges, focusId]);

  const placed = useMemo(
    () =>
      nodes
        .filter((node) => node.x !== undefined && node.y !== undefined && node.z !== undefined)
        .filter((node) => visible === undefined || visible.has(node.id))
        .map((node) => ({
          node,
          projected: project({ x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 }, camera, viewport),
        }))
        // Back to front, so the near side of the sphere draws over the far side
        // instead of the two interleaving.
        .sort((a, b) => a.projected.depth - b.projected.depth),
    [nodes, camera, viewport, visible],
  );

  const positions = new Map(placed.map((entry) => [entry.node.id, entry.projected]));

  return (
    <div style={{ display: "grid", gap: spacing.sm }}>
      <div
        role="group"
        aria-label="Vault view controls"
        style={{ display: "flex", gap: spacing.xs }}
      >
        <Control
          label="Rotate left"
          onAct={() => {
            move({ yaw: camera.yaw - ROTATE_STEP });
          }}
        />
        <Control
          label="Rotate right"
          onAct={() => {
            move({ yaw: camera.yaw + ROTATE_STEP });
          }}
        />
        <Control
          label="Tilt up"
          onAct={() => {
            move({ pitch: camera.pitch + ROTATE_STEP });
          }}
        />
        <Control
          label="Tilt down"
          onAct={() => {
            move({ pitch: camera.pitch - ROTATE_STEP });
          }}
        />
        <Control
          label="Zoom in"
          onAct={() => {
            move({ zoom: camera.zoom * ZOOM_STEP });
          }}
        />
        <Control
          label="Zoom out"
          onAct={() => {
            move({ zoom: camera.zoom / ZOOM_STEP });
          }}
        />
        <Control
          label="Reset view"
          onAct={() => {
            setCamera(DEFAULT_CAMERA);
          }}
        />
        {focusId !== undefined && (
          <Control
            label="Clear focus"
            onAct={() => {
              onFocus?.(undefined);
            }}
          />
        )}
      </div>

      <svg
        width={viewport.width}
        height={viewport.height}
        role="group"
        aria-label={
          focusId === undefined
            ? `Vault sphere, ${String(placed.length)} nodes`
            : `Vault sphere focused on one node and its neighbours, ${String(placed.length)} nodes`
        }
        tabIndex={0}
        // Arrow keys pan the sphere once the canvas has focus. Every control is
        // also a button above, so this is a convenience rather than the only way in.
        onKeyDown={(event) => {
          const pan: Record<string, Partial<Camera>> = {
            ArrowLeft: { panX: camera.panX - PAN_STEP },
            ArrowRight: { panX: camera.panX + PAN_STEP },
            ArrowUp: { panY: camera.panY - PAN_STEP },
            ArrowDown: { panY: camera.panY + PAN_STEP },
          };

          const patch = pan[event.key];

          if (patch !== undefined) {
            event.preventDefault();
            move(patch);
          }
        }}
        style={{
          background: depthTokens.layers[0],
          border: `1px solid ${material.border}`,
          borderRadius: corner.lg,
        }}
      >
        {edges
          .filter(
            (edge) =>
              positions.has(edge.source) &&
              positions.has(edge.target) &&
              (visible === undefined || (visible.has(edge.source) && visible.has(edge.target))),
          )
          .map((edge) => {
            const from = positions.get(edge.source);
            const to = positions.get(edge.target);

            return from === undefined || to === undefined ? null : (
              <line
                key={edge.id}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={material.border}
                strokeWidth={1}
                // A link to an unwritten note is drawn as a dashed line as well
                // as reported in its label: colour is never the only carrier.
                strokeDasharray={edge.lifecycle === "unresolved" ? "4 4" : undefined}
              />
            );
          })}

        {placed.map(({ node, projected }) => {
          const isFocus = node.id === focusId;
          const radius = Math.max(3, 5 * projected.scale);

          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={`${node.name}, ${node.type}${node.path == null ? ", not written yet" : ""}`}
              aria-pressed={isFocus}
              onClick={() => {
                onFocus?.(isFocus ? undefined : node.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onFocus?.(isFocus ? undefined : node.id);
                }

                if (event.key === "o" && node.path != null) {
                  onOpen?.(node);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              <circle
                cx={projected.x}
                cy={projected.y}
                r={radius}
                fill={TYPE_COLOUR[node.type]}
                // The far side of the sphere fades rather than disappearing, so
                // the shape reads as a sphere and not a disc.
                fillOpacity={isFocus ? 1 : 0.35 + 0.5 * projected.scale}
                stroke={isFocus ? typography.color.primary : "none"}
                strokeWidth={2}
              />
              <text
                x={projected.x + radius + 4}
                y={projected.y + 4}
                fill={isFocus ? typography.color.primary : typography.color.muted}
                style={{
                  font: `${String(typography.scale.xs)}px ${typography.family}`,
                  pointerEvents: "none",
                }}
              >
                {node.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface ControlProps {
  label: string;
  onAct: () => void;
}

function Control({ label, onAct }: ControlProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onAct}
      style={{
        font: `${String(typography.scale.xs)}px ${typography.family}`,
        background: material.fill,
        color: "inherit",
        border: `1px solid ${material.border}`,
        borderRadius: corner.sm,
        padding: `${String(spacing.xs)}px ${String(spacing.sm)}px`,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
