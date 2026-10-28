export interface TuckedPanel {
  scope: string;
  id: string;
  title: string;
  updated: boolean;
}
export interface MorePanelsProps {
  panels: readonly TuckedPanel[];
  onShow: (panel: TuckedPanel) => void | Promise<void>;
}
export function MorePanels({ panels, onShow }: MorePanelsProps): JSX.Element | null {
  if (panels.length === 0) return null;
  return (
    <details
      data-tucked-panels
      style={{
        position: "fixed",
        right: spacing.lg,
        bottom: `calc(${String(spacing.lg)}px + var(--noctis-core-clearance, 0px))`,
        zIndex: elevation.overlay + 18,
        maxWidth: "min(360px, calc(100vw - 48px))",
        maxHeight: "60vh",
        overflowY: "auto",
        background: depth.layers[1],
        color: typography.color.primary,
        border: `1px solid ${material.border}`,
        borderRadius: corner.md,
        boxShadow: `0 18px 48px -12px ${material.shadow}`,
      }}
    >
      <summary
        style={{
          ...buttonStyle,
          display: "flex",
          alignItems: "center",
          background: depth.layers[1],
        }}
      >
        Panels ({panels.length} hidden or closed)
      </summary>
      <ul style={{ listStyle: "none", margin: 0, padding: spacing.sm }}>
        {panels.map((panel) => (
          <li
            key={JSON.stringify([panel.scope, panel.id])}
            style={{ display: "flex", alignItems: "center", gap: spacing.sm, padding: spacing.xs }}
          >
            <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{panel.title}</span>
            {panel.updated && <small style={{ color: typography.color.muted }}>Updated</small>}
            <ActionButton
              type="button"
              aria-label={`Show ${panel.title}`}
              style={buttonStyle}
              onAction={() => onShow(panel)}
              pendingLabel="Showing..."
            >
              Show
            </ActionButton>
          </li>
        ))}
      </ul>
    </details>
  );
}
import { corner, depth, elevation, material, spacing, typography } from "@noctis/ui";
import { buttonStyle } from "../layout/Page.js";
import { ActionButton } from "../layout/ActionButton.js";
