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
import { dockFor } from "./dock.js";

export interface CompanionCoreProps {
  page: RailItem;
  identityId: ConversationalIdentityId;
  protocolIds: readonly ProtocolId[];
  conversation: Pick<ConversationState, "messages" | "turns" | "streaming" | "pendingApprovals">;
  mobile: boolean;
  onOpenThreads: () => void;
}

interface Place {
  x: number;
  y: number;
  width: number;
  height: number;
  moving: boolean;
}

// Round and fading, so a square canvas does not show its edges over the page.
const ROUND = "radial-gradient(circle, #000 55%, transparent 71%)";

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
  mobile,
  onOpenThreads,
}: CompanionCoreProps): JSX.Element {
  const [listening, setListening] = useState(false);
  const state = intelligenceState(conversation, listening);
  const dock = dockFor(page, state, mobile);
  const target = dock.anchor === "slot" ? dock.slot : dock.anchor;
  const [place, setPlace] = useState<Place>();
  const arrived = useRef<string>();

  // Any composer, on any page: the textarea is the only one the app has.
  useEffect(() => {
    const focusIn = (event: FocusEvent): void => {
      setListening(event.target instanceof HTMLTextAreaElement);
    };
    const focusOut = (event: FocusEvent): void => {
      setListening(event.relatedTarget instanceof HTMLTextAreaElement);
    };
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);
    return () => {
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", focusOut);
    };
  }, []);

  useLayoutEffect(() => {
    if (target === "hidden") return;

    // Only the trip to a new place is animated. Re-measuring on scroll or
    // resize has to track the slot exactly, or the core lags behind it.
    const from = arrived.current;
    const movedAt = performance.now();
    let observed: Element | null = null;
    const measure = (): void => {
      const slot = document.querySelector(`[data-core-slot="${target}"]`);
      if (slot !== observed) {
        if (observed !== null) resizeObserver.unobserve(observed);
        if (slot !== null) resizeObserver.observe(slot);
        observed = slot;
      }
      if (slot === null) return;
      const box = slot.getBoundingClientRect();
      const next = {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        moving:
          from !== undefined &&
          from !== target &&
          performance.now() - movedAt < motion.durationMs.slow,
      };
      arrived.current = target;
      setPlace((previous) =>
        previous !== undefined &&
        previous.x === next.x &&
        previous.y === next.y &&
        previous.width === next.width &&
        previous.height === next.height &&
        previous.moving === next.moving
          ? previous
          : next,
      );
    };
    const resizeObserver = new ResizeObserver(measure);
    // A page can draw its slot a beat after it mounts, or redraw it.
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    measure();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [target, page]);

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
  const corner = dock.anchor === "corner";
  const transition = place?.moving
    ? ["transform", "width", "height"]
        .map(
          (property) => `${property} ${String(motion.durationMs.slow)}ms ${motion.easing.standard}`,
        )
        .join(", ")
    : "none";

  return (
    <>
      {corner && (
        <div
          aria-hidden="true"
          data-core-slot="corner"
          style={{
            position: "fixed",
            right: `calc(${String(spacing.lg)}px + env(safe-area-inset-right))`,
            bottom: mobile
              ? `calc(${String(TAB_BAR_HEIGHT + spacing.md)}px + env(safe-area-inset-bottom))`
              : `calc(${String(spacing.xl)}px + env(safe-area-inset-bottom))`,
            width: dock.size,
            height: dock.size,
            pointerEvents: "none",
            visibility: "hidden",
          }}
        />
      )}
      <div
        data-core-dock={target}
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          zIndex: elevation.surface,
          display: dock.anchor === "hidden" || place === undefined ? "none" : "block",
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
            ...(dock.slot === "hero" ? {} : { maskImage: ROUND, WebkitMaskImage: ROUND }),
          }}
        >
          <IntelligenceRenderer identityId={identityId} protocolIds={protocolIds} state={state} />
        </div>
        {corner && (
          <button
            type="button"
            aria-label="Open Threads"
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
              maxWidth: `min(320px, calc(100vw - ${String(dock.size + spacing.xxxl)}px))`,
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
