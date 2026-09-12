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

      <ul aria-label="Messages" style={{ ...listStyle, gap: spacing.sm }}>
        {messages.map((message) => (
          <li key={message.id} data-role={message.role} style={{ maxWidth: typography.measurePx }}>
            <span style={{ color: typography.color.muted }}>{roleLabel(message.role)}: </span>
            <span style={{ whiteSpace: "pre-wrap" }}>{message.body}</span>
          </li>
        ))}
        {[...streaming.entries()].map(([itemId, text]) => (
          <li
            key={`streaming-${itemId}`}
            data-streaming={itemId}
            aria-live="polite"
            style={{ maxWidth: typography.measurePx, color: typography.color.muted }}
          >
            <span>{displayName} (typing): </span>
            <span style={{ whiteSpace: "pre-wrap" }}>{text}</span>
          </li>
        ))}
      </ul>

      {turns.length > 0 && (
        <ul aria-label="Turns" style={{ ...listStyle, gap: spacing.sm }}>
          {turns.map((turn) => (
            <TurnRow
              key={turn.id}
              turn={turn}
              onCancel={() => {
                if (turn.jobId !== undefined) {
                  void conversation.cancel(turn.jobId);
                }
              }}
            />
          ))}
        </ul>
      )}

      {pendingApprovals.length > 0 && (
        <ul aria-label="Approvals waiting" style={{ ...listStyle, gap: spacing.sm }}>
          {pendingApprovals.map((approval) => (
            <li
              key={approval.id}
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
          ))}
        </ul>
      )}

      {error !== undefined && <p style={{ color: semantic.error, margin: 0 }}>{error}</p>}

      <span style={{ flex: 1 }} />

      <PromptForm
        identityId={identityId}
        models={models}
        defaultModel={defaultModel}
        disabled={!connected}
        onSend={(text, model) => {
          void conversation.send(text, model);
        }}
      />
    </section>
  );
}
