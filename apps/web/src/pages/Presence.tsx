import type { ConversationalIdentityId } from "@noctis/contracts";
import {
  IntelligenceRenderer,
  JesterGlyph,
  identityAccent,
  semantic,
  typography,
} from "@noctis/ui";
import { useState } from "react";

import { PromptForm } from "../conversation/PromptForm.js";
import { intelligenceState } from "../conversation/intelligence-state.js";
import { lastExchange } from "../conversation/last-exchange.js";
import type { ConversationState, SendOptions } from "../conversation/useConversation.js";
import type { IdentityRuntimeState } from "../identities/useIdentityRuntime.js";
import { useIsMobile } from "../layout/useIsMobile.js";
import { buttonStyle } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

export interface PresenceProps {
  identity: IdentityRuntimeState;
  transport: CoreTransport | undefined;
  conversation: Pick<ConversationState, "models" | "defaultModel" | "canAttach" | "roots"> &
    Partial<
      Pick<ConversationState, "messages" | "turns" | "streaming" | "pendingApprovals" | "error">
    >;
  onSend: (text: string, options: SendOptions) => void;
  onReview?: () => void;
  /** The whole thread, in Threads; Presence shows only the exchange in progress. */
  onOpenThread?: () => void;
  onSwitchIdentity?: (identityId: ConversationalIdentityId) => void;
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
  onOpenThread,
  onSwitchIdentity,
}: PresenceProps): JSX.Element {
  const [listening, setListening] = useState(false);
  // Only what was said from here, this visit: an exchange from yesterday is
  // history, which Threads keeps, not something to greet the owner with.
  const [sent, setSent] = useState(false);
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
  const accent = identityAccent[identityId].primary;
  const exchange = sent
    ? lastExchange({
        messages: conversation.messages ?? [],
        turns: conversation.turns ?? [],
        streaming: conversation.streaming ?? new Map(),
      })
    : undefined;

  return (
    <section
      aria-label="Presence"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflowY: "auto",
        position: "relative",
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
      {identityId === "jester" && (
        // The mockups' marker: which identity is listening, in its own colour.
        <p
          style={{
            alignSelf: "flex-start",
            display: "flex",
            alignItems: "center",
            gap: 10,
            margin: 0,
            color: accent,
            fontFamily: typography.monoFamily,
            fontSize: 12,
            letterSpacing: "0.14em",
          }}
        >
          <JesterGlyph size={16} />
          JESTER · ACTIVE
        </p>
      )}
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
            background:
              identityId === "jester"
                ? "radial-gradient(ellipse, rgba(139,124,246,.3), rgba(182,255,59,.08) 45%, transparent 70%)"
                : "radial-gradient(ellipse, rgba(139,124,246,.38), transparent 70%)",
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
        {exchange === undefined ? (
          <p
            style={{
              margin: "0 0 16px",
              fontSize: mobile ? 20 : 23,
              fontWeight: 400,
              textAlign: "center",
            }}
          >
            <span aria-hidden="true" style={{ color: accent, marginRight: 12 }}>
              ✦
            </span>
            {greeting}
          </p>
        ) : (
          <div style={{ margin: "0 0 16px" }}>
            <div
              aria-live="polite"
              style={{
                display: "grid",
                gap: 10,
                maxHeight: mobile ? "26vh" : "30vh",
                overflowY: "auto",
                fontSize: mobile ? 15 : 16,
                lineHeight: 1.5,
              }}
            >
              <p style={{ margin: 0, display: "flex", gap: 12 }}>
                <span aria-hidden="true" style={{ color: identityAccent.vesper.primary }}>
                  ✦
                </span>
                <span>{exchange.you}</span>
              </p>
              {exchange.reply !== "" && (
                <p style={{ margin: 0, display: "flex", gap: 12, whiteSpace: "pre-wrap" }}>
                  <span aria-hidden="true" style={{ color: accent }}>
                    ✦
                  </span>
                  <span>{exchange.reply}</span>
                </p>
              )}
            </div>
            {onOpenThread !== undefined && (
              <button
                type="button"
                onClick={onOpenThread}
                style={{
                  marginTop: 8,
                  minHeight: 44,
                  background: "transparent",
                  border: "none",
                  color: typography.color.muted,
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                Open in Threads →
              </button>
            )}
          </div>
        )}
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
          onSend={(text, options) => {
            setSent(true);
            onSend(text, options);
          }}
          onListeningChange={setListening}
          {...(onSwitchIdentity === undefined ? {} : { onSwitchIdentity })}
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
