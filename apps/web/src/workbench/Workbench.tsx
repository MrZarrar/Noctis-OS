import { useEffect, useRef } from "react";
import type { PanelUpdateState } from "@noctis/ui";
import { buttonStyle } from "../layout/Page.js";
import { PanelControls } from "./PanelControls.js";
import type { CompositionPlan, SurfaceIntent, SurfaceRegion } from "@noctis/contracts";
import { SurfaceFrame, elevation, glass, semantic, spacing, typography } from "@noctis/ui";

import type { SurfaceContext } from "../surfaces/renderers.js";
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
  updates?: Readonly<Record<string, PanelUpdateState>>;
  /**
   * Every handoff a Surface renderer may be given, as one object.
   *
   * One prop rather than one per handoff, and the reason is a bug this shape
   * caused twice. Forwarding them individually means each new handoff needs a
   * prop declared here, destructured, and spread into the context — three edits,
   * and missing any one of them leaves a Surface rendering with no buttons and
   * nothing failing. A JSX spread of extra props does not even trip the
   * type-checker, so `onActOnTool` and `onSurveyTools` were passed by Phase 10's
   * caller, dropped here, and typechecked clean.
   *
   * Passing the context straight through means the intermediate layer is no
   * longer a place a handoff can go missing. Absent handoffs are still how a
   * Surface renders without an action — a browser with no desktop shell behind
   * it supplies no `onPlaceWindow`, and the native Surface shows no place
   * button — but that is now the caller's decision alone.
   */
  handoffs?: SurfaceContext;
  /**
   * What this client can do, for the registry's `requires` gate.
   *
   * A client capability, not an authority grant — the two are different and
   * conflating them would be the bug. Authority is decided by the core on every
   * single placement, whatever is passed here. This answers the narrower
   * question of whether this page could carry the action out at all, which for
   * `window.place` means "is there a desktop shell behind it".
   */
  capabilities?: readonly string[];
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
export function Workbench({
  composition,
  handoffs = {},
  capabilities = [],
  updates = {},
}: WorkbenchProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const restoreAfterClose = useRef<HTMLElement>();
  const { plan, intents, overrides, focusedSurfaceId } = composition;
  useEffect(() => {
    const previous = restoreAfterClose.current;
    if (previous !== undefined && !previous.isConnected) {
      const visibleControl = Array.from(
        root.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      ).find((button) => !button.disabled && button.checkVisibility());
      (visibleControl ?? root.current)?.focus();
      restoreAfterClose.current = undefined;
    }
  }, [plan]);
  const close = async (id: string): Promise<void> => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.current?.contains(active)) {
      restoreAfterClose.current = active;
    }
    try {
      await composition.dismiss(id);
    } catch (error) {
      restoreAfterClose.current = undefined;
      throw error;
    }
  };

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

    const resolved = resolveSurface(
      intent.kind,
      intent.payloadVersion,
      intent.payload,
      slot.size,
      capabilities,
    );

    return (
      <SurfaceFrame
        key={slot.surfaceId}
        surfaceId={slot.surfaceId}
        title={resolved.status === "ok" ? resolved.title : intent.kind}
        role={intent.role}
        size={slot.size}
        region={slot.region}
        {...updates[slot.surfaceId]}
        controls={
          <PanelControls
            title={resolved.status === "ok" ? resolved.title : intent.kind}
            region={slot.region}
            size={slot.size}
            display={plan.reasonCodes.includes("display.compact") ? "compact" : "standard"}
            pinned={overriddenIds.has(slot.surfaceId)}
            focused={focusedSurfaceId === slot.surfaceId}
            onFocus={() =>
              composition.focus(focusedSurfaceId === slot.surfaceId ? undefined : slot.surfaceId)
            }
            onPin={() => {
              void (overriddenIds.has(slot.surfaceId)
                ? composition.release(slot.surfaceId)
                : composition.move(slot.surfaceId, slot.region, slot.size));
            }}
            onPlace={(region) => {
              void composition.move(slot.surfaceId, region, slot.size);
            }}
            onSize={(size) => {
              void composition.move(slot.surfaceId, slot.region, size);
            }}
            onClose={() => {
              void close(slot.surfaceId);
            }}
          />
        }
      >
        {renderSurface(resolved, handoffs, slot.size)}
      </SurfaceFrame>
    );
  };

  const occupied = COLUMNS.filter((region) => slotsIn(plan, region).length > 0);
  const bottom = slotsIn(plan, "bottom");
  const overlay = slotsIn(plan, "overlay");

  return (
    <div
      ref={root}
      tabIndex={-1}
      data-reason-codes={plan.reasonCodes.join(" ")}
      style={{ position: "relative", flex: 1, minWidth: 0, display: "grid", gap: spacing.md }}
    >
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
            position: plan.reasonCodes.includes("display.compact") ? "static" : "absolute",
            top: spacing.lg,
            right: spacing.lg,
            width: plan.reasonCodes.includes("display.compact") ? "auto" : 360,
            borderTop: plan.reasonCodes.includes("display.compact")
              ? `2px solid ${semantic.approval}`
              : undefined,
            display: "grid",
            gap: spacing.md,
            zIndex: elevation.overlay,
          }}
        >
          {overlay.map(frameFor)}
        </div>
      )}

      <Overflow plan={plan} intents={byId} composition={composition} onClose={close} />
    </div>
  );
}

interface OverflowProps {
  onClose: (id: string) => Promise<void>;
  plan: CompositionPlan;
  intents: Map<string, SurfaceIntent>;
  composition: CompositionState;
}

function Overflow({ plan, intents, composition, onClose }: OverflowProps): JSX.Element | null {
  if (plan.overflowSurfaceIds.length === 0) {
    return null;
  }

  return (
    <details style={{ ...glass, padding: spacing.md }}>
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
                style={buttonStyle}
              >
                Show
              </button>
              <button
                type="button"
                onClick={() => {
                  void onClose(surfaceId);
                }}
                style={buttonStyle}
              >
                Close
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
