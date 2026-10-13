import type { ConversationalIdentityId } from "@noctis/contracts";
import { IDENTITY_PROFILES, identityAccent, spacing, typography, semantic } from "@noctis/ui";
import { PromptForm } from "../conversation/PromptForm.js";
import type { ConversationState } from "../conversation/useConversation.js";
import { buttonStyle } from "../layout/Page.js";
import { pinnedTo } from "./conversations-view.js";
import { lastExchange } from "../conversation/last-exchange.js";

export function companionReply(
  conversation: Pick<ConversationState, "messages" | "turns">,
): string {
  if (conversation.turns.some((turn) => turn.status === "running" || turn.status === "queued"))
    return "thinking…";
  return (
    (
      lastExchange({ ...conversation, streaming: new Map() })?.reply ??
      conversation.messages.filter((message) => message.role === "identity").at(-1)?.body ??
      ""
    )
      .split("\n")
      .slice(0, 3)
      .join("\n") ?? ""
  );
}

export function CompanionColumn({
  identityId,
  conversation,
  connected,
  onShowConversation,
  onSwitchIdentity,
}: {
  identityId: ConversationalIdentityId;
  conversation: ConversationState;
  connected: boolean;
  onShowConversation: () => void;
  onSwitchIdentity?: (id: ConversationalIdentityId) => void;
}): JSX.Element {
  const lockedTo =
    conversation.thread === undefined
      ? undefined
      : pinnedTo(conversation.thread, conversation.roots);
  return (
    <aside
      data-companion-column
      aria-label="Conversation companion"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: spacing.md,
        minWidth: 0,
      }}
    >
      <div data-core-slot="companion" style={{ width: 160, height: 160, alignSelf: "center" }} />
      <p
        style={{
          margin: 0,
          color: identityAccent[identityId].primary,
          font: `600 ${String(typography.scale.lg)}px ${typography.family}`,
        }}
      >
        {IDENTITY_PROFILES.find((profile) => profile.id === identityId)?.displayName ?? identityId}
      </p>
      <p aria-live="polite" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {companionReply(conversation)}
      </p>
      <button type="button" style={buttonStyle} onClick={onShowConversation}>
        Show conversation
      </button>
      {conversation.pendingApprovals.length > 0 && (
        <button type="button" style={buttonStyle} onClick={onShowConversation}>
          Review approval
        </button>
      )}
      {conversation.error !== undefined && (
        <p role="alert" style={{ color: semantic.error }}>
          {conversation.error}
        </p>
      )}
      <PromptForm
        identityId={identityId}
        models={conversation.models}
        defaultModel={conversation.defaultModel}
        disabled={!connected}
        canAttach={conversation.canAttach}
        roots={conversation.roots}
        {...(lockedTo === undefined ? {} : { lockedTo })}
        {...(onSwitchIdentity === undefined ? {} : { onSwitchIdentity })}
        onSend={(text, options) => {
          void conversation.send(text, options);
        }}
      />
    </aside>
  );
}
