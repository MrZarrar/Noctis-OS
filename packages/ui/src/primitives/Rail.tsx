import {
  corner,
  depth,
  elevation,
  identityAccent,
  material,
  spacing,
  typography,
} from "../tokens/index.js";
import { motion } from "motion/react";

import { NavIcon, NoctisMark } from "./icons.js";
import type { RailItem } from "./rail-items.js";
import { railItems } from "./rail-items.js";
import { counted } from "./TabBar.js";

export interface RailProps {
  active: RailItem;
  onSelect: (item: RailItem) => void;
  /** Offers the pages kept behind the all-pages flag as well. */
  allPages?: boolean;
  /** How many things wait behind a destination: Approvals' count. */
  counts?: Partial<Record<RailItem, number>>;
}

/**
 * The navigation where there is width for a column. Plain `<button>` elements:
 * a native button already gives Tab order, Enter/Space activation, and a
 * visible focus ring, which is the "keyboard navigation, visible focus"
 * requirement in Section 5.2 without any hand-rolled key handling.
 */
export function Rail({ active, onSelect, allPages = false, counts }: RailProps): JSX.Element {
  const item = (name: RailItem): JSX.Element => {
    const isActive = name === active;
    const { props, badge } = counted(name, counts?.[name]);

    return (
      <button
        key={name}
        type="button"
        aria-current={isActive ? "page" : undefined}
        {...props}
        onClick={() => {
          onSelect(name);
        }}
        style={{
          position: "relative",
          display: "grid",
          justifyItems: "center",
          gap: spacing.xs,
          minHeight: 56,
          minWidth: 0,
          flexShrink: 0,
          font: `${String(typography.scale.xs)}px ${typography.family}`,
          letterSpacing: typography.tracking.wide,
          color: isActive ? identityAccent.vesper.primary : typography.color.muted,
          background: "transparent",
          // The marker sits behind the icon and label without leaving the button.
          isolation: "isolate",
          border: "none",
          borderRadius: corner.md,
          // No side padding: the column is narrow, and "Reminders" needs all of it.
          padding: `${String(spacing.sm)}px 0`,
          cursor: "pointer",
        }}
      >
        {isActive && (
          // One marker that travels to the page chosen, rather than one lighting
          // up as another goes dark.
          <motion.span
            layoutId="noctis-rail-current"
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              zIndex: -1,
              borderRadius: corner.md,
              background: material.fillElevated,
              // The lit edge is the one place the rail spends any glow, so the eye
              // finds where it is without the column turning into a light strip.
              boxShadow: `inset 2px 0 0 ${identityAccent.vesper.primary}, -6px 0 14px -6px ${identityAccent.vesper.primary}`,
            }}
          />
        )}
        <NavIcon item={name} />
        <span
          style={{
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
        {badge}
      </button>
    );
  };

  return (
    <nav
      aria-label="Primary"
      style={{
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        // Sideways scroll, or a scrollbar taking room from the column, both push
        // the icons off centre. The column still scrolls; it shows no bar.
        overflowX: "hidden",
        scrollbarWidth: "none",
        minHeight: 0,
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
