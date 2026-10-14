import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePopouts } from "./PopoutProvider.js";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { PanelUpdateState } from "@noctis/ui";
import { buttonStyle } from "../layout/Page.js";
import { PanelControls } from "./PanelControls.js";
import type { CompositionPlan, SurfaceIntent, SurfaceRegion } from "@noctis/contracts";
import {
  SurfaceFrame,
  corner,
  depth,
  elevation,
  glass,
  material,
  semantic,
  spacing,
  typography,
} from "@noctis/ui";

import type { SurfaceContext } from "../surfaces/renderers.js";
import { renderSurface } from "../surfaces/renderers.js";
import { resolveSurface } from "../surfaces/registry.js";
import type { CompositionState } from "./useComposition.js";
import { useIsMobile } from "../layout/useIsMobile.js";
import {
  defaultRect,
  fitRect,
  PANEL_MIN_WIDTH,
  presetRect,
  readWindows,
  resizeRect,
  writeWindows,
  type PanelWindows,
  type ResizeEdge,
  type Viewport,
  type WindowRect,
} from "./arrange.js";

/** The reading order when panels stack in the page instead of floating. */
const STACK_ORDER: readonly SurfaceRegion[] = ["left", "centre", "right", "bottom", "overlay"];
const KEY_STEP = 32;
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-KEY_STEP, 0],
  ArrowRight: [KEY_STEP, 0],
  ArrowUp: [0, -KEY_STEP],
  ArrowDown: [0, KEY_STEP],
};
/** Where each resize grip sits on a window; corners come last so they sit above the edges. */
const EDGES: Readonly<Record<ResizeEdge, CSSProperties>> = {
  n: { top: -4, left: 10, right: 10, height: 8, cursor: "ns-resize" },
  s: { bottom: -4, left: 10, right: 10, height: 8, cursor: "ns-resize" },
  e: { right: -4, top: 10, bottom: 10, width: 8, cursor: "ew-resize" },
  w: { left: -4, top: 10, bottom: 10, width: 8, cursor: "ew-resize" },
  ne: { top: -4, right: -4, width: 14, height: 14, cursor: "nesw-resize" },
  nw: { top: -4, left: -4, width: 14, height: 14, cursor: "nwse-resize" },
  se: { bottom: -4, right: -4, width: 14, height: 14, cursor: "nwse-resize" },
  sw: { bottom: -4, left: -4, width: 14, height: 14, cursor: "nesw-resize" },
};
/**
 * Every mounted Workbench's committed windows, so a panel opening for one owner
 * (the thread) lands clear of another's (its Objective). Written after commit,
 * never during render: React may discard a render, and its entry would linger.
 */
// ponytail: two owners whose first panels arrive in the same commit can still share a spot; drag one.
const onScreen = new Map<string, readonly WindowRect[]>();
/**
 * One stacking order for every floating window on the page, last on top, so a
 * thread's window and its Objective's can be raised over each other.
 * Session-only: a reload starts every panel level.
 */
// ponytail: only the 16 most recently raised keep their order, so z-index stays under the modal layer.
let stacking: readonly string[] = [];
const stackingListeners = new Set<() => void>();
function raiseWindows(ids: readonly string[]): void {
  const next = [...stacking.filter((id) => !ids.includes(id)), ...ids].slice(-16);
  if (next.length === stacking.length && next.every((id, index) => id === stacking[index])) return;
  stacking = next;
  stackingListeners.forEach((listener) => listener());
}
function subscribeStacking(listener: () => void): () => void {
  stackingListeners.add(listener);
  return () => stackingListeners.delete(listener);
}
const SAVE_FAILED = "Could not save these panel sizes. Enable browser storage and try again.";

function storedWindows(scope: string | undefined): PanelWindows {
  try {
    return scope === undefined ? {} : (readWindows(window.localStorage, scope) ?? {});
  } catch {
    return {};
  }
}
function viewportSize(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
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
 * The compositor decides which panels exist and which spill to overflow. Where
 * a panel sits on a desktop screen is the owner's: each one is a floating
 * window they drag and resize, remembered per screen in this browser. A phone,
 * or a focused panel, stacks in the page instead.
 */
export function Workbench({
  composition,
  handoffs = {},
  capabilities = [],
  updates = {},
}: WorkbenchProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();
  const owner = useId();
  const { coordinator, state: popouts } = usePopouts();
  const ownPopouts = popouts.entries.filter((entry) => entry.owner === owner);
  const poppedIds = new Set(ownPopouts.map((entry) => entry.surfaceId));
  const lastSlots = useRef(new Map<string, CompositionPlan["slots"][number]>());
  const previousPopouts = useRef<readonly string[]>([]);
  useEffect(() => {
    const returned = previousPopouts.current.find((id) => !poppedIds.has(id));
    previousPopouts.current = ownPopouts.map((entry) => entry.surfaceId);
    if (returned !== undefined) {
      const frame = root.current?.querySelector(`[data-surface-id="${returned}"]`);
      (
        frame?.querySelector<HTMLButtonElement>('[aria-label^="Pop out "]') ??
        root.current?.querySelector<HTMLElement>("summary")
      )?.focus({ preventScroll: true });
    }
  }, [popouts, composition.plan]);
  useEffect(() => () => coordinator?.releaseOwner(owner), [coordinator, owner]);

  useEffect(() => {
    coordinator?.retain(
      owner,
      mobile
        ? []
        : composition.intents
            .filter((intent) => intent.lifecycle !== "dismissed" && intent.lifecycle !== "exiting")
            .map((intent) => intent.id),
    );
  }, [coordinator, owner, composition.intents, mobile]);
  const scope = composition.geometryScope;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [stored, setStored] = useState<{ scope: string | undefined; windows: PanelWindows }>(
    () => ({ scope, windows: storedWindows(scope) }),
  );
  // Read straight away on an owner switch: an empty map here would save defaults over its places.
  const windows = stored.scope === scope ? stored.windows : storedWindows(scope);
  const [preview, setPreview] = useState<{ id: string; rect: WindowRect }>();
  const [arrangeError, setArrangeError] = useState<string>();
  const [viewport, setViewport] = useState(viewportSize);
  const front = useSyncExternalStore(subscribeStacking, () => stacking);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    id: string;
    edge: ResizeEdge | undefined;
    initial: WindowRect;
    minWidth: number;
    moved: boolean;
  }>();
  /** The latest saved windows and live panels, for saves that land after an await. */
  const latest = useRef({ windows, intents: composition.intents });
  latest.current = { windows, intents: composition.intents };
  /** Panels drawn at a default place this render, written down after it so they never jump. */
  const unsaved = useRef<PanelWindows>({});
  /** Panels already raised as new, so one whose place cannot be saved is not raised every render. */
  const announced = useRef(new Set<string>());
  /** This render's windows, published to `onScreen` once committed. */
  const drawn = useRef<readonly WindowRect[]>([]);
  useLayoutEffect(() => {
    onScreen.set(owner, drawn.current);
  });
  useEffect(() => () => void onScreen.delete(owner), [owner]);
  const cancel = (): void => {
    gesture.current = undefined;
    setPreview(undefined);
  };
  const write = (changes: PanelWindows): boolean => {
    const live = new Set(latest.current.intents.map((intent) => intent.id));
    const next = Object.fromEntries(
      Object.entries({ ...latest.current.windows, ...changes }).filter(([id]) => live.has(id)),
    );
    let saved = false;
    try {
      saved = scope !== undefined && writeWindows(window.localStorage, scope, next);
    } catch {
      /* Browser storage can be disabled entirely. */
    }
    if (saved) setStored({ scope, windows: next });
    return saved;
  };
  const saveWindow = (id: string, rect: WindowRect): void => {
    setPreview(undefined);
    setArrangeError(write({ [id]: rect }) ? undefined : SAVE_FAILED);
  };
  useEffect(() => {
    if (Object.keys(unsaved.current).length > 0) write(unsaved.current);
    // A panel that has just opened comes up on top, as a new window would. Once:
    // two Workbenches re-raising their own would re-render each other forever.
    const opened = Object.keys(unsaved.current).filter((id) => !announced.current.has(id));
    opened.forEach((id) => announced.current.add(id));
    if (opened.length > 0) raiseWindows(opened);
  });
  useEffect(() => {
    cancel();
    setStored({ scope, windows: storedWindows(scope) });
    setArrangeError(undefined);
  }, [scope]);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") cancel();
    };
    const onResize = (): void => setViewport(viewportSize());
    window.addEventListener("keydown", onEscape);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  const restoreAfterClose = useRef<HTMLElement>();
  const { plan, intents, overrides, focusedSurfaceId } = composition;
  useEffect(() => {
    const previous = restoreAfterClose.current;
    if (previous !== undefined && !previous.isConnected) {
      const target =
        previous.ownerDocument.defaultView?.closed === false && previous.ownerDocument !== document
          ? previous.ownerDocument.body
          : root.current;
      const visibleControl = Array.from(
        target?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      ).find((button) => !button.disabled && button.checkVisibility());
      (visibleControl ?? root.current)?.focus();
      restoreAfterClose.current = undefined;
    }
  }, [plan, popouts]);
  const close = async (id: string): Promise<void> => {
    const ownerDocument =
      ownPopouts.find((entry) => entry.surfaceId === id)?.container.ownerDocument ?? document;
    const active = ownerDocument.activeElement;
    if (active !== null && (ownerDocument !== document || root.current?.contains(active))) {
      restoreAfterClose.current = active as HTMLElement;
    }
    try {
      await composition.dismiss(id);
    } catch (error) {
      restoreAfterClose.current = undefined;
      throw error;
    }
  };

  unsaved.current = {};
  drawn.current = [];
  if (plan === undefined) {
    return <p style={{ padding: spacing.xl }}>Composing…</p>;
  }

  const byId = new Map<string, SurfaceIntent>(intents.map((intent) => [intent.id, intent]));
  for (const slot of plan.slots) lastSlots.current.set(slot.surfaceId, slot);
  const canvasPlan = {
    ...plan,
    slots: plan.slots.filter((slot) => !poppedIds.has(slot.surfaceId)),
  };
  const compact = plan.reasonCodes.includes("display.compact");
  const floating = !mobile && focusedSurfaceId === undefined;
  const minWidthOf = (id: string): number => PANEL_MIN_WIDTH[byId.get(id)?.kind ?? ""] ?? 240;
  const rects = new Map<string, WindowRect>();
  if (floating) {
    const placed = [...onScreen].flatMap(([key, list]) => (key === owner ? [] : list));
    for (const slot of canvasPlan.slots) {
      // A slot with no live intent draws nothing, and `write` would drop its id on every save.
      if (!byId.has(slot.surfaceId)) continue;
      const saved =
        windows[slot.surfaceId] ??
        (unsaved.current[slot.surfaceId] = defaultRect(slot.size, placed, viewport));
      const rect = fitRect(
        preview?.id === slot.surfaceId ? preview.rect : saved,
        viewport,
        minWidthOf(slot.surfaceId),
      );
      rects.set(slot.surfaceId, rect);
      placed.push(rect);
    }
  }
  drawn.current = [...rects.values()];
  const start = (event: ReactPointerEvent<HTMLElement>, id: string, edge?: ResizeEdge): void => {
    const rect = rects.get(id);
    if (event.button !== 0 || rect === undefined) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      id,
      edge,
      initial: rect,
      minWidth: minWidthOf(id),
      moved: false,
    };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = gesture.current;
    if (active === undefined || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    active.moved ||= Math.hypot(dx, dy) > 3;
    if (!active.moved) return;
    const next =
      active.edge === undefined
        ? { ...active.initial, x: active.initial.x + dx, y: active.initial.y + dy }
        : resizeRect(active.initial, active.edge, dx, dy, active.minWidth);
    setPreview({ id: active.id, rect: fitRect(next, viewport, active.minWidth) });
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = gesture.current;
    if (active === undefined || active.pointerId !== event.pointerId) return;
    gesture.current = undefined;
    if (active.moved && preview?.id === active.id) saveWindow(active.id, preview.rect);
    else setPreview(undefined);
  };
  const overriddenIds = new Set(
    overrides.filter((entry) => entry.releasedAt === undefined).map((entry) => entry.surfaceId),
  );

  const frameFor = (
    slot: CompositionPlan["slots"][number],
    popped = false,
  ): JSX.Element | undefined => {
    const intent = byId.get(slot.surfaceId);

    if (
      intent === undefined ||
      intent.lifecycle === "dismissed" ||
      intent.lifecycle === "exiting"
    ) {
      return undefined;
    }

    const resolved = resolveSurface(
      intent.kind,
      intent.payloadVersion,
      intent.payload,
      slot.size,
      capabilities,
    );
    const rect = popped ? undefined : rects.get(slot.surfaceId);

    return (
      <SurfaceFrame
        key={slot.surfaceId}
        surfaceId={slot.surfaceId}
        title={resolved.status === "ok" ? resolved.title : intent.kind}
        role={intent.role}
        size={slot.size}
        region={slot.region}
        titleProps={
          rect === undefined
            ? undefined
            : {
                tabIndex: 0,
                onPointerDown: (event) => start(event, slot.surfaceId),
                onKeyDown: (event) => {
                  const step = ARROWS[event.key];
                  if (step === undefined) return;
                  event.preventDefault();
                  const minWidth = minWidthOf(slot.surfaceId);
                  const next = event.shiftKey
                    ? resizeRect(rect, "se", step[0], step[1], minWidth)
                    : { ...rect, x: rect.x + step[0], y: rect.y + step[1] };
                  saveWindow(slot.surfaceId, fitRect(next, viewport, minWidth));
                },
                style: { cursor: "grab", touchAction: "none", userSelect: "none" },
                title: "Drag to move. Arrow keys move it, Shift and arrow keys resize it.",
              }
        }
        {...updates[slot.surfaceId]}
        controls={
          <PanelControls
            title={resolved.status === "ok" ? resolved.title : intent.kind}
            size={slot.size}
            pinned={overriddenIds.has(slot.surfaceId)}
            focused={focusedSurfaceId === slot.surfaceId}
            popped={popped}
            onPopout={
              mobile || coordinator === undefined
                ? undefined
                : () => {
                    if (popped) coordinator.returnPanel(owner, slot.surfaceId);
                    else void coordinator.open(owner, slot.surfaceId);
                  }
            }
            onFocus={() =>
              composition.focus(focusedSurfaceId === slot.surfaceId ? undefined : slot.surfaceId)
            }
            onPin={() => {
              void (overriddenIds.has(slot.surfaceId)
                ? composition.release(slot.surfaceId)
                : composition.move(slot.surfaceId, slot.region, slot.size));
            }}
            onSize={(size) => {
              const next =
                rect === undefined
                  ? undefined
                  : presetRect(rect, size, viewport, minWidthOf(slot.surfaceId));
              const sentScope = scope;
              void composition.move(slot.surfaceId, slot.region, size).then((saved) => {
                if (saved && next !== undefined && sentScope === scopeRef.current)
                  saveWindow(slot.surfaceId, next);
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
            ...(composition.fileTextCache === undefined
              ? {}
              : { fileText: { cache: composition.fileTextCache, surfaceId: intent.id } }),
            ...(composition.fileImageCache === undefined
              ? {}
              : { fileMedia: { cache: composition.fileImageCache, surfaceId: intent.id } }),
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

  const windowFor = (slot: CompositionPlan["slots"][number]): JSX.Element | null => {
    const rect = rects.get(slot.surfaceId);
    const frame = frameFor(slot);
    if (rect === undefined || frame === undefined) return null;
    const id = slot.surfaceId;
    return (
      <div
        key={id}
        data-panel-window={id}
        onPointerDownCapture={() => raiseWindows([id])}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={cancel}
        onLostPointerCapture={() => {
          if (gesture.current !== undefined) cancel();
        }}
        style={{
          position: "fixed",
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          zIndex:
            (slot.region === "overlay" ? elevation.overlay : elevation.surface) +
            1 +
            front.indexOf(id),
          display: "grid",
          gridTemplateRows: "minmax(0, 1fr)",
          // The glass is translucent; a window over another must hide what is behind it.
          background: depth.layers[0],
          borderRadius: corner.lg,
          boxShadow: `0 18px 48px -12px ${material.shadow}`,
        }}
      >
        {frame}
        {(Object.keys(EDGES) as ResizeEdge[]).map((edge) => (
          <div
            key={edge}
            aria-hidden="true"
            data-resize-edge={edge}
            onPointerDown={(event) => start(event, id, edge)}
            style={{ position: "absolute", touchAction: "none", ...EDGES[edge] }}
          />
        ))}
      </div>
    );
  };

  return (
    <div
      ref={root}
      tabIndex={-1}
      data-reason-codes={plan.reasonCodes.join(" ")}
      style={{ position: "relative", flex: 1, minWidth: 0, display: "grid", gap: spacing.md }}
    >
      {(arrangeError ?? composition.error) !== undefined && (
        <p role="alert">{arrangeError ?? composition.error}</p>
      )}
      {floating ? (
        canvasPlan.slots.map(windowFor)
      ) : (
        <div style={{ display: "grid", gap: spacing.md, minWidth: 0 }}>
          {STACK_ORDER.flatMap((region) => slotsIn(canvasPlan, region)).map((slot) =>
            slot.region === "overlay" && compact ? (
              <div key={slot.surfaceId} style={{ borderTop: `2px solid ${semantic.approval}` }}>
                {frameFor(slot)}
              </div>
            ) : (
              frameFor(slot)
            ),
          )}
        </div>
      )}

      <Overflow
        plan={{
          ...plan,
          overflowSurfaceIds: plan.overflowSurfaceIds.filter((id) => !poppedIds.has(id)),
        }}
        intents={byId}
        composition={composition}
        onClose={close}
      />
      {ownPopouts.map((entry) => {
        const slot = lastSlots.current.get(entry.surfaceId);
        return slot === undefined
          ? null
          : createPortal(frameFor(slot, true), entry.container, entry.surfaceId);
      })}
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
    <details data-panel-overflow style={{ ...glass, padding: spacing.md }}>
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
