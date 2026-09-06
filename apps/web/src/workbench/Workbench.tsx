import type { CompositionPlan, SurfaceIntent, SurfaceRegion } from "@noctis/contracts";
import { SurfaceFrame, corner, elevation, material, spacing, typography } from "@noctis/ui";

import { renderSurface } from "../surfaces/renderers.js";
import { resolveSurface } from "../surfaces/registry.js";
import type { CompositionState } from "./useComposition.js";

const COLUMNS: readonly SurfaceRegion[] = ["left", "centre", "right"];

/** A named column's share of the canvas. Fixed sides, elastic middle. */
const COLUMN_WIDTH: Readonly<Record<string, string>> = {
  left: "minmax(240px, 0.8fr)",
  centre: "minmax(0, 2fr)",
  right: "minmax(240px, 1fr)",
};

export interface WorkbenchProps {
  composition: CompositionState;
  /** Passed through to any Surface renderer that offers a Vault handoff. */
  onOpenInVault?: (evidence: { entityId: string }) => void;
}

function slotsIn(plan: CompositionPlan, region: SurfaceRegion): CompositionPlan["slots"] {
  return plan.slots.filter((slot) => slot.region === region);
}

/**
 * Renders a committed plan. It reads the plan; it never computes one.
 *
 * Nothing here decides what goes where — the compositor already did, in a pure
 * function the core ran and persisted. This component's whole job is to turn
 * five region names into CSS, which is why no ranking, capacity, or override
 * logic appears in it.
 */
export function Workbench({ composition, onOpenInVault }: WorkbenchProps): JSX.Element {
  const { plan, intents, overrides, focusedSurfaceId } = composition;

  if (plan === undefined) {
    return <p style={{ padding: spacing.xl }}>Composing…</p>;
  }

  const byId = new Map<string, SurfaceIntent>(intents.map((intent) => [intent.id, intent]));
  const overriddenIds = new Set(
    overrides.filter((entry) => entry.releasedAt === undefined).map((entry) => entry.surfaceId),
  );

  const frameFor = (slot: CompositionPlan["slots"][number]): JSX.Element | undefined => {
    const intent = byId.get(slot.surfaceId);

    if (intent === undefined) {
      return undefined;
    }

    const resolved = resolveSurface(intent.kind, intent.payloadVersion, intent.payload, slot.size);

    return (
      <SurfaceFrame
        key={slot.surfaceId}
        surfaceId={slot.surfaceId}
        title={resolved.status === "ok" ? resolved.title : intent.kind}
        role={intent.role}
        size={slot.size}
        region={slot.region}
        overridden={overriddenIds.has(slot.surfaceId)}
        onMove={(region) => {
          void composition.move(slot.surfaceId, region, slot.size);
        }}
        onRelease={() => {
          void composition.release(slot.surfaceId);
        }}
        onDismiss={() => {
          void composition.dismiss(slot.surfaceId);
        }}
      >
        <button
          type="button"
          aria-pressed={focusedSurfaceId === slot.surfaceId}
          onClick={() => {
            composition.focus(focusedSurfaceId === slot.surfaceId ? undefined : slot.surfaceId);
          }}
          style={{
            marginBottom: spacing.sm,
            background: "transparent",
            color: typography.color.muted,
            border: `1px solid ${material.border}`,
            borderRadius: corner.sm,
            padding: `${String(spacing.xs)}px ${String(spacing.sm)}px`,
            cursor: "pointer",
            font: `${String(typography.scale.xs)}px ${typography.family}`,
          }}
        >
          {focusedSurfaceId === slot.surfaceId ? "Leave focus" : "Focus"}
        </button>
        {renderSurface(resolved, onOpenInVault === undefined ? {} : { onOpenInVault })}
      </SurfaceFrame>
    );
  };

  const occupied = COLUMNS.filter((region) => slotsIn(plan, region).length > 0);
  const bottom = slotsIn(plan, "bottom");
  const overlay = slotsIn(plan, "overlay");

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0, display: "grid", gap: spacing.md }}>
      <div
        style={{
          display: "grid",
          gap: spacing.md,
          gridTemplateColumns: occupied.map((region) => COLUMN_WIDTH[region]).join(" "),
          alignItems: "stretch",
          minHeight: 0,
        }}
      >
        {occupied.map((region) => (
          <div key={region} style={{ display: "grid", gap: spacing.md, minWidth: 0 }}>
            {slotsIn(plan, region).map(frameFor)}
          </div>
        ))}
      </div>

      {bottom.length > 0 && (
        <div
          style={{
            // The control strip spans the canvas rather than hugging the left
            // edge: it is the row beneath the columns, not a fourth column.
            display: "grid",
            gap: spacing.md,
            gridAutoFlow: "column",
            gridAutoColumns: "1fr",
          }}
        >
          {bottom.map(frameFor)}
        </div>
      )}

      {overlay.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: spacing.lg,
            right: spacing.lg,
            width: 360,
            display: "grid",
            gap: spacing.md,
            zIndex: elevation.overlay,
          }}
        >
          {overlay.map(frameFor)}
        </div>
      )}

      <Overflow plan={plan} intents={byId} composition={composition} />

      <p
        style={{
          margin: 0,
          font: `${String(typography.scale.xs)}px ${typography.monoFamily}`,
          color: typography.color.muted,
        }}
      >
        {plan.layoutId} · {plan.reasonCodes.join(" ")}
      </p>
    </div>
  );
}

interface OverflowProps {
  plan: CompositionPlan;
  intents: Map<string, SurfaceIntent>;
  composition: CompositionState;
}

/**
 * The overflow stack (Section 5.4 step 7): everything the layout could not
 * place, reachable rather than hidden.
 *
 * `<details>` is the platform's disclosure widget — it is in the tab order,
 * opens on Enter or Space, and announces its state, so a keyboard-only user can
 * reach an overflowed Surface and place it back on the canvas without any of
 * that being written here.
 */
function Overflow({ plan, intents, composition }: OverflowProps): JSX.Element | null {
  if (plan.overflowSurfaceIds.length === 0) {
    return null;
  }

  return (
    <details>
      <summary
        style={{ cursor: "pointer", font: `${String(typography.scale.sm)}px ${typography.family}` }}
      >
        {plan.overflowSurfaceIds.length} Surface
        {plan.overflowSurfaceIds.length === 1 ? "" : "s"} did not fit
      </summary>
      <ul style={{ listStyle: "none", margin: 0, padding: `${String(spacing.sm)}px 0` }}>
        {plan.overflowSurfaceIds.map((surfaceId) => {
          const intent = intents.get(surfaceId);

          return (
            <li
              key={surfaceId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: spacing.sm,
                padding: spacing.xs,
              }}
            >
              <span style={{ flex: 1 }}>{intent?.kind ?? "unknown"}</span>
              <button
                type="button"
                onClick={() => {
                  void composition.move(surfaceId, "centre", "wide");
                }}
                style={{
                  background: material.fill,
                  color: "inherit",
                  border: `1px solid ${material.border}`,
                  borderRadius: corner.sm,
                  padding: `${String(spacing.xs)}px ${String(spacing.sm)}px`,
                  cursor: "pointer",
                }}
              >
                Place in centre
              </button>
              <button
                type="button"
                onClick={() => {
                  void composition.dismiss(surfaceId);
                }}
                style={{
                  background: "transparent",
                  color: "inherit",
                  border: `1px solid ${material.border}`,
                  borderRadius: corner.sm,
                  padding: `${String(spacing.xs)}px ${String(spacing.sm)}px`,
                  cursor: "pointer",
                }}
              >
                Dismiss
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
