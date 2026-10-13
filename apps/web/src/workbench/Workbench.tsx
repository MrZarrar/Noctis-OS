import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { PanelUpdateState } from "@noctis/ui";
import { buttonStyle } from "../layout/Page.js";
import { PanelControls } from "./PanelControls.js";
import type {
  CompositionPlan,
  SurfaceIntent,
  SurfaceRegion,
  SurfacePlacementRegion,
  SurfaceSize,
} from "@noctis/contracts";
import { SurfaceFrame, elevation, glass, semantic, spacing, typography } from "@noctis/ui";

import type { SurfaceContext } from "../surfaces/renderers.js";
import { renderSurface } from "../surfaces/renderers.js";
import { resolveSurface } from "../surfaces/registry.js";
import type { CompositionState } from "./useComposition.js";
import { useIsMobile } from "../layout/useIsMobile.js";
import {
  clampShares,
  dropTarget,
  PANEL_MIN_WIDTH,
  readGeometry,
  supportedRegions,
  writeGeometry,
  type PanelGeometry,
} from "./arrange.js";
import type { DisplayClass } from "@noctis/domain";

const COLUMNS: readonly SurfaceRegion[] = ["left", "centre", "right"];

/** A named column's share of the canvas. Fixed sides, elastic middle. */
const COLUMN_WEIGHT: Readonly<Record<string, number>> = { left: 0.8, centre: 2, right: 1 };
const DEFAULT_GEOMETRY: PanelGeometry = { columns: {}, bottom: 0.3 };
function storedGeometry(scope: string | undefined): PanelGeometry {
  try {
    return scope === undefined
      ? DEFAULT_GEOMETRY
      : (readGeometry(window.localStorage, scope) ?? DEFAULT_GEOMETRY);
  } catch {
    return DEFAULT_GEOMETRY;
  }
}

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
  const stage = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();
  const scope = composition.geometryScope;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [stored, setStored] = useState<{ scope: string | undefined; geometry: PanelGeometry }>(
    () => ({
      scope,
      geometry: storedGeometry(scope),
    }),
  );
  const [preview, setPreview] = useState<PanelGeometry>();
  const [arrangeError, setArrangeError] = useState<string>();
  const [bounds, setBounds] = useState({ width: 0, height: 480 });
  const [drag, setDrag] = useState<{
    id: string;
    region?: SurfacePlacementRegion;
    targetId?: string | undefined;
  }>();
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    sourceId: string | undefined;
    separator: number | "bottom" | undefined;
    initial: PanelGeometry;
    moved: boolean;
  }>();
  const geometry = preview ?? (stored.scope === scope ? stored.geometry : DEFAULT_GEOMETRY);
  const cancel = (): void => {
    gesture.current = undefined;
    setPreview(undefined);
    setDrag(undefined);
  };
  const saveGeometry = (value: PanelGeometry): boolean => {
    let saved = false;
    try {
      saved = scope !== undefined && writeGeometry(window.localStorage, scope, value);
    } catch {
      /* Browser storage can be disabled entirely. */
    }
    if (!saved) {
      setArrangeError("Could not save these panel sizes. Enable browser storage and try again.");
      setPreview(undefined);
      return false;
    }
    setStored({ scope, geometry: value });
    setPreview(undefined);
    setArrangeError(undefined);
    return true;
  };
  useEffect(() => {
    cancel();
    setStored({
      scope,
      geometry: storedGeometry(scope),
    });
    setArrangeError(undefined);
  }, [scope]);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, []);
  const restoreAfterClose = useRef<HTMLElement>();
  const { plan, intents, overrides, focusedSurfaceId } = composition;
  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const observer = new ResizeObserver(() =>
      setBounds({
        width: main.current?.clientWidth ?? element.clientWidth,
        height: element.clientHeight,
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [plan === undefined]);
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
  const display: DisplayClass = plan.reasonCodes.includes("display.wide")
    ? "wide"
    : plan.reasonCodes.includes("display.compact")
      ? "compact"
      : "standard";
  const regions = supportedRegions(plan.layoutId, display);
  const occupied = COLUMNS.filter((region) => slotsIn(plan, region).length > 0);
  const minimums = occupied.map((region) =>
    Math.max(
      ...slotsIn(plan, region).map(
        (slot) => PANEL_MIN_WIDTH[byId.get(slot.surfaceId)?.kind ?? ""] ?? 240,
      ),
    ),
  );
  const availableWidth = Math.max(1, bounds.width - Math.max(0, occupied.length - 1) * spacing.md);
  const stacked =
    mobile ||
    (bounds.width > 0 && minimums.reduce((sum, width) => sum + width, 0) > availableWidth);
  const shares = clampShares(
    occupied.map(
      (region) =>
        geometry.columns[region as keyof PanelGeometry["columns"]] ?? COLUMN_WEIGHT[region] ?? 1,
    ),
    minimums,
    availableWidth,
  );
  const bottom = slotsIn(plan, "bottom");
  const overlay = slotsIn(plan, "overlay");
  const rowShares = clampShares(
    [1 - geometry.bottom, geometry.bottom],
    [240, 180],
    bounds.height - spacing.md,
  );
  const resize = (
    separator: number | "bottom",
    delta: number,
    initial: PanelGeometry = geometry,
  ): PanelGeometry => {
    if (separator === "bottom")
      return {
        ...initial,
        bottom: clampShares(
          [1 - initial.bottom + delta / bounds.height, initial.bottom - delta / bounds.height],
          [240, 180],
          bounds.height - spacing.md,
        )[1]!,
      };
    const next = clampShares(
      occupied.map(
        (region) =>
          initial.columns[region as keyof PanelGeometry["columns"]] ?? COLUMN_WEIGHT[region] ?? 1,
      ),
      minimums,
      availableWidth,
    );
    next[separator] = Math.max(0.001, (next[separator] ?? 0) + delta / availableWidth);
    next[separator + 1] = Math.max(0.001, (next[separator + 1] ?? 0) - delta / availableWidth);
    const clamped = clampShares(next, minimums, availableWidth);
    return {
      ...initial,
      columns: Object.fromEntries(occupied.map((region, index) => [region, clamped[index]])),
    };
  };
  const start = (
    event: ReactPointerEvent<HTMLElement>,
    sourceId?: string,
    separator?: number | "bottom",
  ): void => {
    if (mobile || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      sourceId,
      separator,
      initial: geometry,
      moved: false,
    };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = gesture.current;
    if (active === undefined || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    active.moved ||= Math.hypot(dx, dy) > 6;
    if (!active.moved) return;
    if (active.separator !== undefined) {
      setPreview(resize(active.separator, active.separator === "bottom" ? dy : dx, active.initial));
      return;
    }
    if (active.sourceId === undefined) return;
    const hit = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-drop-region], [data-surface-id]");
    const frame = hit?.dataset.surfaceId === undefined ? undefined : hit;
    const region = dropTarget(
      frame?.dataset.surfaceRegion ?? hit?.dataset.dropRegion,
      plan.layoutId,
      display,
    );
    setDrag({
      id: active.sourceId,
      ...(region === undefined ? {} : { region }),
      ...(frame === undefined || frame.dataset.surfaceId === active.sourceId
        ? {}
        : { targetId: frame.dataset.surfaceId }),
    });
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = gesture.current;
    if (active === undefined || active.pointerId !== event.pointerId) return;
    gesture.current = undefined;
    if (active.moved && active.separator !== undefined && preview !== undefined)
      saveGeometry(preview);
    if (active.moved && drag?.region !== undefined) {
      const source = plan.slots.find((slot) => slot.surfaceId === drag.id);
      if (source !== undefined)
        void (drag.targetId === undefined
          ? composition.move(drag.id, drag.region, source.size)
          : composition.swap(drag.id, drag.targetId));
    }
    setPreview(undefined);
    setDrag(undefined);
  };
  const separatorFor = (separator: number | "bottom"): JSX.Element => (
    <div
      role="separator"
      tabIndex={0}
      aria-label={
        separator === "bottom"
          ? "Resize main and bottom panels"
          : `Resize ${occupied[separator]} and ${occupied[separator + 1]} panels`
      }
      aria-orientation={separator === "bottom" ? "horizontal" : "vertical"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(
        (separator === "bottom" ? rowShares[0]! : shares[separator]!) * 100,
      )}
      onPointerDown={(event) => start(event, undefined, separator)}
      onDoubleClick={() =>
        saveGeometry(
          separator === "bottom"
            ? { ...geometry, bottom: DEFAULT_GEOMETRY.bottom }
            : { ...geometry, columns: {} },
        )
      }
      onKeyDown={(event) => {
        const decrease = separator === "bottom" ? "ArrowUp" : "ArrowLeft";
        const increase = separator === "bottom" ? "ArrowDown" : "ArrowRight";
        if (event.key === decrease || event.key === increase) {
          event.preventDefault();
          saveGeometry(resize(separator, event.key === decrease ? -32 : 32));
        }
        if (event.key === "Home") {
          event.preventDefault();
          saveGeometry(
            separator === "bottom"
              ? { ...geometry, bottom: DEFAULT_GEOMETRY.bottom }
              : { ...geometry, columns: {} },
          );
        }
      }}
      style={{
        position: "absolute",
        zIndex: 2,
        touchAction: "none",
        ...(separator === "bottom"
          ? { height: 44, width: "100%", left: 0, bottom: -28, cursor: "row-resize" }
          : { width: 44, height: "100%", right: -28, top: 0, cursor: "col-resize" }),
        display: "grid",
        placeItems: "center",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          background: semantic.approval,
          opacity: 0.55,
          borderRadius: 2,
          ...(separator === "bottom" ? { height: 3, width: "100%" } : { width: 3, height: "100%" }),
        }}
      />
    </div>
  );
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
        titleProps={
          mobile
            ? undefined
            : {
                onPointerDown: (event) => start(event, slot.surfaceId),
                style: { cursor: "grab", touchAction: "none", userSelect: "none" },
                title: "Drag to place or swap this panel",
              }
        }
        {...updates[slot.surfaceId]}
        controls={
          <PanelControls
            title={resolved.status === "ok" ? resolved.title : intent.kind}
            region={slot.region}
            size={slot.size}
            display={plan.reasonCodes.includes("display.compact") ? "compact" : "standard"}
            pinned={overriddenIds.has(slot.surfaceId)}
            focused={focusedSurfaceId === slot.surfaceId}
            regions={regions}
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
              const proportion: Record<SurfaceSize, number> = {
                compact: 0.25,
                standard: 0.4,
                wide: 0.6,
                stage: 0.75,
              };
              const next =
                slot.region === "bottom"
                  ? { ...geometry, bottom: proportion[size] }
                  : COLUMNS.includes(slot.region)
                    ? {
                        ...geometry,
                        columns: {
                          ...Object.fromEntries(
                            occupied.map((region, index) => [region, shares[index]]),
                          ),
                          [slot.region]: proportion[size],
                        },
                        bottom: bottom.length > 0 ? 1 - proportion[size] : geometry.bottom,
                      }
                    : undefined;
              const sentScope = scope;
              void composition.move(slot.surfaceId, slot.region, size).then((saved) => {
                if (saved && next !== undefined && sentScope === scopeRef.current)
                  saveGeometry(next);
              });
            }}
            onClose={() => {
              void close(slot.surfaceId);
            }}
          />
        }
      >
        {renderSurface(
          resolved,
          {
            ...handoffs,
            contentRevision: intent.requestedAt,
            panelOwner:
              intent.threadId !== undefined
                ? { threadId: intent.threadId }
                : intent.objectiveId !== undefined
                  ? { objectiveId: intent.objectiveId }
                  : { presence: true },
          },
          slot.size,
        )}
      </SurfaceFrame>
    );
  };

  return (
    <div
      ref={root}
      tabIndex={-1}
      data-reason-codes={plan.reasonCodes.join(" ")}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={cancel}
      onLostPointerCapture={() => {
        if (gesture.current !== undefined) cancel();
      }}
      style={{ position: "relative", flex: 1, minWidth: 0, display: "grid", gap: spacing.md }}
    >
      {(arrangeError ?? composition.error) !== undefined && (
        <p role="alert">{arrangeError ?? composition.error}</p>
      )}
      {drag !== undefined && (
        <div
          aria-label="Panel drop regions"
          style={{ display: "flex", flexWrap: "wrap", gap: spacing.sm }}
        >
          {regions.map((region) => (
            <div
              key={region}
              data-drop-region={region}
              style={{
                ...glass,
                minHeight: 44,
                padding: spacing.sm,
                outline: drag.region === region ? `2px solid ${semantic.approval}` : undefined,
              }}
            >
              {region}
            </div>
          ))}
        </div>
      )}
      <div
        ref={stage}
        style={{
          minWidth: 0,
          minHeight: 0,
          display: "grid",
          gap: spacing.md,
          height: !mobile && bottom.length > 0 ? "clamp(480px, 56vh, 620px)" : undefined,
          gridTemplateRows:
            !mobile && bottom.length > 0 ? `${rowShares[0]}fr ${rowShares[1]}fr` : undefined,
        }}
      >
        <div
          ref={main}
          style={{
            display: "grid",
            gap: spacing.md,
            gridTemplateColumns: stacked
              ? "minmax(0, 1fr)"
              : shares.map((share) => `minmax(0, ${share}fr)`).join(" "),
            alignItems: "stretch",
            minHeight: 0,
            position: "relative",
          }}
        >
          {occupied.map((region, index) => (
            <div
              key={region}
              data-drop-region={region}
              style={{
                position: "relative",
                display: "grid",
                gridTemplateRows: `repeat(${slotsIn(plan, region).length}, minmax(0, 1fr))`,
                gap: spacing.md,
                minWidth: 0,
                minHeight: 0,
                outline: drag?.region === region ? `2px solid ${semantic.approval}` : undefined,
              }}
            >
              {slotsIn(plan, region).map(frameFor)}
              {!stacked && index < occupied.length - 1 && separatorFor(index)}
            </div>
          ))}
          {!mobile && bottom.length > 0 && separatorFor("bottom")}
        </div>

        {bottom.length > 0 && (
          <div
            data-drop-region="bottom"
            style={{
              // The control strip spans the canvas rather than hugging the left
              // edge: it is the row beneath the columns, not a fourth column.
              display: "grid",
              gap: spacing.md,
              gridAutoFlow: "column",
              gridAutoColumns: "1fr",
              minWidth: 0,
              minHeight: 0,
            }}
          >
            {bottom.map(frameFor)}
          </div>
        )}
      </div>

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

      <Overflow
        plan={plan}
        intents={byId}
        composition={composition}
        onClose={close}
        desktop={!mobile}
      />
    </div>
  );
}

interface OverflowProps {
  desktop: boolean;
  onClose: (id: string) => Promise<void>;
  plan: CompositionPlan;
  intents: Map<string, SurfaceIntent>;
  composition: CompositionState;
}

function Overflow({
  plan,
  intents,
  composition,
  onClose,
  desktop,
}: OverflowProps): JSX.Element | null {
  if (plan.overflowSurfaceIds.length === 0 && !desktop) {
    return null;
  }

  return (
    <details data-drop-region="overflow" style={{ ...glass, padding: spacing.md }}>
      <summary
        style={{ cursor: "pointer", font: `${String(typography.scale.sm)}px ${typography.family}` }}
      >
        Overflow: {plan.overflowSurfaceIds.length} panel
        {plan.overflowSurfaceIds.length === 1 ? "" : "s"}
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
