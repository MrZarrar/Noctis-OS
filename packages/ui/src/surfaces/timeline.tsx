import type { TimelinePayload } from "@noctis/contracts";
import { corner, material, semantic, spacing, typography } from "../tokens/index.js";

export function TimelineSurface({ items }: TimelinePayload): JSX.Element {
  return (
    <ol
      aria-label="Timeline"
      style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: spacing.sm }}
    >
      {items.map((item) => (
        <li
          key={item.id}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 5rem) 14px minmax(0, 1fr)",
            gap: spacing.sm,
            alignItems: "stretch",
          }}
        >
          <span
            style={{
              fontFamily: typography.monoFamily,
              overflowWrap: "anywhere",
              color: typography.color.muted,
            }}
          >
            {item.start}
            {item.end !== undefined && (
              <>
                {item.start !== undefined && " – "}
                {item.end}
              </>
            )}
          </span>
          <span
            aria-hidden="true"
            style={{ borderLeft: `1px solid ${material.border}`, paddingTop: 6 }}
          >
            <span
              style={{
                display: "block",
                width: 8,
                height: 8,
                marginLeft: -5,
                borderRadius: "50%",
                border: `2px solid ${item.due ? semantic.warning : typography.color.muted}`,
                background: material.fill,
              }}
            />
          </span>
          <div
            style={{
              border: `1px solid ${material.border}`,
              borderRadius: corner.sm,
              padding: spacing.sm,
              background: material.fill,
              overflowWrap: "anywhere",
            }}
          >
            <p style={{ margin: 0 }}>{item.label}</p>
            {item.detail !== undefined && (
              <p style={{ margin: 0, color: typography.color.muted }}>{item.detail}</p>
            )}
            {item.due && <span style={{ color: semantic.warning }}>Due</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
