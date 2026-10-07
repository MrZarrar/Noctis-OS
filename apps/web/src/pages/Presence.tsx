import { IntelligenceRenderer, identityAccent, semantic, typography } from "@noctis/ui";
import { useState } from "react";

import { PromptForm } from "../conversation/PromptForm.js";
import { intelligenceState } from "../conversation/intelligence-state.js";
import type { ConversationState, SendOptions } from "../conversation/useConversation.js";
import type { IdentityRuntimeState } from "../identities/useIdentityRuntime.js";
import { useIsMobile } from "../layout/useIsMobile.js";
import { buttonStyle } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

export interface PresenceProps {
  identity: IdentityRuntimeState;
  transport: CoreTransport | undefined;
  conversation: Pick<ConversationState, "models" | "defaultModel" | "canAttach" | "roots"> &
    Partial<Pick<ConversationState, "turns" | "streaming" | "pendingApprovals" | "error">>;
  onSend: (text: string, options: SendOptions) => void;
  onReview?: () => void;
}

const STATE_WORDS = {
  idle: "Ready when you are",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  waiting_for_approval: "Waiting for your approval",
};

export function Presence({
  identity,
  transport,
  conversation,
  onSend,
  onReview,
}: PresenceProps): JSX.Element {
  const [listening, setListening] = useState(false);
  const mobile = useIsMobile();
  const identityId = identity.activeIdentityId ?? "vesper";
  const state = intelligenceState(
    {
      turns: conversation.turns ?? [],
      streaming: conversation.streaming ?? new Map(),
      pendingApprovals: conversation.pendingApprovals ?? [],
    },
    listening,
  );
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening.";
  const error = conversation.error ?? identity.error;

  return (
    <section
      aria-label="Presence"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: mobile ? "8px 16px 16px" : "20px 32px 28px",
        boxSizing: "border-box",
      }}
    >
      <h1
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          margin: 0,
          overflow: "hidden",
          clipPath: "inset(50%)",
        }}
      >
        Presence
      </h1>
      <div
        style={{
          flex: "1 1 320px",
          width: "100%",
          maxWidth: 690,
          minHeight: mobile ? 200 : 280,
          maxHeight: mobile ? 430 : 530,
          position: "relative",
        }}
      >
        <IntelligenceRenderer
          identityId={identityId}
          protocolIds={identity.protocolIds}
          state={state}
        />
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            bottom: "2%",
            left: "25%",
            right: "25%",
            height: 22,
            background: "radial-gradient(ellipse, rgba(139,124,246,.38), transparent 70%)",
            filter: "blur(5px)",
            pointerEvents: "none",
          }}
        />
      </div>
      <div style={{ width: "100%", maxWidth: 560, flexShrink: 0 }}>
        <p
          role="status"
          aria-live="polite"
          data-presence-state={state}
          style={{
            textAlign: "center",
            margin: "0 0 14px",
            color: state === "waiting_for_approval" ? semantic.approval : typography.color.muted,
            fontSize: 13,
          }}
        >
          {STATE_WORDS[state]}
        </p>
        <p
          style={{
            margin: "0 0 16px",
            fontSize: mobile ? 20 : 23,
            fontWeight: 400,
            textAlign: "center",
          }}
        >
          <span
            aria-hidden="true"
            style={{ color: identityAccent.vesper.primary, marginRight: 12 }}
          >
            ✦
          </span>
          {greeting}
        </p>
        {state === "waiting_for_approval" && onReview !== undefined && (
          <button
            type="button"
            onClick={onReview}
            style={{ ...buttonStyle, width: "100%", marginBottom: 12 }}
          >
            Review approval
          </button>
        )}
        <PromptForm
          identityId={identityId}
          models={conversation.models}
          defaultModel={conversation.defaultModel}
          disabled={transport === undefined}
          canAttach={conversation.canAttach}
          roots={conversation.roots}
          onSend={onSend}
          onListeningChange={setListening}
        />
        {error !== undefined && (
          <p role="alert" style={{ color: semantic.error }}>
            {error}
          </p>
        )}
        {transport === undefined && (
          <p style={{ color: typography.color.muted, textAlign: "center", fontSize: 13 }}>
            Connect to Noctis to start a thread.
          </p>
        )}
      </div>
    </section>
  );
}
