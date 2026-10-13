import { corner, material, semantic, spacing, typography } from "../tokens/index.js";

/**
 * The generic Surface primitives Phase 6 renders. Section 5.3 names fifteen;
 * these five are the ones the Objective slice actually composes, and each later
 * phase registers the primitive its own work needs (Approval in Phase 8, Native
 * Application in Phase 9, Vault Recall in Phase 7). Empty components for those
 * now would be scaffolding pretending to be a registry.
 *
 * None of them takes a coordinate, a width, or a z-index: a primitive is told
 * what it contains, never where it sits. Placement belongs to the compositor.
 */

const listReset = { listStyle: "none", margin: 0, padding: 0 } as const;

export interface ConversationSurfaceProps {
  messages: ReadonlyArray<{ id: string; author: string; text: string }>;
}

export function ConversationSurface({ messages }: ConversationSurfaceProps): JSX.Element {
  return (
    <ol style={{ ...listReset, display: "flex", flexDirection: "column", gap: spacing.md }}>
      {messages.map((message) => (
        <li key={message.id}>
          <p
            style={{
              margin: 0,
              font: `${String(typography.scale.xs)}px ${typography.family}`,
              letterSpacing: typography.tracking.wide,
              color: typography.color.muted,
            }}
          >
            {message.author}
          </p>
          <p style={{ margin: 0, maxWidth: typography.measurePx }}>{message.text}</p>
        </li>
      ))}
    </ol>
  );
}

export interface ListSurfaceProps {
  items: ReadonlyArray<{ id: string; label: string; detail?: string }>;
  onChoose?: (id: string) => void;
}

export function ListSurface({ items, onChoose }: ListSurfaceProps): JSX.Element {
  return (
    <ul style={{ ...listReset, display: "flex", flexDirection: "column", gap: spacing.xs }}>
      {items.map((item) => (
        <li
          key={item.id}
          style={{ borderBottom: `1px solid ${material.border}`, paddingBlock: spacing.sm }}
        >
          {onChoose === undefined ? (
            <span>
              {item.label}
              {item.detail !== undefined && (
                <span style={{ color: typography.color.muted }}> — {item.detail}</span>
              )}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                onChoose(item.id);
              }}
              style={{
                minHeight: 44,
                width: "100%",
                textAlign: "left",
                background: material.fill,
                color: "inherit",
                border: `1px solid ${material.border}`,
                borderRadius: corner.sm,
                padding: `${String(spacing.xs)}px ${String(spacing.sm)}px`,
                cursor: "pointer",
                font: `${String(typography.scale.base)}px ${typography.family}`,
              }}
            >
              {item.label}
              {item.detail !== undefined && (
                <span style={{ color: typography.color.muted }}> — {item.detail}</span>
              )}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface DetailSurfaceProps {
  fields: ReadonlyArray<{ label: string; value: string }>;
}

export function DetailSurface({ fields }: DetailSurfaceProps): JSX.Element {
  return (
    <dl
      style={{
        margin: 0,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)",
        gap: spacing.sm,
      }}
    >
      {fields.map((field) => (
        <div key={field.label} style={{ display: "contents" }}>
          <dt style={{ color: typography.color.muted }}>{field.label}</dt>
          <dd
            style={{ margin: 0, font: `${String(typography.scale.base)}px ${typography.family}` }}
          >
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export type EvidenceStatus = "current" | "stale" | "unavailable" | "unknown";

const STATUS_COLOUR: Readonly<Record<EvidenceStatus, string>> = {
  current: semantic.current,
  stale: semantic.stale,
  unavailable: semantic.unavailable,
  unknown: semantic.unavailable,
};

export interface EvidenceSurfaceProps {
  items: ReadonlyArray<{ id: string; claim: string; source: string; status: EvidenceStatus }>;
}

/**
 * Freshness is written out as a word next to its dot. Section 5.2 is explicit
 * that "colour is never the sole carrier of meaning", and `unavailable` and
 * `unknown` deliberately share a colour — only the label separates them.
 */
export function EvidenceSurface({ items }: EvidenceSurfaceProps): JSX.Element {
  return (
    <ul style={{ ...listReset, display: "flex", flexDirection: "column", gap: spacing.sm }}>
      {items.map((item) => (
        <li
          key={item.id}
          style={{ borderBottom: `1px solid ${material.border}`, paddingBlock: spacing.sm }}
        >
          <p style={{ margin: 0, maxWidth: typography.measurePx }}>{item.claim}</p>
          <p
            style={{
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: spacing.xs,
              font: `${String(typography.scale.xs)}px ${typography.family}`,
              color: typography.color.muted,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: STATUS_COLOUR[item.status],
              }}
            />
            <span
              style={{
                border: `1px solid ${material.border}`,
                borderRadius: corner.lg,
                padding: "2px 8px",
                color: STATUS_COLOUR[item.status],
              }}
            >
              {item.status}
            </span>
            <span>· {item.source}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

export interface AttentionSurfaceProps {
  headline: string;
  detail: string;
  actions?: ReadonlyArray<{ id: string; label: string; onAct: () => void }>;
}

export function AttentionSurface({
  headline,
  detail,
  actions = [],
}: AttentionSurfaceProps): JSX.Element {
  return (
    <div
      role="group"
      aria-label={headline}
      style={{
        display: "grid",
        gap: spacing.sm,
        borderLeft: `3px solid ${semantic.warning}`,
        paddingLeft: spacing.md,
      }}
    >
      <p style={{ margin: 0, color: semantic.warning }}>{headline}</p>
      <p style={{ margin: 0, maxWidth: typography.measurePx }}>{detail}</p>
      {actions.length > 0 && (
        <div style={{ display: "flex", gap: spacing.sm }}>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={action.onAct}
              style={{
                minHeight: 44,
                background: material.fillElevated,
                color: "inherit",
                border: `1px solid ${material.border}`,
                borderRadius: corner.sm,
                padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
                cursor: "pointer",
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface FallbackSurfaceProps {
  kind: string;
  reason: string;
}

/**
 * What renders when the registry has no entry for a `kind`, or the payload does
 * not match the schema the entry declares. It says what failed instead of
 * showing an empty frame, because a Surface that silently renders nothing is
 * indistinguishable from one that had nothing to say.
 */
export function FallbackSurface({ kind, reason }: FallbackSurfaceProps): JSX.Element {
  return (
    <div style={{ display: "grid", gap: spacing.xs }}>
      <p style={{ margin: 0, color: semantic.warning }}>This Surface could not be rendered.</p>
      <p style={{ margin: 0, color: typography.color.muted }}>
        kind <code style={{ fontFamily: typography.monoFamily }}>{kind}</code> — {reason}
      </p>
    </div>
  );
}
