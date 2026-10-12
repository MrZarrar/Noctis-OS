import { useEffect } from "react";
import { spacing } from "@noctis/ui";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { Workbench } from "../workbench/Workbench.js";
import { useComposition } from "../workbench/useComposition.js";
import type { ThreadPanelsState } from "./ThreadPanels.js";

const PRESENCE = { presence: true } as const;

export function usePresencePanels(
  transport: CoreTransport | undefined,
  revision: number,
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
    handoffs: {},
  };
}

/** The desktop side column: every Presence panel stacked, whatever region the plan gave it. */
export function PresenceSideColumn({ panels }: { panels: ThreadPanelsState }): JSX.Element | null {
  const composition = panels.sources[0]?.composition;
  if (!panels.hasPanels || composition?.plan === undefined) return null;
  return (
    <aside
      aria-label="Presence panels"
      className="thread-panels"
      style={{
        width: 300,
        flexShrink: 0,
        alignSelf: "flex-start",
        display: "grid",
        gap: spacing.md,
      }}
    >
      <Workbench
        composition={{
          ...composition,
          plan: {
            ...composition.plan,
            // The column is phone-narrow with one region, so it gets the phone's controls:
            // Place would have nowhere else to go.
            reasonCodes: [...new Set([...composition.plan.reasonCodes, "display.compact"])],
            slots: composition.plan.slots.map((slot) => ({ ...slot, region: "centre" })),
          },
        }}
        updates={composition.updates ?? {}}
        handoffs={panels.handoffs}
      />
    </aside>
  );
}
