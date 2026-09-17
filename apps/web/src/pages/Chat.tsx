import type { ConversationalIdentityId, RuntimeItem } from "@noctis/contracts";
import {
  ApprovalSurface,
  IDENTITY_PROFILES,
  corner,
  material,
  semantic,
  spacing,
  typography,
} from "@noctis/ui";

import { PromptForm, modelLabel } from "../conversation/PromptForm.js";
import type { ConversationState, Turn } from "../conversation/useConversation.js";

export interface ChatProps {
  identityId: ConversationalIdentityId;
  conversation: ConversationState;
  /** Absent in a browser with no core configured; the prompt is then disabled. */
  connected: boolean;
}

const listStyle = { listStyle: "none", margin: 0, padding: 0, display: "grid" } as const;

const buttonStyle = {
  background: material.fillElevated,
  color: "inherit",
  border: `1px solid ${material.border}`,
  borderRadius: corner.sm,
  padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
  cursor: "pointer",
} as const;

const mono = { fontFamily: typography.monoFamily, whiteSpace: "pre-wrap" } as const;

/** One thing the runtime did, in a line. Text says what happened; nothing is inferred. */
function ItemRow({ item }: { item: RuntimeItem }): JSX.Element {
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
            : `: ${item.proposal.surfaceKind}`}
        </span>
      );
    case "sub_agent":
      return (
        <span>
          sub-agent · {item.status} · {item.label}
        </span>
      );
  }
}

function TurnRow({ turn, onCancel }: { turn: Turn; onCancel: () => void }): JSX.Element {
  const running = turn.status === "queued" || turn.status === "running";

  return (
    <li
      data-entry="turn"
      data-turn-status={turn.status}
      style={{
        border: `1px solid ${material.border}`,
        borderRadius: corner.md,
        padding: spacing.sm,
        display: "grid",
        gap: spacing.xs,
        font: `${String(typography.scale.xs)}px ${typography.family}`,
      }}
    >
      <p style={{ margin: 0, display: "flex", gap: spacing.sm, alignItems: "center" }}>
        <span style={{ color: typography.color.muted }}>
          turn · {turn.status} · {modelLabel(turn.model)}
          {turn.failureReason === undefined ? "" : ` — ${turn.failureReason}`}
        </span>
        <span style={{ flex: 1 }} />
        {running && turn.jobId !== undefined && (
          <button type="button" onClick={onCancel} style={buttonStyle}>
            Cancel
          </button>
        )}
      </p>
      {turn.items.length > 0 && (
        <ul aria-label="Turn items" style={{ ...listStyle, gap: spacing.xs }}>
          {turn.items.map((item) => (
            <li key={item.itemId} data-item-kind={item.kind} data-item-status={item.status}>
              <ItemRow item={item} />
            </li>
          ))}
        </ul>
      )}
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
 * Chat: the identity's thread — free chat, or the active Objective's (0.12).
 *
 * Everything shown is read from the core except the streamed text, which lives
 * only until the message it was streaming commits. Approval cards are the same
 * Surface the canvas uses, so a typed phrase is typed here too.
 */
export function Chat({ identityId, conversation, connected }: ChatProps): JSX.Element {
  const { thread, messages, turns, streaming, pendingApprovals, models, defaultModel, error } =
    conversation;
  const displayName =
    IDENTITY_PROFILES.find((profile) => profile.id === identityId)?.displayName ?? identityId;
  const roleLabel = (role: string): string =>
    role === "user" ? "You" : role === "identity" ? displayName : "System";

  return (
    <section
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: spacing.md,
        padding: spacing.lg,
        minWidth: 0,
        overflow: "auto",
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: spacing.md }}>
        <h1 style={{ margin: 0, font: `${String(typography.scale.lg)}px ${typography.family}` }}>
          Chat
        </h1>
        <span style={{ color: typography.color.muted }}>
          {thread === undefined
            ? `${displayName} · nothing said yet`
            : thread.objectiveId === undefined
              ? `${displayName} · free chat`
              : `${displayName} · Objective thread`}
        </span>
      </header>

      <ul aria-label="Conversation" style={{ ...listStyle, gap: spacing.sm }}>
        {timelineOf(messages, turns, pendingApprovals).map((entry) => {
          if (entry.kind === "message") {
            return (
              <li
                key={entry.message.id}
                data-entry="message"
                data-role={entry.message.role}
                style={{ maxWidth: typography.measurePx }}
              >
                <span style={{ color: typography.color.muted }}>
                  {roleLabel(entry.message.role)}:{" "}
                </span>
                <span style={{ whiteSpace: "pre-wrap" }}>{entry.message.body}</span>
              </li>
            );
          }

          if (entry.kind === "turn") {
            return (
              <TurnRow
                key={entry.turn.id}
                turn={entry.turn}
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
                border: `1px solid ${semantic.approval}`,
                borderRadius: corner.md,
                padding: spacing.md,
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
            style={{ maxWidth: typography.measurePx, color: typography.color.muted }}
          >
            <span>{displayName} (typing): </span>
            <span style={{ whiteSpace: "pre-wrap" }}>{text}</span>
          </li>
        ))}
      </ul>

      {error !== undefined && <p style={{ color: semantic.error, margin: 0 }}>{error}</p>}

      <span style={{ flex: 1 }} />

      <PromptForm
        identityId={identityId}
        models={models}
        defaultModel={defaultModel}
        disabled={!connected}
        canAttach={conversation.canAttach}
        onSend={(text, model, files) => {
          void conversation.send(text, model, files);
        }}
      />
    </section>
  );
}
