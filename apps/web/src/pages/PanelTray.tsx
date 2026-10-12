import { useEffect, useRef, useState } from "react";
import { MediaPayloadSchema } from "@noctis/contracts";
import { spacing } from "@noctis/ui";
import { buttonStyle, glass } from "../layout/Page.js";
import { useBackLayer } from "../navigation/back.js";
import { resolveSurface } from "../surfaces/registry.js";
import { Workbench } from "../workbench/Workbench.js";
import type { ThreadPanelsState } from "./ThreadPanels.js";

export function usePanelSheet(panels: ThreadPanelsState) {
  const [overflow, setOverflow] = useState(false);
  const trigger = useRef<HTMLElement>();
  const root = useRef<HTMLElement>(null);
  const focused = panels.sources.find(
    (source) => source.composition.focusedSurfaceId !== undefined,
  );
  const open = focused !== undefined || overflow;
  const closing = useRef(false);
  const layer = useBackLayer("panel", open, () => {
    // A successful Close lands here only after the sheet is already shut; Back
    // or Leave focus land here while it is still open, which means any earlier
    // Close was refused and the opening chip is still the right place to return.
    if (open) closing.current = false;
    panels.sources.forEach((source) => source.composition.focus(undefined));
    setOverflow(false);
  });
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && root.current !== null) {
      const page = root.current.closest<HTMLElement>('section[aria-label="Threads"]');
      if (page !== null) page.scrollTop = 0;
      // Presence keeps its sheet below the core, so it is brought up to meet the owner.
      else root.current.scrollIntoView({ block: "start" });
      root.current.focus({ preventScroll: true });
    } else if (wasOpen.current) {
      const target = closing.current ? undefined : trigger.current;
      if (target?.isConnected && target.checkVisibility()) target.focus();
      else document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      closing.current = false;
    }
    // Desktop focuses panels in place with no sheet, so there is nothing to hand focus back from.
    wasOpen.current = open && root.current !== null;
  }, [open, focused?.composition.focusedSurfaceId]);
  useEffect(() => {
    if (!open || root.current === null) return;
    const contain = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const column = root.current?.closest("[data-conversation-column]");
      const controls = Array.from(
        column?.querySelectorAll<HTMLElement>(
          '[aria-label="Panel sheet"] button, [data-panel-composer] button, [data-panel-composer] textarea, [data-panel-composer] input, [data-panel-composer] [tabindex="0"]',
        ) ?? [],
      ).filter((node) => node.checkVisibility() && !node.hasAttribute("disabled"));
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (
        controls.length &&
        (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1))
      ) {
        event.preventDefault();
        controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
      }
    };
    document.addEventListener("keydown", contain);
    return () => document.removeEventListener("keydown", contain);
  }, [open]);
  return {
    open,
    overflow,
    focused,
    root,
    dismiss: layer.dismiss,
    prepareClose() {
      closing.current = true;
    },
    show(source: ThreadPanelsState["sources"][number], id: string, button: HTMLElement) {
      closing.current = false;
      if (!open) trigger.current = button;
      setOverflow(false);
      source.composition.focus(id);
      layer.pushed();
    },
    showOverflow(button: HTMLElement) {
      trigger.current = button;
      panels.sources.forEach((source) => source.composition.focus(undefined));
      setOverflow(true);
      layer.pushed();
    },
  };
}
export type PanelSheetState = ReturnType<typeof usePanelSheet>;

function entries(panels: ThreadPanelsState) {
  return panels.sources.flatMap((source) => {
    const plan = source.composition.plan;
    return [
      ...(plan?.slots.filter((slot) => slot.region !== "overlay").map((slot) => slot.surfaceId) ??
        []),
      ...(plan?.overflowSurfaceIds ?? []),
    ].flatMap((id) => {
      const intent = source.composition.intents.find((intent) => intent.id === id);
      if (!intent) return [];
      const resolved = resolveSurface(
        intent.kind,
        intent.payloadVersion,
        intent.payload,
        "compact",
        [],
      );
      const media =
        intent.kind === "media" ? MediaPayloadSchema.safeParse(intent.payload) : undefined;
      const thumbnail =
        media?.success && media.data.mediaType.startsWith("image/")
          ? panels.handoffs.mediaUrl?.(media.data.source)
          : undefined;
      return [
        {
          thumbnail,
          source,
          id,
          title: resolved.status === "ok" ? resolved.title : intent.kind,
          overflow: plan?.overflowSurfaceIds.includes(id) ?? false,
        },
      ];
    });
  });
}
export function PanelTray({
  panels,
  sheet,
}: {
  panels: ThreadPanelsState;
  sheet: PanelSheetState;
}): JSX.Element | null {
  const all = entries(panels);
  if (!all.length) return null;
  const overflow = all.filter((entry) => entry.overflow);
  return (
    <nav
      aria-label="Panel tray"
      style={{
        display: "flex",
        gap: spacing.xs,
        overflowX: "auto",
        scrollSnapType: "x mandatory",
        minWidth: 0,
        marginBottom: spacing.sm,
      }}
    >
      {all
        .filter((entry) => !entry.overflow)
        .map((entry) => (
          <button
            key={`${entry.source.owner}:${entry.id}`}
            type="button"
            aria-label={`Open panel ${entry.title}`}
            data-panel-owner={entry.source.owner}
            data-panel-id={entry.id}
            onClick={(event) => sheet.show(entry.source, entry.id, event.currentTarget)}
            style={{
              ...buttonStyle,
              ...glass,
              flexShrink: 0,
              scrollSnapAlign: "start",
              minWidth: 44,
              maxWidth: 160,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entry.thumbnail !== undefined && (
              <img
                src={entry.thumbnail}
                alt=""
                style={{
                  width: 36,
                  height: 36,
                  objectFit: "cover",
                  verticalAlign: "middle",
                  marginRight: spacing.xs,
                }}
              />
            )}
            {entry.title}
          </button>
        ))}
      {overflow.length > 0 && (
        <button
          type="button"
          aria-label={`Show ${overflow.length} more panels`}
          style={{ ...buttonStyle, flexShrink: 0 }}
          onClick={(event) => sheet.showOverflow(event.currentTarget)}
        >
          +{overflow.length}
        </button>
      )}
    </nav>
  );
}
export function PanelSheet({
  panels,
  sheet,
}: {
  panels: ThreadPanelsState;
  sheet: PanelSheetState;
}): JSX.Element | null {
  if (!sheet.open) return null;
  const focused = sheet.focused;
  const composition = focused?.composition;
  return (
    <section
      ref={sheet.root}
      tabIndex={-1}
      aria-label="Panel sheet"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          sheet.dismiss();
        }
      }}
      style={{
        ...glass,
        minWidth: 0,
        height: "55dvh",
        overflowY: "auto",
        padding: spacing.sm,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {sheet.overflow ? (
        <>
          <button type="button" style={buttonStyle} onClick={sheet.dismiss}>
            Leave panels
          </button>
          <ul aria-label="More panels" style={{ listStyle: "none", padding: 0 }}>
            {entries(panels)
              .filter((entry) => entry.overflow)
              .map((entry) => (
                <li key={`${entry.source.owner}:${entry.id}`}>
                  <button
                    type="button"
                    data-panel-owner={entry.source.owner}
                    data-panel-id={entry.id}
                    style={buttonStyle}
                    onClick={(event) => sheet.show(entry.source, entry.id, event.currentTarget)}
                  >
                    Open panel {entry.title}
                  </button>
                </li>
              ))}
          </ul>
        </>
      ) : (
        composition !== undefined && (
          <Workbench
            composition={{
              ...composition,
              plan:
                composition.plan === undefined
                  ? undefined
                  : {
                      ...composition.plan,
                      slots: composition.plan.slots.filter(
                        (slot) => slot.surfaceId === composition.focusedSurfaceId,
                      ),
                      overflowSurfaceIds: [],
                    },
              focus: (id) => {
                if (id === undefined) sheet.dismiss();
                else composition.focus(id);
              },
              dismiss: async (id) => {
                sheet.prepareClose();
                await composition.dismiss(id);
              },
            }}
            updates={composition.updates ?? {}}
            handoffs={panels.handoffs}
          />
        )
      )}
    </section>
  );
}
