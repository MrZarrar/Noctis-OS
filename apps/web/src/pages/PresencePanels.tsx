import { useEffect } from "react";
import { spacing } from "@noctis/ui";
import { MarkdownFiles } from "../conversation/MarkdownFiles.js";
import type { ConversationState } from "../conversation/useConversation.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { Workbench } from "../workbench/Workbench.js";
import { useComposition } from "../workbench/useComposition.js";
import { useThreadPanels, type ThreadPanelsState } from "./ThreadPanels.js";
import type { SurfaceContext } from "../surfaces/renderers.js";

const PRESENCE = { presence: true } as const;

/**
 * Presence's own panels, and the ones the chat's turns open: those belong to
 * the chat's thread, and the owner is here, not in Threads, when they arrive.
 */
export function usePresencePanels(
  transport: CoreTransport | undefined,
  conversation: ConversationState,
  renderPage?: SurfaceContext["renderPage"],
): ThreadPanelsState {
  const composition = useComposition(transport, transport === undefined ? undefined : PRESENCE);
  const refresh = composition.refresh;
  useEffect(() => {
    refresh();
  }, [conversation.presencePanelsRevision, refresh]);
  const thread = useThreadPanels(transport, conversation, undefined, undefined, renderPage);
  return {
    ...thread,
    sources: [
      {
        owner: "presence",
        composition,
        // No conversation answers a Presence panel's choices.
        handoffs: renderPage === undefined ? {} : { renderPage },
      },
      ...thread.sources,
    ],
    hasPanels:
      thread.hasPanels ||
      (composition.plan?.slots.length ?? 0) + (composition.plan?.overflowSurfaceIds.length ?? 0) >
        0,
  };
}

/**
 * The desktop home for Presence panels. They float over the page, so the column
 * only takes room for a focused panel and the overflow list.
 */
export function PresenceSideColumn({ panels }: { panels: ThreadPanelsState }): JSX.Element | null {
  const focused = panels.sources.find(
    (source) => source.composition.focusedSurfaceId !== undefined,
  );
  const shown = panels.sources.filter(
    (source) =>
      source.composition.plan !== undefined && (focused === undefined || source === focused),
  );
  if (!panels.hasPanels || shown.length === 0) return null;
  return (
    <MarkdownFiles.Provider value={panels.imageUrl}>
      <aside
        aria-label="Presence panels"
        className="thread-panels"
        style={{
          width: focused === undefined ? undefined : 300,
          flexShrink: 0,
          alignSelf: "flex-start",
          display: "grid",
          gap: spacing.md,
        }}
      >
        {shown.map((source) => (
          <Workbench
            key={source.owner}
            composition={source.composition}
            updates={source.composition.updates ?? {}}
            handoffs={source.handoffs ?? panels.handoffs}
          />
        ))}
      </aside>
    </MarkdownFiles.Provider>
  );
}
