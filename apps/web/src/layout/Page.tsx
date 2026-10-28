import { corner, elevation, material, spacing, typography } from "@noctis/ui";
import type { ReactNode } from "react";

import { useIsMobile } from "./useIsMobile.js";

/**
 * The frame every v1 page sits in: a title, a line saying what the page is
 * looking at, the page's own actions, and a body that scrolls inside the shell
 * so the document itself never does (the tab bar would rubber-band with it).
 */
export function Page({
  title,
  subtitle,
  actions,
  children,
  label,
  maxWidth = 1200,
  still = false,
  compactHeader = false,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** The region's name when the title alone would be ambiguous to a screen reader. */
  label?: string;
  /** How wide the content may grow on a large screen; a conversation wants less. */
  maxWidth?: number;
  /** Arrives without the fade, for a page whose content must not sit under one. */
  still?: boolean;
  compactHeader?: boolean;
}): JSX.Element {
  const mobile = useIsMobile();
  const compact = mobile && compactHeader;

  return (
    <section
      aria-label={label ?? title}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflowY: "auto",
        overflowX: "hidden",
        // The containing block for anything absolutely placed inside a page
        // (the spoken labels in Threads), so it scrolls with the page instead
        // of stretching the document.
        position: "relative",
        overscrollBehavior: "contain",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        padding: `${String(spacing.lg)}px clamp(${String(spacing.lg)}px, 4vw, ${String(spacing.xxxl)}px)`,
        // Room for the app's core when it waits in the corner. On a desktop the
        // end of a long page scrolls clear of it. A phone's controls run the
        // full width, so whichever row happened to rest under the core would be
        // covered: there the page stops above it instead.
        ...(mobile
          ? { marginBottom: "var(--noctis-core-clearance, 0px)" }
          : {
              paddingBottom: `calc(${String(spacing.lg)}px + var(--noctis-core-clearance, 0px))`,
            }),
      }}
    >
      <div
        className={still ? undefined : "noctis-fade-in"}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: spacing.lg,
          width: "100%",
          maxWidth,
          marginInline: "auto",
        }}
      >
        <header
          style={{
            display: "flex",
            flexWrap: compact ? "nowrap" : "wrap",
            alignItems: "center",
            gap: spacing.sm,
            rowGap: spacing.xs,
            // Stays put while the page scrolls, so Back and Conversations are
            // never a long scroll away.
            position: "sticky",
            top: compact ? -spacing.xs : -spacing.lg,
            zIndex: elevation.surface,
            marginInline: -spacing.sm,
            padding: `${String(compact ? spacing.xs : spacing.lg)}px ${String(spacing.sm)}px ${String(compact ? spacing.xs : spacing.sm)}px`,
            marginTop: -spacing.lg,
            background: "rgba(5, 4, 9, 0.5)",
            backdropFilter: `blur(${String(material.blurPx)}px)`,
            WebkitBackdropFilter: `blur(${String(material.blurPx)}px)`,
          }}
        >
          <div style={{ display: "grid", gap: 2, minWidth: 0, flex: "1 1 auto" }}>
            <h1
              style={{
                margin: 0,
                font: `600 ${String(compact ? 18 : typography.scale.xl)}px/1.15 ${typography.family}`,
                letterSpacing: typography.tracking.tight,
              }}
            >
              {title}
            </h1>
            {subtitle !== undefined && (
              <p
                style={{
                  margin: 0,
                  color: typography.color.muted,
                  fontSize: compact ? 12 : typography.scale.sm,
                  ...(compact
                    ? { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }
                    : {}),
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
          {actions !== undefined && (
            <div
              style={{
                display: "flex",
                flexWrap: compact ? "nowrap" : "wrap",
                gap: spacing.sm,
                ...(compact
                  ? { flexShrink: 0, maxWidth: "calc(100% - 76px)", overflowX: "auto" }
                  : {}),
              }}
            >
              {actions}
            </div>
          )}
        </header>
        {children}
      </div>
    </section>
  );
}

/** A section heading inside a page, small and spaced like the mockups' labels. */
export function SectionHeading({ children }: { children: ReactNode }): JSX.Element {
  return (
    <h2
      style={{
        margin: 0,
        font: `600 ${String(typography.scale.xs)}px ${typography.family}`,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: typography.color.muted,
      }}
    >
      {children}
    </h2>
  );
}

export { glass } from "@noctis/ui";

/** Every button a thumb presses: Section 5.2's 44px floor, declared rather than hoped for. */
export const buttonStyle = {
  minHeight: 44,
  boxSizing: "border-box",
  font: `500 ${String(typography.scale.sm)}px ${typography.family}`,
  color: typography.color.primary,
  background: material.fillElevated,
  border: `1px solid ${material.border}`,
  borderRadius: corner.md,
  padding: `0 ${String(spacing.lg)}px`,
  cursor: "pointer",
} as const;

export const fieldStyle = {
  minHeight: 44,
  boxSizing: "border-box",
  width: "100%",
  minWidth: 0,
  font: `${String(typography.scale.base)}px ${typography.family}`,
  color: "inherit",
  background: material.fill,
  border: `1px solid ${material.border}`,
  borderRadius: corner.md,
  padding: `0 ${String(spacing.md)}px`,
} as const;

/** Read out, not drawn. */
export const visuallyHidden = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
} as const;

/** Uneven line lengths, so held space reads as text rather than as bars. */
const SKELETON_WIDTHS = [92, 78, 86, 64, 88, 72];

/**
 * Space held for something still loading, in roughly the shape it will take,
 * so nothing jumps when it arrives. The words are still there for a screen
 * reader; the shapes are not announced.
 */
export function Skeleton({
  label,
  lines = 3,
  lineHeight = 12,
  gap = spacing.sm,
}: {
  label: string;
  lines?: number;
  lineHeight?: number;
  gap?: number;
}): JSX.Element {
  return (
    <div role="status" style={{ display: "grid", gap, minWidth: 0 }}>
      <span style={visuallyHidden}>{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="noctis-skeleton"
          style={{
            display: "block",
            height: lineHeight,
            width:
              lineHeight >= 32
                ? "100%"
                : `${String(SKELETON_WIDTHS[index % SKELETON_WIDTHS.length])}%`,
          }}
        />
      ))}
    </div>
  );
}
