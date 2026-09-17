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
import { tabsFor } from "./tab-items.js";

/**
 * Ported from the donor's `client/src/components/MobileTabBar.tsx` (commit
 * `724d331`, MIT, "Copyright (c) 2026 - Now, Son Nguyen"). Its information
 * architecture only — a fixed bottom bar, a handful of primary destinations, a
 * "More" control for the rest, and safe-area padding. None of its code: the
 * donor is Tailwind, `react-router`, `lucide-react` and `i18next`, and Noctis
 * has none of the four. See `docs/architecture/DONOR-PORT-LEDGER.md`.
 *
 * The rail's shape below the breakpoint. Plain `<button>` elements and the same
 * tokens as `Rail`, for the same reason: a native button already gives Tab
 * order, Enter/Space activation, and a visible focus ring.
 */

/**
 * The bar's height without the safe-area inset, which the page area pads by so
 * the last row of content is not sitting under the bar. Exported because two
 * places need the same number and a second literal is how they drift apart.
 */
export const TAB_BAR_HEIGHT = 56;

export interface TabBarProps {
  active: RailItem;
  onSelect: (item: RailItem) => void;
  onMore: () => void;
}

const buttonStyle = {
  flex: 1,
  minWidth: 0,
  // Section 5.2's touch floor. A 10px label in a 32px row is the donor's one
  // measurement worth changing rather than keeping.
  minHeight: 44,
  font: `${String(typography.scale.xs)}px ${typography.family}`,
  letterSpacing: typography.tracking.wide,
  background: "transparent",
  border: "none",
  borderRadius: corner.md,
  padding: `${String(spacing.xs)}px ${String(spacing.xs)}px`,
  cursor: "pointer",
  // Eight-character destinations in a fifth of 400px: clip rather than widen,
  // because a bar that grows past the viewport is the horizontal scroll this
  // whole layout exists to remove.
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

export function TabBar({ active, onSelect, onMore }: TabBarProps): JSX.Element {
  const { tabs } = tabsFor(active);

  return (
    <nav
      aria-label="Primary"
      style={{
        position: "fixed",
        insetInline: 0,
        bottom: 0,
        display: "flex",
        alignItems: "stretch",
        gap: spacing.xs,
        minHeight: TAB_BAR_HEIGHT,
        padding: spacing.xs,
        // The donor's one piece of geometry kept verbatim: without it the bar
        // sits under a phone's home indicator.
        paddingBottom: `calc(${String(spacing.xs)}px + env(safe-area-inset-bottom))`,
        background: depth.layers[0],
        borderTop: `1px solid ${material.border}`,
        zIndex: elevation.rail,
      }}
    >
      {tabs.map((item) => {
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
              ...buttonStyle,
              color: isActive ? identityAccent.vesper.primary : "#E7E6EE",
              background: isActive ? material.fillElevated : "transparent",
            }}
          >
            {item}
          </button>
        );
      })}

      <button type="button" onClick={onMore} style={{ ...buttonStyle, color: "#E7E6EE" }}>
        More
      </button>
    </nav>
  );
}
