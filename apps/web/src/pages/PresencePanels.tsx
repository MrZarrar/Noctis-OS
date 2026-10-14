import { useEffect } from "react";
import { spacing } from "@noctis/ui";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { Workbench } from "../workbench/Workbench.js";
import { useComposition } from "../workbench/useComposition.js";
import type { ThreadPanelsState } from "./ThreadPanels.js";
import type { SurfaceContext } from "../surfaces/renderers.js";

const PRESENCE = { presence: true } as const;

export function usePresencePanels(
  transport: CoreTransport | undefined,
  revision: number,
  renderPage?: SurfaceContext["renderPage"],
): ThreadPanelsState {
  const composition = useComposition(transport, transport === undefined ? undefined : PRESENCE);
  const refresh = composition.refresh;
  useEffect(() => {
    refresh();
  }, [revision, refresh]);
  return {
    sources: [{ owner: "presence", composition }],
    hasPanels:
      (composition.plan?.slots.length ?? 0) + (composition.plan?.overflowSurfaceIds.length ?? 0) >
      0,
    handoffs: renderPage === undefined ? {} : { renderPage },
  };
}

/**
 * The desktop home for Presence panels. They float over the page, so the column
 * only takes room for a focused panel and the overflow list.
 */
export function PresenceSideColumn({ panels }: { panels: ThreadPanelsState }): JSX.Element | null {
  const composition = panels.sources[0]?.composition;
  if (!panels.hasPanels || composition?.plan === undefined) return null;
  return (
    <aside
      aria-label="Presence panels"
      className="thread-panels"
      style={{
        width: composition.focusedSurfaceId === undefined ? undefined : 300,
        flexShrink: 0,
        alignSelf: "flex-start",
        display: "grid",
        gap: spacing.md,
      }}
    >
      <Workbench
        composition={composition}
        updates={composition.updates ?? {}}
        handoffs={panels.handoffs}
      />
    </aside>
  );
}
