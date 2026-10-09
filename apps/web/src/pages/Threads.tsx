import type { ConversationalIdentityId, RuntimeItem } from "@noctis/contracts";
import {
  ApprovalSurface,
  IDENTITY_PROFILES,
  IntelligenceRenderer,
  corner,
  depth,
  identityAccent,
  material,
  semantic,
  spacing,
  typography,
} from "@noctis/ui";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";

import { PromptForm, modelLabel } from "../conversation/PromptForm.js";
import { intelligenceState } from "../conversation/intelligence-state.js";
import type {
  ConversationState,
  RuntimeRootOption,
  Turn,
} from "../conversation/useConversation.js";
import { Page, buttonStyle, glass } from "../layout/Page.js";
import { useBackLayer } from "../navigation/back.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { BeforeNoctis } from "./BeforeNoctis.js";
import { Conversations } from "./Conversations.js";
import { conversationLabel, pinnedTo } from "./conversations-view.js";
import type { FileTarget } from "./files-view.js";
import { locateInRoots } from "./files-view.js";

/** How near the end still counts as being at it: a thumb rarely lands on the last pixel. */
const FOLLOW_SLACK_PX = 80;

/** The box a page scrolls in: the nearest ancestor that scrolls. */
function scrollerOf(element: HTMLElement | null): HTMLElement | undefined {
  for (let box = element?.parentElement; box != null; box = box.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(box).overflowY)) {
      return box;
    }
  }

  return undefined;
}

export interface ThreadsProps {
  identityId: ConversationalIdentityId;
  conversation: ConversationState;
  /** Absent in a browser with no core configured; the prompt is then disabled. */
  connected: boolean;
  /**
   * Whether the free thread is showing instead of the active Objective's.
   * Both absent means there is no active Objective, so there is nothing to
   * switch between and no control is drawn.
   */
  freeThread?: boolean;
  onUseFreeThread?: (free: boolean) => void;
  /** Switches between Vesper and Jester from the composer. */
  onSwitchIdentity?: (identityId: ConversationalIdentityId) => void;
  /** Opens a thread an agent delegated to, or (undefined) goes back to the identity's own. */
  onOpenThread?: (threadId: string | undefined) => void;
  /** Opens a file a turn wrote in Files. Absent, the files are listed but not offered. */
  onOpenFile?: (target: FileTarget<RuntimeRootOption>) => void;
  /** For the conversation list. Absent, there is no list to open. */
  transport?: CoreTransport | undefined;
}

/**
 * The files a turn wrote that Files can open: inside a folder its PC shares,
 * once each, in the order they were written.
 */
function writtenFiles(
  turn: Turn,
  roots: readonly RuntimeRootOption[],
): Array<FileTarget<RuntimeRootOption>> {
  const nodeId = turn.nodeId;

  if (nodeId === undefined) {
    return [];
  }

  const seen = new Set<string>();

  return turn.items
    .flatMap((item) =>
      item.kind === "file_change" && item.status === "completed" ? item.paths : [],
    )
    .flatMap((path) => {
      const target = locateInRoots(path, nodeId, roots);
      const key = target === undefined ? "" : `${target.root.grantId}:${target.relativePath}`;

      if (target === undefined || seen.has(key)) {
        return [];
      }

      seen.add(key);
      return [target];
    });
}

const listStyle = { listStyle: "none", margin: 0, padding: 0, display: "grid" } as const;

const mono = {
  fontFamily: typography.monoFamily,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
} as const;

/** Read by a screen reader, so "You: hello" is announced as one sentence. */
const spoken = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

/**
 * One thing the runtime did, in a line. Text says what happened; nothing is
 * inferred. Exported because Missions shows the same items outside the
 * conversation, and two renderings of an item would eventually disagree.
 */
export function ItemRow({
  item,
  outputUrl,
}: {
  item: RuntimeItem;
  outputUrl?: ((attachmentId: string) => string) | undefined;
}): JSX.Element {
  switch (item.kind) {
    case "agent_message":
      // The committed message lists itself under Messages; here only its status.
      return <span>message · {item.status}</span>;
    case "command":
      return (
        <span>
          command · {item.status} · <code style={mono}>{item.command}</code>
          {item.output !== undefined && (
            <>
              {" → "}
              <code style={mono}>{item.output}</code>
            </>
          )}
          {item.exitCode !== undefined && ` (exit ${String(item.exitCode)})`}
        </span>
      );
    case "file_change":
      return (
        <span>
          file change · {item.status} · {item.paths.join(", ")}
          {item.summary === undefined ? "" : ` — ${item.summary}`}
        </span>
      );
    case "tool_call":
      return (
        <span>
          tool · {item.status} · {item.tool}
          {item.output !== undefined && (
            <>
              {" → "}
              <code style={mono}>{item.output}</code>
            </>
          )}
        </span>
      );
    case "proposal":
      return (
        <span>
          proposal · {item.status} · {item.proposal.kind}
          {item.proposal.kind === "objective"
            ? `: ${item.proposal.title}`
            : item.proposal.kind === "preference"
              ? `: ${item.proposal.bullet}`
              : `: ${item.proposal.surfaceKind}`}
        </span>
      );
    case "sub_agent":
      return (
        <span>
          sub-agent · {item.status} · {item.label}
        </span>
      );
    case "output":
      return (
        <span style={{ display: "grid", gap: spacing.xs }}>
          <span>
            output · {item.mediaType}
            {item.path === undefined ? "" : ` · ${item.path}`}
          </span>
          {item.attachmentId !== undefined && outputUrl !== undefined && (
            <a href={outputUrl(item.attachmentId)} target="_blank" rel="noreferrer">
              {item.mediaType.startsWith("image/") ? (
                <img
                  src={outputUrl(item.attachmentId)}
                  alt={item.path ?? "generated image"}
                  loading="lazy"
                  style={{ maxWidth: "100%", maxHeight: 480, borderRadius: corner.sm }}
                />
              ) : (
                `Open or download ${item.path ?? "output"}`
              )}
            </a>
          )}
        </span>
      );
  }
}

function TurnRow({
  turn,
  onCancel,
  outputUrl,
  written,
  onOpenFile,
}: {
  turn: Turn;
  onCancel: () => void;
  outputUrl: ((attachmentId: string) => string) | undefined;
  written: ReadonlyArray<FileTarget<RuntimeRootOption>>;
  onOpenFile: ((target: FileTarget<RuntimeRootOption>) => void) | undefined;
}): JSX.Element {
  const running = turn.status === "queued" || turn.status === "running";
  const outputs = turn.items.filter((item) => item.kind === "output");
  const rawItems = turn.items.filter((item) => item.kind !== "output");

  return (
    <li
      data-entry="turn"
      data-turn-status={turn.status}
      style={{
        border: `1px solid ${material.border}`,
        borderLeft: `2px solid ${running ? identityAccent.vesper.primary : material.highlight}`,
        borderRadius: corner.md,
        padding: `${String(spacing.sm)}px ${String(spacing.md)}px`,
        display: "grid",
        gap: spacing.xs,
        minWidth: 0,
        background: material.fill,
        font: `${String(typography.scale.xs)}px/1.5 ${typography.family}`,
        color: typography.color.muted,
      }}
    >
      <p
        style={{
          margin: 0,
          display: "flex",
          flexWrap: "wrap",
          gap: spacing.sm,
          alignItems: "center",
        }}
      >
        <span style={{ color: typography.color.muted, minWidth: 0 }}>
          {turn.status === "queued"
            ? "Waiting to start"
            : turn.status === "running"
              ? "Working"
              : turn.status === "completed"
                ? "Finished"
                : turn.status === "failed"
                  ? "Failed"
                  : "Cancelled"}
          {turn.failureReason === undefined ? "" : ` — ${turn.failureReason}`}
        </span>
        <span style={{ flex: 1 }} />
        {running && turn.jobId !== undefined && (
          <button type="button" onClick={onCancel} style={buttonStyle}>
            Cancel
          </button>
        )}
      </p>
      {outputs.length > 0 && (
        <ul aria-label="Outputs" style={{ ...listStyle, gap: spacing.xs, minWidth: 0 }}>
          {outputs.map((item) => (
            <li key={item.itemId} data-item-kind={item.kind} data-item-status={item.status}>
              <ItemRow item={item} outputUrl={outputUrl} />
            </li>
          ))}
        </ul>
      )}
      {written.length > 0 && onOpenFile !== undefined && (
        <ul
          aria-label="Files written"
          style={{ ...listStyle, gap: spacing.xs, minWidth: 0, gridAutoFlow: "row" }}
        >
          {written.map((target) => (
            <li key={`${target.root.grantId}:${target.relativePath}`}>
              <button
                type="button"
                title={target.relativePath}
                onClick={() => onOpenFile(target)}
                style={{
                  ...buttonStyle,
                  maxWidth: "100%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                Open {target.relativePath.split("/").at(-1)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <details style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <summary style={{ minHeight: 44, lineHeight: "44px", cursor: "pointer" }}>Details</summary>
        <p style={{ margin: 0 }}>{modelLabel(turn.model)}</p>
        {rawItems.length > 0 && (
          <ul aria-label="Turn items" style={{ ...listStyle, gap: spacing.xs, minWidth: 0 }}>
            {rawItems.map((item) => (
              <li key={item.itemId} data-item-kind={item.kind} data-item-status={item.status}>
                <ItemRow item={item} outputUrl={outputUrl} />
              </li>
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}

type Message = ConversationState["messages"][number];
type Approval = ConversationState["pendingApprovals"][number];

type Entry =
  | { kind: "message"; at: string; message: Message }
  | { kind: "turn"; at: string; turn: Turn }
  | { kind: "approval"; at: string; approval: Approval };

/**
 * One conversation in the order it happened.
 *
 * Messages, turns and approvals were three stacked lists, so the newest reply
 * sat at the top of the page and a turn's raw command output sat at the bottom
 * beside the prompt box — the first live run made that unreadable within three
 * exchanges. Merging on timestamp puts each turn's work between the question
 * that caused it and the answer it produced, and puts the newest thing nearest
 * the input, which is where a conversation belongs.
 */
function timelineOf(
  messages: readonly Message[],
  turns: readonly Turn[],
  approvals: readonly Approval[],
): Entry[] {
  return [
    ...messages.map((message): Entry => ({ kind: "message", at: message.createdAt, message })),
    ...turns.map((turn): Entry => ({ kind: "turn", at: turn.startedAt, turn })),
    ...approvals.map((approval): Entry => ({
      kind: "approval",
      at: approval.requestedAt,
      approval,
    })),
  ].sort((left, right) => left.at.localeCompare(right.at));
}

/**
 * Threads: the identity's thread — free chat, or the active Objective's (0.12).
 *
 * Everything shown is read from the core except the streamed text, which lives
 * only until the message it was streaming commits. Approval cards are the same
 * Surface the canvas uses, so a typed phrase is typed here too.
 */
export function Threads({
  identityId,
  conversation,
  connected,
  freeThread,
  onUseFreeThread,
  onSwitchIdentity,
  onOpenThread,
  onOpenFile,
  transport,
}: ThreadsProps): JSX.Element {
  const [listing, setListing] = useState(false);
  const list = useBackLayer("conversations", listing, () => {
    setListing(false);
  });
  const {
    thread,
    messages,
    turns,
    streaming,
    pendingApprovals,
    models,
    defaultModel,
    children,
    outputUrl,
    error,
  } = conversation;
  const delegated = thread?.parentThreadId !== undefined;
  const end = useRef<HTMLDivElement>(null);
  const streamedLength = [...streaming.values()].reduce((total, text) => total + text.length, 0);

  /**
   * The page follows the conversation as it grows: on a phone the newest entry
   * is otherwise under the composer, and the reply arrives where nobody is
   * looking. An owner who has scrolled up to read is left where they are. The
   * test is whether they were at the end of the conversation as it stood at
   * the last update, so what arrived since does not count against them.
   * Sending, or opening another thread, follows again.
   */
  const follow = useRef(true);
  const heightBefore = useRef<number>();

  useEffect(() => {
    follow.current = true;
  }, [thread?.id]);

  useEffect(() => {
    const box = scrollerOf(end.current);

    if (box === undefined) {
      return;
    }

    const before = heightBefore.current ?? box.scrollHeight;

    if (follow.current || before - box.scrollTop - box.clientHeight < FOLLOW_SLACK_PX) {
      end.current?.scrollIntoView({ block: "end" });
    }

    follow.current = false;
    heightBefore.current = box.scrollHeight;
  }, [messages.length, turns.length, pendingApprovals.length, streamedLength]);
  const displayName =
    IDENTITY_PROFILES.find((profile) => profile.id === identityId)?.displayName ?? identityId;
  const roleLabel = (role: string): string =>
    role === "user" ? "You" : role === "identity" ? displayName : "System";

  const pinned = thread === undefined ? undefined : pinnedTo(thread, conversation.roots);
  const subtitle =
    thread === undefined
      ? `${displayName} · nothing said yet`
      : delegated
        ? `${displayName} · delegated thread`
        : thread.kind === "named"
          ? `${displayName} · ${conversationLabel(thread)}`
          : thread.objectiveId === undefined
            ? `${displayName} · free chat`
            : `${displayName} · Objective thread`;

  return (
    <Page
      title="Threads"
      maxWidth={880}
      subtitle={subtitle}
      actions={
        <>
          {transport !== undefined && onOpenThread !== undefined && !listing && (
            <button
              type="button"
              onClick={() => {
                setListing(true);
                list.pushed();
              }}
              style={buttonStyle}
            >
              Conversations
            </button>
          )}
          {/* An Objective being active used to mean every question went into
              it. A question that has nothing to do with the work in progress
              now has somewhere to go that does not require pausing it. */}
          {delegated && onOpenThread !== undefined && (
            <button
              type="button"
              onClick={() => {
                onOpenThread(undefined);
              }}
              style={buttonStyle}
            >
              Back
            </button>
          )}
          {!delegated && onUseFreeThread !== undefined && (
            <button
              type="button"
              aria-pressed={freeThread === true}
              onClick={() => {
                onUseFreeThread(freeThread !== true);
              }}
              style={buttonStyle}
            >
              {freeThread === true ? "Back to the Objective" : "Ask something else"}
            </button>
          )}
        </>
      }
    >
      {listing && transport !== undefined && onOpenThread !== undefined ? (
        <Conversations
          transport={transport}
          identityId={identityId}
          roots={conversation.roots}
          currentThreadId={thread?.kind === "named" ? thread.id : undefined}
          onOpen={onOpenThread}
          onClose={list.dismiss}
        />
      ) : (
        <>
          {/* Where agents on this thread handed work: each one opens, and the
          prompt below then continues it. */}
          {children.length > 0 && onOpenThread !== undefined && (
            <nav
              aria-label="Delegated threads"
              style={{ display: "flex", flexWrap: "wrap", gap: spacing.xs }}
            >
              {children.map((child, index) => (
                <button
                  key={child.id}
                  type="button"
                  data-thread={child.id}
                  onClick={() => {
                    onOpenThread(child.id);
                  }}
                  title={`Started ${new Date(child.createdAt).toLocaleString()}`}
                  style={buttonStyle}
                >
                  Delegated thread {String(index + 1)}
                </button>
              ))}
            </nav>
          )}

          {transport !== undefined &&
            thread?.adoptedSessionRef !== undefined &&
            thread.providerId !== undefined && (
              <BeforeNoctis
                transport={transport}
                threadId={thread.id}
                providerId={thread.providerId}
              />
            )}

          {messages.length === 0 &&
            turns.length === 0 &&
            streaming.size === 0 &&
            thread?.adoptedSessionRef === undefined && (
              <p
                style={{ margin: 0, color: typography.color.muted, maxWidth: typography.measurePx }}
              >
                Pick an agent and a PC below, then say what you want done. Follow-ups continue the
                same thread on the same machine.
              </p>
            )}

          <ul aria-label="Conversation" style={{ ...listStyle, gap: spacing.md }}>
            {timelineOf(messages, turns, pendingApprovals).map((entry) => {
              if (entry.kind === "message") {
                return (
                  <li
                    key={entry.message.id}
                    data-entry="message"
                    data-role={entry.message.role}
                    style={bubbleStyle(entry.message.role === "user")}
                  >
                    <span
                      style={{
                        display: "block",
                        fontSize: typography.scale.xs,
                        letterSpacing: typography.tracking.wide,
                        color:
                          entry.message.role === "user"
                            ? typography.color.muted
                            : identityAccent.vesper.primary,
                        marginBottom: 2,
                      }}
                    >
                      {roleLabel(entry.message.role)}
                      <span style={spoken}>: </span>
                    </span>
                    <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {entry.message.body}
                    </span>
                  </li>
                );
              }

              if (entry.kind === "turn") {
                return (
                  <TurnRow
                    key={entry.turn.id}
                    turn={entry.turn}
                    outputUrl={outputUrl}
                    written={writtenFiles(entry.turn, conversation.roots)}
                    onOpenFile={onOpenFile}
                    onCancel={() => {
                      if (entry.turn.jobId !== undefined) {
                        void conversation.cancel(entry.turn.jobId);
                      }
                    }}
                  />
                );
              }

              const { approval } = entry;

              return (
                <li
                  key={approval.id}
                  data-entry="approval"
                  style={{
                    ...glass,
                    borderLeft: `2px solid ${semantic.approval}`,
                    padding: spacing.lg,
                    minWidth: 0,
                  }}
                >
                  <ApprovalSurface
                    id={approval.id}
                    consequenceSummary={approval.consequenceSummary}
                    operationClass={approval.operationClass}
                    capability={approval.capability}
                    targetType={approval.target.type}
                    targetId={approval.target.id}
                    reversibility={approval.reversibility}
                    outcome={approval.outcome}
                    reasonCodes={approval.reasonCodes}
                    {...(approval.estimatedCostGbp === undefined
                      ? {}
                      : { estimatedCostGbp: approval.estimatedCostGbp })}
                    {...(approval.confirmationPhrase === undefined
                      ? {}
                      : { confirmationPhrase: approval.confirmationPhrase })}
                    onConfirm={(typedConfirmation) => {
                      void conversation.confirm(approval.id, typedConfirmation);
                    }}
                    onDecline={() => {
                      void conversation.decline(approval.id);
                    }}
                  />
                </li>
              );
            })}

            {/* In progress, so always last: it is the newest thing on the page. */}
            {[...streaming.entries()].map(([itemId, text]) => (
              <li
                key={`streaming-${itemId}`}
                data-entry="streaming"
                data-streaming={itemId}
                aria-live="polite"
                style={{ ...bubbleStyle(false), color: typography.color.muted }}
              >
                <span
                  style={{
                    display: "block",
                    fontSize: typography.scale.xs,
                    color: identityAccent.vesper.primary,
                  }}
                >
                  {displayName} (typing)<span style={spoken}>: </span>
                </span>
                <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</span>
              </li>
            ))}
          </ul>

          {error !== undefined && (
            <p
              style={{
                color: semantic.error,
                margin: 0,
                display: "flex",
                gap: spacing.sm,
                alignItems: "center",
              }}
            >
              <span>{error}</span>
              {/* Task 2.6: a pinned host that is asleep refused the send before
              anything was written, so the offer is real — the same prompt, on
              whichever machine can take it. */}
              {conversation.offlineRetry !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    void conversation.retryElsewhere();
                  }}
                  style={buttonStyle}
                >
                  Send it elsewhere
                </button>
              )}
            </p>
          )}

          {/* Pinned to the bottom of the scroll, so the box to type in stays under
          the thumb however long the thread gets. */}
          <div
            style={{
              position: "sticky",
              // Down over the page's bottom padding, which sticky positioning
              // otherwise keeps clear: the thread showed through that strip.
              bottom: -spacing.lg,
              marginTop: "auto",
              padding: spacing.sm,
              borderRadius: corner.lg,
              background: `linear-gradient(180deg, rgba(11, 10, 18, 0.72), ${depth.layers[0]})`,
              backdropFilter: `blur(${String(material.blurPx)}px)`,
              WebkitBackdropFilter: `blur(${String(material.blurPx)}px)`,
              border: `1px solid ${material.border}`,
            }}
          >
            <PromptForm
              identityId={identityId}
              models={models}
              defaultModel={defaultModel}
              disabled={!connected}
              canAttach={conversation.canAttach}
              roots={conversation.roots}
              {...(pinned === undefined ? {} : { lockedTo: pinned })}
              {...(onSwitchIdentity === undefined ? {} : { onSwitchIdentity })}
              // The core beside the composer, which stays put while the thread
              // scrolls, so its state is always in view (owner, 2026-10-09).
              aside={
                <div
                  data-threads-core="true"
                  style={{
                    width: 76,
                    height: 76,
                    flexShrink: 0,
                    marginBottom: -6,
                    // Round, fading out: the canvas is a square on the composer's glass.
                    maskImage: "radial-gradient(circle, #000 55%, transparent 71%)",
                    WebkitMaskImage: "radial-gradient(circle, #000 55%, transparent 71%)",
                  }}
                >
                  <IntelligenceRenderer
                    identityId={identityId}
                    state={intelligenceState(conversation, false)}
                  />
                </div>
              }
              onSend={(text, options) => {
                follow.current = true;
                void conversation.send(text, options);
              }}
            />
          </div>
          {/* After the composer, so scrolling it into view reaches the very end
          rather than leaving the last entry under the sticky composer. */}
          <div ref={end} />
        </>
      )}
    </Page>
  );
}

function bubbleStyle(own: boolean): CSSProperties {
  return {
    justifySelf: own ? "end" : "start",
    maxWidth: `min(${String(typography.measurePx)}px, 88%)`,
    boxSizing: "border-box",
    padding: `${String(spacing.sm)}px ${String(spacing.md)}px`,
    borderRadius: own ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
    border: `1px solid ${own ? identityAccent.vesper.secondary : material.border}`,
    background: own ? "rgba(91, 79, 224, 0.18)" : material.fillElevated,
    lineHeight: 1.5,
  };
}
