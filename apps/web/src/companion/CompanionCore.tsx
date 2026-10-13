import type { ConversationalIdentityId, ProtocolId } from "@noctis/contracts";
import {
  IDENTITY_PROFILES,
  IntelligenceRenderer,
  TAB_BAR_HEIGHT,
  elevation,
  material,
  motion,
  semantic,
  spacing,
  typography,
} from "@noctis/ui";
import type { RailItem } from "@noctis/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { intelligenceState } from "../conversation/intelligence-state.js";
import { lastExchange } from "../conversation/last-exchange.js";
import type { ConversationState } from "../conversation/useConversation.js";
import { cornerSize, dockFor } from "./dock.js";

export interface CompanionCoreProps {
  page: RailItem;
  identityId: ConversationalIdentityId;
  protocolIds: readonly ProtocolId[];
  conversation: Pick<ConversationState, "messages" | "turns" | "streaming" | "pendingApprovals">;
  /** From `useComposerFocus`, shared with Presence so its words and the core agree. */
  listening: boolean;
  mobile: boolean;
  onOpenThreads: () => void;
}

interface Place {
  /** Which slot the core is sitting in: the page's own, or the corner. */
  at: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Round and fading, so a square canvas does not show its edges over the page.
const ROUND = "radial-gradient(circle, #000 55%, transparent 71%)";

/** Pages pad their bottom by this, so nothing can scroll to rest under the corner core. */
const CLEARANCE = "--noctis-core-clearance";

/**
 * Whether a composer has the focus, on any page. The textarea is the only one
 * the app has.
 */
export function useComposerFocus(): boolean {
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const focusIn = (event: FocusEvent): void => {
      setFocused(event.target instanceof HTMLTextAreaElement);
    };
    const focusOut = (event: FocusEvent): void => {
      setFocused(event.relatedTarget instanceof HTMLTextAreaElement);
    };
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);
    return () => {
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", focusOut);
    };
  }, []);

  return focused;
}

/**
 * The one intelligence core in the app. It is mounted once, above every page,
 * and flies to wherever the page has kept a place for it — so moving between
 * pages never builds a second WebGL context, and the core the owner was
 * watching is the same one that follows them.
 */
export function CompanionCore({
  page,
  identityId,
  protocolIds,
  conversation,
  listening,
  mobile,
  onOpenThreads,
}: CompanionCoreProps): JSX.Element {
  const state = intelligenceState(conversation, listening);
  const dock = dockFor(page, state, mobile);
  const slots = dock.slots ?? [];
  const target = dock.anchor;
  const slotKey = slots.join();
  const [place, setPlace] = useState<Place>();
  const [moving, setMoving] = useState(false);
  const arrived = useRef<string>();
  const remeasure = useRef<() => void>();
  const size = cornerSize(mobile);
  const gap = mobile ? spacing.md : spacing.xl;

  useLayoutEffect(() => {
    if (target === "hidden") return;

    let observed: Element | null = null;
    const measure = (): void => {
      // A page that is not drawing its slot right now — Threads with the
      // conversation list open has no composer — sends the core to the corner
      // rather than leaving it frozen over whatever replaced the slot.
      const drawn = (selector: string): HTMLElement | undefined =>
        [...document.querySelectorAll<HTMLElement>(selector)].find(
          (element) => element.getClientRects().length > 0,
        );
      const slot =
        slots.map((name) => drawn(`[data-core-slot="${name}"]`)).find(Boolean) ??
        drawn('[data-core-slot="corner"]') ??
        null;
      if (slot !== observed) {
        resizeObserver.disconnect();
        if (slot !== null) {
          resizeObserver.observe(slot);
          if (target !== "corner") {
            for (
              let ancestor = slot.parentElement;
              ancestor !== null && ancestor !== document.body;
              ancestor = ancestor.parentElement
            ) {
              resizeObserver.observe(ancestor);
            }
          }
        }
        observed = slot;
      }
      if (slot === null) return;
      const box = slot.getBoundingClientRect();
      const at = slot.dataset.coreSlot ?? target;
      // Only the trip to a new place is animated. Re-measuring on scroll or
      // resize has to track the slot exactly, or the core lags behind it.
      if (arrived.current !== undefined && arrived.current !== at) setMoving(true);
      arrived.current = at;
      setPlace((previous) =>
        previous !== undefined &&
        previous.at === at &&
        previous.x === box.x &&
        previous.y === box.y &&
        previous.width === box.width &&
        previous.height === box.height
          ? previous
          : { at, x: box.x, y: box.y, width: box.width, height: box.height },
      );
    };
    remeasure.current = measure;
    const resizeObserver = new ResizeObserver(measure);
    // A page can draw its slot a beat after it mounts, or take it away. The
    // corner draws its own, so it has nothing to watch for.
    const mutationObserver = target === "corner" ? undefined : new MutationObserver(measure);
    mutationObserver?.observe(document.body, { childList: true, subtree: true });
    addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    measure();
    return () => {
      remeasure.current = undefined;
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
      removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [slotKey, target, page]);

  // A move that changes nothing on screen never ends in a transitionend.
  useEffect(() => {
    if (!moving) return;
    const timer = window.setTimeout(() => {
      setMoving(false);
    }, motion.durationMs.slow + 100);
    return () => {
      window.clearTimeout(timer);
    };
  }, [moving, place]);

  const shown = target !== "hidden" && place !== undefined;
  const corner = shown && place.at === "corner";

  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      CLEARANCE,
      corner ? `${String(size + gap)}px` : "0px",
    );
    remeasure.current?.();
    return () => {
      document.documentElement.style.removeProperty(CLEARANCE);
    };
  }, [corner, size, gap, target, page]);

  const name =
    IDENTITY_PROFILES.find((profile) => profile.id === identityId)?.displayName ?? identityId;
  const reply =
    state === "thinking" || state === "speaking"
      ? (lastExchange(conversation)?.reply.split("\n")[0]?.trim() ?? "")
      : "";
  const caption =
    state === "waiting_for_approval"
      ? `${name}: needs your approval`
      : state === "thinking" || state === "speaking"
        ? `${name}: ${reply === "" ? "thinking…" : reply}`
        : undefined;
  const transition = moving
    ? ["transform", "width", "height"]
        .map(
          (property) => `${property} ${String(motion.durationMs.slow)}ms ${motion.easing.standard}`,
        )
        .join(", ")
    : "none";

  return (
    <>
      {target !== "hidden" && (
        <div
          aria-hidden="true"
          data-core-slot="corner"
          style={{
            position: "fixed",
            right: `calc(${String(spacing.lg)}px + env(safe-area-inset-right))`,
            bottom: `calc(${String((mobile ? TAB_BAR_HEIGHT : 0) + gap)}px + env(safe-area-inset-bottom))`,
            width: size,
            height: size,
            pointerEvents: "none",
            visibility: "hidden",
          }}
        />
      )}
      <div
        data-core-dock={place?.at ?? target}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "transform") {
            setMoving(false);
          }
        }}
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          // Over the page and its sticky composer, under the rail, the phone's
          // header and tab bar, and every sheet.
          zIndex: elevation.rail - 1,
          display: shown ? "block" : "none",
          width: place?.width ?? 0,
          height: place?.height ?? 0,
          transform: `translate(${String(place?.x ?? 0)}px, ${String(place?.y ?? 0)}px)`,
          transition,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            ...(place?.at === "hero" ? {} : { maskImage: ROUND, WebkitMaskImage: ROUND }),
          }}
        >
          <IntelligenceRenderer identityId={identityId} protocolIds={protocolIds} state={state} />
        </div>
        {corner && (
          <button
            type="button"
            aria-label={page === "Threads" ? "Back to the conversation" : "Open Threads"}
            onClick={onOpenThreads}
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "auto",
              background: "transparent",
              border: "none",
              borderRadius: "50%",
              cursor: "pointer",
            }}
          />
        )}
        {corner && caption !== undefined && (
          <p
            style={{
              position: "absolute",
              right: "100%",
              top: "50%",
              transform: "translateY(-50%)",
              margin: 0,
              maxWidth: `min(320px, calc(100vw - ${String(size + spacing.xxxl)}px))`,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
              borderRadius: 999,
              border: `1px solid ${material.border}`,
              background: "rgba(5, 4, 9, 0.6)",
              backdropFilter: `blur(${String(material.blurPx)}px)`,
              WebkitBackdropFilter: `blur(${String(material.blurPx)}px)`,
              color:
                state === "waiting_for_approval" ? semantic.approval : typography.color.primary,
              font: `${String(typography.scale.sm)}px ${typography.family}`,
            }}
          >
            {caption}
          </p>
        )}
      </div>
    </>
  );
}
