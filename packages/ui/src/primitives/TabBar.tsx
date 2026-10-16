import type { CSSProperties } from "react";

import {
  corner,
  depth,
  elevation,
  identityAccent,
  material,
  semantic,
  spacing,
  typography,
} from "../tokens/index.js";
import { motion } from "motion/react";

import { NavIcon } from "./icons.js";
import type { RailItem } from "./rail-items.js";
import { HIDDEN_ITEMS, NAV_ITEMS } from "./rail-items.js";

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
 * Section 5.2's touch floor.
 */
export const TAB_TARGET = 44;

/** A tab carries an icon over its word, which needs more than the bare floor. */
const TAB_BUTTON = 54;

/** The hairline between the bar and the page above it. */
const BORDER_PX = 1;

/**
 * The bar's height without the safe-area inset, which the page area pads by so
 * the last row of content is not sitting under the bar.
 *
 * Derived, not declared: the bar is one row of buttons inside `spacing.xs` of
 * padding, over a hairline. Every term is here because a literal was wrong
 * twice, once by a second `minHeight` on the nav and once by the border pixel
 * nobody counts. Writing the sum down means changing the button, the padding,
 * or the hairline moves the reservation with it.
 */
export const TAB_BAR_HEIGHT = TAB_BUTTON + spacing.xs * 2 + BORDER_PX;

export interface TabBarProps {
  active: RailItem;
  onSelect: (item: RailItem) => void;
  /** Present only when the all-pages flag is set; opens the sheet of hidden pages. */
  onMore?: () => void;
  /** How many things wait behind a destination: Approvals' count. */
  counts?: Partial<Record<RailItem, number>>;
}

/**
 * What a destination with something waiting adds to its button: a count over
 * the icon, and the same count as the button's description. The name stays
 * the destination's own, so "Approvals" is still what a screen reader and the
 * Tab key find.
 */
export function counted(
  name: RailItem,
  count: number | undefined,
): { props: { "aria-label"?: string; title?: string }; badge: JSX.Element | null } {
  if (count === undefined || count <= 0) {
    return { props: {}, badge: null };
  }

  return {
    props: { "aria-label": name, title: `${String(count)} waiting` },
    badge: (
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 4,
          left: "calc(50% + 6px)",
          minWidth: 16,
          height: 16,
          padding: "0 4px",
          boxSizing: "border-box",
          borderRadius: 8,
          background: semantic.approval,
          color: depth.floor,
          font: `700 10px/16px ${typography.family}`,
          textAlign: "center",
        }}
      >
        {count > 99 ? "99+" : String(count)}
      </span>
    ),
  };
}

const buttonStyle = {
  flex: 1,
  minWidth: 0,
  // Border-box so the declared floor is the whole button, padding included.
  boxSizing: "border-box",
  minHeight: TAB_BUTTON,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 3,
  font: `500 11px ${typography.family}`,
  letterSpacing: typography.tracking.wide,
  background: "transparent",
  border: "none",
  borderRadius: corner.md,
  padding: `${String(spacing.xs)}px 2px`,
  cursor: "pointer",
  // Clip rather than widen: a bar that grows past the viewport is the
  // horizontal scroll this whole layout exists to remove.
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

function tabStyle(isActive: boolean): CSSProperties {
  return {
    ...buttonStyle,
    color: isActive ? identityAccent.vesper.primary : typography.color.muted,
    position: "relative",
    isolation: "isolate",
  };
}

/** The current tab's ground, one element that travels to whichever tab is chosen. */
function TabMarker(): JSX.Element {
  return (
    <motion.span
      layoutId="noctis-tab-current"
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: -1,
        borderRadius: corner.md,
        // A short lit line on top of the active tab, the bar's one bit of glow.
        // The glow falls inward: the tab clips anything outside it.
        background: `linear-gradient(180deg, ${identityAccent.vesper.primary}2e, transparent 70%), ${material.fill}`,
        boxShadow: `inset 0 2px 0 ${identityAccent.vesper.primary}`,
      }}
    />
  );
}

export function TabBar({ active, onSelect, onMore, counts }: TabBarProps): JSX.Element {
  // A hidden page has no tab of its own, so More stands in for it: the bar
  // must always show where the owner is.
  const moreActive = ([...NAV_ITEMS.slice(4), ...HIDDEN_ITEMS] as readonly RailItem[]).includes(
    active,
  );

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
        padding: spacing.xs,
        // Without it the bar sits under a phone's home indicator.
        paddingBottom: `calc(${String(spacing.xs)}px + env(safe-area-inset-bottom))`,
        // Translucent over the page so content scrolling under it reads as
        // depth, with the blur keeping the labels legible over anything.
        background: "rgba(11, 10, 18, 0.88)",
        backdropFilter: `blur(${String(material.blurPx)}px)`,
        WebkitBackdropFilter: `blur(${String(material.blurPx)}px)`,
        borderTop: `${String(BORDER_PX)}px solid ${material.border}`,
        zIndex: elevation.rail,
      }}
    >
      {NAV_ITEMS.slice(0, 4).map((item) => {
        const isActive = item === active;
        const { props, badge } = counted(item, counts?.[item]);

        return (
          <button
            key={item}
            type="button"
            aria-current={isActive ? "page" : undefined}
            {...props}
            onClick={() => {
              onSelect(item);
            }}
            style={tabStyle(isActive)}
          >
            {isActive && <TabMarker />}
            <NavIcon item={item} />
            {item}
            {badge}
          </button>
        );
      })}

      {onMore !== undefined && (
        <button
          type="button"
          aria-current={moreActive ? "page" : undefined}
          onClick={onMore}
          style={tabStyle(moreActive)}
        >
          {moreActive && <TabMarker />}
          <NavIcon item="More" />
          More
        </button>
      )}
    </nav>
  );
}
