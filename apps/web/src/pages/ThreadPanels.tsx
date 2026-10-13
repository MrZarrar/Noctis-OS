import type { CSSProperties } from "react";
import { useEffect } from "react";
import { motion, spacing } from "@noctis/ui";
import type { SurfaceOwner } from "@noctis/contracts";
import type { ConversationState } from "../conversation/useConversation.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import type { SurfaceContext } from "../surfaces/renderers.js";
import { Workbench } from "../workbench/Workbench.js";
import { useComposition, type CompositionState } from "../workbench/useComposition.js";
export interface ThreadPanelSource {
  owner: "thread" | "objective" | "presence";
  composition: CompositionState;
}
export interface ThreadPanelsState {
  sources: readonly ThreadPanelSource[];
  hasPanels: boolean;
  handoffs: SurfaceContext;
}

export async function sendPanelChoice(
  conversation: ConversationState,
  message: string,
  owner: SurfaceOwner,
): Promise<void> {
  const current = conversation.thread;
  if (
    current === undefined ||
    (owner.threadId !== undefined
      ? owner.threadId !== current.id
      : owner.objectiveId === undefined || owner.objectiveId !== current.objectiveId)
  ) {
    throw new Error("Open the panel's conversation to send this choice.");
  }
  await conversation.send(message);
}
export function panelsForOwner(
  source: CompositionState,
  owner: ThreadPanelSource["owner"],
): CompositionState {
  const ids = new Set(
    source.intents
      .filter((intent) => owner !== "objective" || intent.kind !== "conversation")
      .map((intent) => intent.id),
  );
  return {
    ...source,
    plan:
      source.plan === undefined
        ? undefined
        : {
            ...source.plan,
            slots: source.plan.slots.filter((slot) => ids.has(slot.surfaceId)),
            overflowSurfaceIds: source.plan.overflowSurfaceIds.filter((id) => ids.has(id)),
          },
  };
}

export function useThreadPanels(
  transport: CoreTransport | undefined,
  conversation: ConversationState,
): ThreadPanelsState {
  const thread = useComposition(
    transport,
    conversation.thread === undefined ? undefined : { threadId: conversation.thread.id },
  );
  const objective = useComposition(
    transport,
    conversation.thread?.objectiveId === undefined
      ? undefined
      : { objectiveId: conversation.thread.objectiveId },
  );
  const refreshThread = thread.refresh;
  const refreshObjective = objective.refresh;
  useEffect(() => {
    refreshThread();
    refreshObjective();
  }, [conversation.panelsRevision, refreshThread, refreshObjective]);
  const sources: ThreadPanelSource[] = [
    {
      owner: "thread",
      composition: {
        ...panelsForOwner(thread, "thread"),
        focus: (id) => {
          if (id !== undefined) objective.focus(undefined);
          thread.focus(id);
        },
      },
    },
    {
      owner: "objective",
      composition: {
        ...panelsForOwner(objective, "objective"),
        focus: (id) => {
          if (id !== undefined) thread.focus(undefined);
          objective.focus(id);
        },
      },
    },
  ];

  return {
    sources,
    hasPanels: sources.some(
      (source) =>
        (source.composition.plan?.slots.length ?? 0) +
          (source.composition.plan?.overflowSurfaceIds.length ?? 0) >
        0,
    ),
    handoffs: {
      panelActionsDisabled: conversation.turns.some(
        (turn) => turn.status === "queued" || turn.status === "running",
      ),
      ...(conversation.error === undefined ? {} : { panelActionsError: conversation.error }),
      onPanelAction: (message, owner) => sendPanelChoice(conversation, message, owner),
      mediaUrl: (source) =>
        source.from === "attachment" ? conversation.outputUrl?.(source.attachmentId) : undefined,
      onConfirm: (id, typed) => {
        void conversation.confirm(id, typed);
      },
      onDecline: (id) => {
        void conversation.decline(id);
      },
    },
  };
}
export function ThreadPanels({
  panels,
  mobile,
}: {
  panels: ThreadPanelsState;
  mobile: boolean;
}): JSX.Element | null {
  if (!panels.hasPanels) return null;
  if (mobile)
    return (
      <aside aria-label="Panel attention">
        {panels.sources
          .filter((source) =>
            source.composition.plan?.slots.some((slot) => slot.region === "overlay"),
          )
          .map((source) => (
            <Workbench
              key={source.owner}
              composition={{
                ...source.composition,
                plan:
                  source.composition.plan === undefined
                    ? undefined
                    : {
                        ...source.composition.plan,
                        slots: source.composition.plan.slots.filter(
                          (slot) => slot.region === "overlay",
                        ),
                        overflowSurfaceIds: [],
                      },
              }}
              updates={source.composition.updates ?? {}}
              handoffs={panels.handoffs}
            />
          ))}
      </aside>
    );
  return (
    <aside
      aria-label="Thread panels"
      className="thread-panels"
      style={
        {
          minWidth: 0,
          display: "grid",
          alignContent: "start",
          gap: spacing.md,
          "--panel-enter-duration": `${motion.durationMs.normal}ms`,
          "--panel-enter-easing": motion.easing.standard,
        } as CSSProperties
      }
    >
      {panels.sources
        .filter(
          (source) =>
            !panels.sources.some(
              (candidate) => candidate.composition.focusedSurfaceId !== undefined,
            ) || source.composition.focusedSurfaceId !== undefined,
        )
        .filter((source) => source.composition.plan !== undefined)
        .map((source) => (
          <Workbench
            key={source.owner}
            composition={source.composition}
            updates={source.composition.updates ?? {}}
            handoffs={panels.handoffs}
          />
        ))}
    </aside>
  );
}
