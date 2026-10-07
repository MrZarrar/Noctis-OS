import {
  corner,
  depth,
  elevation,
  identityAccent,
  material,
  spacing,
  typography,
} from "../tokens/index.js";
import { NavIcon, NoctisMark } from "./icons.js";
import type { RailItem } from "./rail-items.js";
import { railItems } from "./rail-items.js";

export interface RailProps {
  active: RailItem;
  onSelect: (item: RailItem) => void;
  /** Offers the pages kept behind the all-pages flag as well. */
  allPages?: boolean;
}

/**
 * The navigation where there is width for a column. Plain `<button>` elements:
 * a native button already gives Tab order, Enter/Space activation, and a
 * visible focus ring, which is the "keyboard navigation, visible focus"
 * requirement in Section 5.2 without any hand-rolled key handling.
 */
export function Rail({ active, onSelect, allPages = false }: RailProps): JSX.Element {
  const item = (name: RailItem): JSX.Element => {
    const isActive = name === active;

    return (
      <button
        key={name}
        type="button"
        aria-current={isActive ? "page" : undefined}
        onClick={() => {
          onSelect(name);
        }}
        style={{
          position: "relative",
          display: "grid",
          justifyItems: "center",
          gap: spacing.xs,
          minHeight: 56,
          font: `${String(typography.scale.xs)}px ${typography.family}`,
          letterSpacing: typography.tracking.wide,
          color: isActive ? identityAccent.vesper.primary : typography.color.muted,
          background: isActive ? material.fillElevated : "transparent",
          border: "none",
          borderRadius: corner.md,
          padding: `${String(spacing.sm)}px ${String(spacing.xs)}px`,
          cursor: "pointer",
          // The lit edge is the one place the rail spends any glow, so the eye
          // finds where it is without the column turning into a light strip.
          boxShadow: isActive
            ? `inset 2px 0 0 ${identityAccent.vesper.primary}, -6px 0 14px -6px ${identityAccent.vesper.primary}`
            : "none",
        }}
      >
        <NavIcon item={name} />
        {name}
      </button>
    );
  };

  return (
    <nav
      aria-label="Primary"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: spacing.xs,
        width: 84,
        flexShrink: 0,
        boxSizing: "border-box",
        padding: spacing.sm,
        background: `linear-gradient(180deg, ${depth.layers[0]}, ${depth.floor})`,
        borderRight: `1px solid ${material.border}`,
        zIndex: elevation.rail,
      }}
    >
      <div style={{ display: "grid", placeItems: "center", height: 56, marginBottom: spacing.md }}>
        <NoctisMark size={30} />
      </div>
      {railItems(allPages).map(item)}
      <span style={{ flex: 1 }} />
      {item("Settings")}
    </nav>
  );
}
