import {
  corner,
  depth,
  elevation,
  identityAccent,
  material,
  spacing,
  typography,
} from "../tokens/index.js";
import type { RailItem } from "./rail-items.js";
import { RAIL_ITEMS } from "./rail-items.js";

export interface RailProps {
  active: RailItem;
  onSelect: (item: RailItem) => void;
}

/**
 * The permanent eight-item nav from Section 5.1. Plain `<button>` elements: a
 * native button already gives Tab order, Enter/Space activation, and a
 * visible focus ring, which is the "keyboard navigation, visible focus"
 * requirement in Section 5.2 without any hand-rolled key handling.
 */
export function Rail({ active, onSelect }: RailProps): JSX.Element {
  return (
    <nav
      aria-label="Primary"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: spacing.xs,
        width: 72,
        padding: spacing.sm,
        background: depth.layers[0],
        borderRight: `1px solid ${material.border}`,
        zIndex: elevation.rail,
      }}
    >
      {RAIL_ITEMS.map((item) => {
        const isActive = item === active;

        return (
          <button
            key={item}
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => {
              onSelect(item);
            }}
            style={{
              font: `${String(typography.scale.xs)}px ${typography.family}`,
              letterSpacing: typography.tracking.wide,
              color: isActive ? identityAccent.vesper.primary : "#E7E6EE",
              background: isActive ? material.fillElevated : "transparent",
              border: "none",
              borderRadius: corner.md,
              padding: `${String(spacing.sm)}px ${String(spacing.xs)}px`,
              cursor: "pointer",
            }}
          >
            {item}
          </button>
        );
      })}
    </nav>
  );
}
