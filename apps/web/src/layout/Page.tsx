import { corner, material, spacing, typography } from "@noctis/ui";
import type { ReactNode } from "react";

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
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** The region's name when the title alone would be ambiguous to a screen reader. */
  label?: string;
  /** How wide the content may grow on a large screen; a conversation wants less. */
  maxWidth?: number;
}): JSX.Element {
  return (
    <section
      aria-label={label ?? title}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflowY: "auto",
        overflowX: "hidden",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        padding: `${String(spacing.lg)}px clamp(${String(spacing.lg)}px, 4vw, ${String(spacing.xxxl)}px)`,
      }}
    >
      <div
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
            flexWrap: "wrap",
            alignItems: "center",
            gap: spacing.sm,
            rowGap: spacing.xs,
          }}
        >
          <div style={{ display: "grid", gap: 2, minWidth: 0, flex: "1 1 auto" }}>
            <h1
              style={{
                margin: 0,
                font: `600 ${String(typography.scale.xl)}px/1.15 ${typography.family}`,
                letterSpacing: typography.tracking.tight,
              }}
            >
              {title}
            </h1>
            {subtitle !== undefined && (
              <p
                style={{ margin: 0, color: typography.color.muted, fontSize: typography.scale.sm }}
              >
                {subtitle}
              </p>
            )}
          </div>
          {actions !== undefined && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.sm }}>{actions}</div>
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

/** Glass: the one surface treatment, so cards on every page are the same material. */
export const glass = {
  background: `linear-gradient(180deg, ${material.fillElevated}, ${material.fill})`,
  border: `1px solid ${material.border}`,
  borderRadius: corner.lg,
  boxShadow: `inset 0 1px 0 ${material.fill}, 0 12px 32px -18px ${material.shadow}`,
} as const;

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
