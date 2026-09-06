import type { ReactNode } from "react";

import type { SurfaceRegion, SurfaceRole, SurfaceSize } from "@noctis/contracts";

import { corner, depth, material, motion, spacing, typography } from "../tokens/index.js";

const REGIONS: readonly SurfaceRegion[] = ["left", "centre", "right", "bottom", "overlay"];

const REGION_LABEL: Readonly<Record<SurfaceRegion, string>> = {
  left: "Context (left)",
  centre: "Primary (centre)",
  right: "Supporting (right)",
  bottom: "Control (bottom)",
  overlay: "Attention (overlay)",
};

export interface SurfaceFrameProps {
  surfaceId: string;
  title: string;
  role: SurfaceRole;
  size: SurfaceSize;
  region: SurfaceRegion;
  /** True when the user has placed this Surface here rather than the compositor. */
  overridden?: boolean;
  onMove?: (region: SurfaceRegion) => void;
  onRelease?: () => void;
  onDismiss?: () => void;
  children: ReactNode;
}

/**
 * The chrome every Surface wears: what it is, where it is, and the two things a
 * user may do to it.
 *
 * Arrange is a native `<select>` and dismiss is a native `<button>`, which is
 * the whole of the keyboard story — Tab order, Enter/Space, arrow-key option
 * selection, and a visible focus ring all arrive without a key handler. A
 * hand-rolled drag affordance would have had to reimplement every one of them,
 * and would still have left a keyboard-only user unable to arrange anything.
 */
export function SurfaceFrame({
  surfaceId,
  title,
  role,
  size,
  region,
  overridden = false,
  onMove,
  onRelease,
  onDismiss,
  children,
}: SurfaceFrameProps): JSX.Element {
  const labelId = `surface-${surfaceId}-title`;

  return (
    <section
      aria-labelledby={labelId}
      data-surface-size={size}
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        background: depth.layers[1],
        border: `1px solid ${material.border}`,
        borderRadius: corner.lg,
        boxShadow: `0 ${String(spacing.sm)}px ${String(spacing.xl)}px ${material.shadow}`,
        transition: `box-shadow ${String(motion.durationMs.fast)}ms ${motion.easing.standard}`,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.sm,
          padding: `${String(spacing.sm)}px ${String(spacing.md)}px`,
          borderBottom: `1px solid ${material.border}`,
        }}
      >
        <h2
          id={labelId}
          style={{
            flex: 1,
            margin: 0,
            font: `${String(typography.scale.sm)}px ${typography.family}`,
            letterSpacing: typography.tracking.wide,
          }}
        >
          {title}
        </h2>

        {/* The role is spelled out, never carried by colour alone. */}
        <span
          style={{
            font: `${String(typography.scale.xs)}px ${typography.family}`,
            color: typography.color.muted,
          }}
        >
          {role}
        </span>

        {onMove !== undefined && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.xs,
              font: `${String(typography.scale.xs)}px ${typography.family}`,
            }}
          >
            <span>Place</span>
            <select
              aria-label={`Place ${title}`}
              value={region}
              onChange={(event) => {
                onMove(event.target.value as SurfaceRegion);
              }}
              style={{
                background: material.fill,
                color: "inherit",
                border: `1px solid ${material.border}`,
                borderRadius: corner.sm,
                padding: spacing.xs,
              }}
            >
              {REGIONS.map((option) => (
                <option key={option} value={option}>
                  {REGION_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
        )}

        {overridden && onRelease !== undefined && (
          <button
            type="button"
            onClick={onRelease}
            style={{
              font: `${String(typography.scale.xs)}px ${typography.family}`,
              background: "transparent",
              color: "inherit",
              border: `1px solid ${material.border}`,
              borderRadius: corner.sm,
              padding: `${String(spacing.xs)}px ${String(spacing.sm)}px`,
              cursor: "pointer",
            }}
          >
            Release placement
          </button>
        )}

        {onDismiss !== undefined && (
          <button
            type="button"
            aria-label={`Dismiss ${title}`}
            onClick={onDismiss}
            style={{
              font: `${String(typography.scale.xs)}px ${typography.family}`,
              background: "transparent",
              color: "inherit",
              border: `1px solid ${material.border}`,
              borderRadius: corner.sm,
              padding: `${String(spacing.xs)}px ${String(spacing.sm)}px`,
              cursor: "pointer",
            }}
          >
            Dismiss
          </button>
        )}
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: spacing.md }}>{children}</div>
    </section>
  );
}
