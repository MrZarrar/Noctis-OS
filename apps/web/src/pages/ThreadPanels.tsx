import { useEffect } from "react";
import { spacing } from "@noctis/ui";
import {
  DocumentPayloadSchema,
  MediaPayloadSchema,
  VaultRecallPayloadSchema,
  type SurfaceOwner,
} from "@noctis/contracts";
import type { ConversationState } from "../conversation/useConversation.js";
import {
  MarkdownFiles,
  markdownImageUrl,
  type MarkdownImageUrl,
} from "../conversation/MarkdownFiles.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import type { SurfaceContext } from "../surfaces/renderers.js";
import { Workbench } from "../workbench/Workbench.js";
import { useComposition, type CompositionState } from "../workbench/useComposition.js";
import { filesQuery, type FileTarget } from "./files-view.js";
import type { RuntimeRootOption } from "../conversation/useConversation.js";
export interface ThreadPanelSource {
  owner: "thread" | "objective" | "presence";
  composition: CompositionState;
  /** Instead of the shared handoffs, for panels no conversation answers for. */
  handoffs?: SurfaceContext;
}
export interface ThreadPanelsState {
  sources: readonly ThreadPanelSource[];
  hasPanels: boolean;
  handoffs: SurfaceContext;
  imageUrl?: MarkdownImageUrl;
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
  await conversation.send(message, { threadId: current.id });
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
  onOpenInVault?: (entityId: string) => void,
  onOpenFile?: (target: FileTarget<RuntimeRootOption>) => void,
  renderPage?: SurfaceContext["renderPage"],
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
    imageUrl: (path) => markdownImageUrl(path, conversation.roots, transport),
    hasPanels: sources.some(
      (source) =>
        (source.composition.plan?.slots.length ?? 0) +
          (source.composition.plan?.overflowSurfaceIds.length ?? 0) >
        0,
    ),
    handoffs: {
      ...(renderPage === undefined ? {} : { renderPage }),
      ...(transport === undefined ? {} : { fileTransport: transport }),
      ...(onOpenInVault === undefined
        ? {}
        : { onOpenInVault: (evidence) => onOpenInVault(evidence.entityId) }),
      ...(onOpenFile === undefined
        ? {}
        : {
            onOpenFile: (source) => {
              const root = conversation.roots.find(
                (root) => root.nodeId === source.nodeId && root.grantId === source.grantId,
              );
              if (root !== undefined) onOpenFile({ root, relativePath: source.relativePath });
            },
          }),
      panelActionsDisabled: conversation.turns.some(
        (turn) => turn.status === "queued" || turn.status === "running",
      ),
      ...(conversation.error === undefined ? {} : { panelActionsError: conversation.error }),
      onPanelAction: (message, owner) => sendPanelChoice(conversation, message, owner),
      mediaUrl: (source, revision) =>
        source.from === "attachment"
          ? conversation.outputUrl?.(source.attachmentId)
          : transport?.contentUrl?.(
              `/files/content?${filesQuery(source, source.relativePath)}&revision=${encodeURIComponent(revision ?? "")}`,
            ),
      visualUrl: (source, revision) =>
        transport?.contentUrl?.(
          `/visuals/content?${filesQuery(source, source.relativePath)}&revision=${encodeURIComponent(revision ?? "")}`,
        ),
      onConfirm: (id, typed) => {
        void conversation.confirm(id, typed);
      },
      onDecline: (id) => {
        void conversation.decline(id);
      },
    },
  };
}

/** Starting context is read from validated panels and the current thread, never a model page proposal. */
export function pagePanelContext(
  panels: ThreadPanelsState,
  conversation: Pick<ConversationState, "thread" | "roots">,
) {
  const intents = panels.sources
    .flatMap((source) => [...source.composition.intents])
    .filter((intent) => intent.lifecycle !== "dismissed" && intent.lifecycle !== "exiting")
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  const file = intents.flatMap((intent) => {
    const media =
      intent.kind === "media" ? MediaPayloadSchema.safeParse(intent.payload) : undefined;
    const doc =
      intent.kind === "document" ? DocumentPayloadSchema.safeParse(intent.payload) : undefined;
    const source = media?.success ? media.data.source : doc?.success ? doc.data.content : undefined;
    return source?.from === "file" ? [source] : [];
  })[0];
  const root = conversation.roots.find(
    (root) =>
      root.nodeId === conversation.thread?.nodeId &&
      root.grantId === conversation.thread.rootGrantId,
  );
  const recall = intents.flatMap((intent) => {
    const parsed =
      intent.kind === "vault_recall"
        ? VaultRecallPayloadSchema.safeParse(intent.payload)
        : undefined;
    return parsed?.success ? parsed.data.evidence : [];
  })[0];
  return {
    contextFiles:
      root !== undefined
        ? { nodeId: root.nodeId, grantId: root.grantId, relativePath: "" }
        : file === undefined
          ? undefined
          : {
              nodeId: file.nodeId,
              grantId: file.grantId,
              relativePath: file.relativePath.includes("/")
                ? file.relativePath.slice(0, file.relativePath.lastIndexOf("/"))
                : "",
            },
    focusId: recall?.entityId,
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
  if (mobile) {
    const content = (
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
    return <MarkdownFiles.Provider value={panels.imageUrl}>{content}</MarkdownFiles.Provider>;
  }
  const content = (
    <aside
      aria-label="Thread panels"
      className="thread-panels"
      style={{ minWidth: 0, display: "grid", alignContent: "start", gap: spacing.md }}
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
  return <MarkdownFiles.Provider value={panels.imageUrl}>{content}</MarkdownFiles.Provider>;
}
