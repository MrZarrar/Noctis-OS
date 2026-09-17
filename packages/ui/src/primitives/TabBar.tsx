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
 * Section 5.2's touch floor, and the thing that actually sets the bar's height.
 */
export const TAB_TARGET = 44;

/** The hairline between the bar and the page above it. */
const BORDER_PX = 1;

/**
 * The bar's height without the safe-area inset, which the page area pads by so
 * the last row of content is not sitting under the bar.
 *
 * Derived, not declared: the bar is one row of `TAB_TARGET` buttons inside
 * `spacing.xs` of padding, over a hairline. Every term is here because a
 * literal was wrong twice — first because the nav carried its own `minHeight`
 * too (65px rendered against 56px reserved), then because the border is a
 * pixel nobody counts (53 against 52). Writing the sum down means raising the
 * touch floor, the padding, or the hairline moves the reservation with it.
 */
export const TAB_BAR_HEIGHT = TAB_TARGET + spacing.xs * 2 + BORDER_PX;

export interface TabBarProps {
  active: RailItem;
  onSelect: (item: RailItem) => void;
  onMore: () => void;
}

const buttonStyle = {
  flex: 1,
  minWidth: 0,
  // Border-box so the declared floor is the whole button, padding included:
  // with content-box the same number means 44px *plus* padding, which is how
  // the bar ended up taller than the space reserved for it.
  boxSizing: "border-box",
  // A 10px label in a 32px row is the donor's one measurement worth changing
  // rather than keeping.
  minHeight: TAB_TARGET,
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
        // No height of its own: the buttons set it, and `TAB_BAR_HEIGHT` is
        // the arithmetic of that. A `minHeight` here as well would be a second
        // source of truth for one measurement.
        padding: spacing.xs,
        // The donor's one piece of geometry kept verbatim: without it the bar
        // sits under a phone's home indicator.
        paddingBottom: `calc(${String(spacing.xs)}px + env(safe-area-inset-bottom))`,
        background: depth.layers[0],
        borderTop: `${String(BORDER_PX)}px solid ${material.border}`,
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
              color: isActive ? identityAccent.vesper.primary : typography.color.primary,
              background: isActive ? material.fillElevated : "transparent",
            }}
          >
            {item}
          </button>
        );
      })}

      <button
        type="button"
        onClick={onMore}
        style={{ ...buttonStyle, color: typography.color.primary }}
      >
        More
      </button>
    </nav>
  );
}
