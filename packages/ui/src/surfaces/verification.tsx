import type { VerificationPayload } from "@noctis/contracts";
import { corner, material, semantic, spacing, typography } from "../tokens/index.js";

const STATUSES = [
  { status: "verified", label: "Verified", icon: "✓", color: semantic.success },
  { status: "partial", label: "Partially verified", icon: "◐", color: semantic.warning },
  { status: "required", label: "Still required", icon: "○", color: typography.color.muted },
  { status: "blocked", label: "Blocked", icon: "!", color: semantic.error },
] as const;

export function groupByStatus(items: VerificationPayload["items"]): Array<{
  status: VerificationPayload["items"][number]["status"];
  label: string;
  items: VerificationPayload["items"];
}> {
  return STATUSES.map(({ status, label }) => ({
    status,
    label,
    items: items.filter((item) => item.status === status),
  })).filter((group) => group.items.length > 0);
}

export function VerificationSurface({ items }: VerificationPayload): JSX.Element {
  return (
    <div style={{ display: "grid", gap: spacing.md }}>
      {groupByStatus(items).map((group) => {
        const style = STATUSES.find((entry) => entry.status === group.status)!;
        return (
          <section key={group.status} aria-label={group.label}>
            <h3 style={{ margin: 0, color: style.color, fontSize: typography.scale.sm }}>
              {group.label}
            </h3>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {group.items.map((item) => (
                <li key={item.id} style={{ paddingBlock: spacing.sm, overflowWrap: "anywhere" }}>
                  <span aria-hidden="true" style={{ color: style.color }}>
                    {style.icon}{" "}
                  </span>
                  {item.claim}
                  {item.reason !== undefined && (
                    <span
                      style={{
                        display: "inline-block",
                        marginLeft: spacing.xs,
                        border: `1px solid ${material.border}`,
                        borderRadius: corner.lg,
                        padding: "2px 8px",
                        color: typography.color.muted,
                      }}
                    >
                      {item.reason}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
