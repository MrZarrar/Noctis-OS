import type { VaultFreshness } from "@noctis/contracts";

import { corner, material, semantic, spacing, typography } from "../tokens/index.js";

/**
 * The focused recall Surface (Section 7).
 *
 * It shows evidence, not a Vault. Every row names the note it came from and
 * carries an Open in Vault control, which is the handoff Section 7 asks for:
 * Command receives a focused recall, and the dedicated view is one click away
 * with the return context preserved by the caller.
 */

const FRESHNESS_COLOUR: Readonly<Record<VaultFreshness, string>> = {
  current: semantic.current,
  stale: semantic.stale,
  unavailable: semantic.unavailable,
  unknown: semantic.unavailable,
};

/**
 * The exact words Section 7 requires, spelled out rather than implied.
 * `unavailable` and `unknown` share a colour, so only the sentence separates
 * them — which is the point: one means the source is gone, the other means
 * nobody has looked.
 */
const FRESHNESS_TEXT: Readonly<Record<VaultFreshness, string>> = {
  current: "current — the note still says this",
  stale: "stale — the note changed since this was indexed",
  unavailable: "unavailable — the note is no longer there",
  unknown: "unknown — nothing was recalled for this",
};

export interface RecallEvidenceView {
  itemId: string;
  entityId: string;
  path: string;
  quote: string;
  freshness: VaultFreshness;
}

export interface RecallSurfaceProps {
  query: string;
  freshness: VaultFreshness;
  evidence: readonly RecallEvidenceView[];
  onOpenInVault?: (evidence: RecallEvidenceView) => void;
}

export function RecallSurface({
  query,
  freshness,
  evidence,
  onOpenInVault,
}: RecallSurfaceProps): JSX.Element {
  return (
    <div style={{ display: "grid", gap: spacing.md }}>
      <p style={{ margin: 0, color: typography.color.muted }}>
        Recalled for <strong style={{ color: typography.color.primary }}>{query}</strong>
      </p>

      <Freshness value={freshness} />

      {evidence.length === 0 ? (
        <p style={{ margin: 0, color: typography.color.muted }}>
          Nothing in the Vault matched. That is not evidence that it is untrue.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: spacing.sm }}>
          {evidence.map((item) => (
            <li
              key={`${item.itemId}-${item.quote}-${item.path}`}
              style={{
                borderBottom: `1px solid ${material.border}`,
                padding: spacing.sm,
                display: "grid",
                gap: spacing.xs,
              }}
            >
              <blockquote
                style={{
                  margin: 0,
                  maxWidth: typography.measurePx,
                  fontFamily: typography.monoFamily,
                  fontSize: typography.scale.xs,
                }}
              >
                {item.quote}
              </blockquote>

              <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
                {/* Provenance is navigable: the note, then the freshness of it. */}
                <span
                  style={{ flex: 1, color: typography.color.muted, fontSize: typography.scale.xs }}
                >
                  {item.path}
                </span>
                <Freshness value={item.freshness} compact />
                {onOpenInVault !== undefined && (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenInVault(item);
                    }}
                    style={{
                      font: `${String(typography.scale.xs)}px ${typography.family}`,
                      minHeight: 44,
                      background: material.fill,
                      color: "inherit",
                      border: `1px solid ${material.border}`,
                      borderRadius: corner.sm,
                      padding: `${String(spacing.xs)}px ${String(spacing.sm)}px`,
                      cursor: "pointer",
                    }}
                  >
                    Open in Vault
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Freshness({
  value,
  compact = false,
}: {
  value: VaultFreshness;
  compact?: boolean;
}): JSX.Element {
  return (
    <span
      style={{
        display: "inline-flex",
        border: `1px solid ${material.border}`,
        borderRadius: corner.lg,
        padding: "2px 8px",
        alignItems: "center",
        gap: spacing.xs,
        color: typography.color.muted,
        fontSize: typography.scale.xs,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: FRESHNESS_COLOUR[value],
        }}
      />
      <span>{compact ? value : FRESHNESS_TEXT[value]}</span>
    </span>
  );
}
