import type { ReactNode } from "react";
import type { SurfaceRegion, SurfaceRole, SurfaceSize } from "@noctis/contracts";
import { corner, glass, material, semantic, spacing, typography } from "../tokens/index.js";

export interface PanelUpdateState {
  updating?: boolean;
  failed?: boolean;
  onRetry?: () => void;
  pendingPrimary?: boolean;
  onUseNewVersion?: () => void;
}
export interface SurfaceFrameProps extends PanelUpdateState {
  surfaceId: string;
  title: string;
  role: SurfaceRole;
  size: SurfaceSize;
  region: SurfaceRegion;
  controls?: ReactNode;
  children: ReactNode;
}
export function SurfaceFrame({
  surfaceId,
  title,
  role,
  size,
  region,
  controls,
  children,
  updating,
  failed,
  onRetry,
  pendingPrimary,
  onUseNewVersion,
}: SurfaceFrameProps): JSX.Element {
  const labelId = `surface-${surfaceId}-title`;
  const actionStyle = {
    minWidth: 44,
    minHeight: 44,
    background: material.fillElevated,
    border: `1px solid ${material.border}`,
    color: typography.color.primary,
    borderRadius: corner.md,
    cursor: "pointer",
  } as const;
  return (
    <section
      aria-labelledby={labelId}
      aria-busy={updating}
      data-surface-id={surfaceId}
      data-surface-role={role}
      data-surface-region={region}
      data-surface-size={size}
      style={{ ...glass, display: "flex", flexDirection: "column", minWidth: 0 }}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: spacing.sm,
          padding: spacing.md,
          borderBottom: `1px solid ${material.border}`,
        }}
      >
        <h2
          id={labelId}
          style={{
            flex: "1 1 120px",
            margin: 0,
            font: `${role === "primary" ? "600" : "500"} ${String(role === "primary" ? typography.scale.lg : typography.scale.sm)}px ${typography.family}`,
            color: typography.color.primary,
          }}
        >
          {title}
        </h2>
        <span
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            overflow: "hidden",
            clipPath: "inset(50%)",
            whiteSpace: "nowrap",
          }}
        >
          {role}
        </span>
        {controls}
      </header>
      {(updating || failed || pendingPrimary) && (
        <div
          role="status"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: spacing.sm,
            padding: spacing.sm,
            color: failed ? semantic.warning : typography.color.muted,
          }}
        >
          {failed ? (
            <>
              Couldn't update
              {onRetry && (
                <button type="button" onClick={onRetry} style={actionStyle}>
                  Retry
                </button>
              )}
            </>
          ) : updating ? (
            "Updating..."
          ) : null}
          {pendingPrimary && (
            <>
              New version ready
              {onUseNewVersion && (
                <button type="button" onClick={onUseNewVersion} style={actionStyle}>
                  Use new version
                </button>
              )}
            </>
          )}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: spacing.md }}>{children}</div>
    </section>
  );
}
