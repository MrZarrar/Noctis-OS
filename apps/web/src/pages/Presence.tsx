import type { ConversationalIdentityId } from "@noctis/contracts";
import { JesterGlyph, identityAccent, semantic, typography } from "@noctis/ui";
import { useEffect, useState } from "react";

import { Markdown } from "../conversation/Markdown.js";
import { MarkdownFiles } from "../conversation/MarkdownFiles.js";
import { PromptForm, lastRun } from "../conversation/PromptForm.js";
import { intelligenceState } from "../conversation/intelligence-state.js";
import { lastExchange } from "../conversation/last-exchange.js";
import type { ConversationState, SendOptions } from "../conversation/useConversation.js";
import type { IdentityRuntimeState } from "../identities/useIdentityRuntime.js";
import { useIsMobile } from "../layout/useIsMobile.js";
import { buttonStyle } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { ProductivityPresence } from "./ProductivityPresence.js";
import { UsageLimits } from "./UsageLimits.js";
import { useWakeWhileTyping } from "./CoreSettings.js";
import { ExchangeOutputs } from "./ExchangeOutputs.js";
import { PanelSheet, PanelTray, usePanelSheet } from "./PanelTray.js";
import { PresenceSideColumn, usePresencePanels } from "./PresencePanels.js";
import { AddPanel } from "./AddPanel.js";
import { AgentQuestions, openQuestions } from "./AgentQuestions.js";
import { pagePanelContext } from "./ThreadPanels.js";
import type { SurfaceContext } from "../surfaces/renderers.js";
import { clockText, greetingFor, msToNextMinute } from "./clock.js";
import type { DigestView } from "./digest-view.js";
import { DigestSchema, localMidnight, todayLine } from "./digest-view.js";

export interface PresenceProps {
  onOpenTaskThread?: (id: string) => void;
  onOpenReminders?: () => void;
  renderPage?: SurfaceContext["renderPage"];
  identity: IdentityRuntimeState;
  transport: CoreTransport | undefined;
  conversation: ConversationState;
  /** Whether a composer has the focus; the app's core reads the same signal. */
  listening: boolean;
  onSend: (text: string, options: SendOptions) => void;
  onReview?: () => void;
  /** The whole thread, in Threads; Presence shows only the exchange in progress. */
  onOpenThread?: () => void;
  onSwitchIdentity?: (identityId: ConversationalIdentityId) => void;
}

const STATE_WORDS = {
  asleep: "Asleep. Wake me, or just start typing",
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
  listening,
  onSend,
  onReview,
  onOpenThread,
  onSwitchIdentity,
  renderPage,
  onOpenTaskThread,
  onOpenReminders,
}: PresenceProps): JSX.Element {
  // Only what was said from here, this visit: an exchange from yesterday is
  // history, which Threads keeps, not something to greet the owner with.
  const [sent, setSent] = useState(false);
  // Each visit talks on a new chat, so one thread does not grow without end.
  // The last one stays in Threads, to be carried on from there.
  const startFreshIfIdle = conversation.startFreshIfIdle;
  useEffect(() => {
    void startFreshIfIdle();
  }, [startFreshIfIdle]);
  const mobile = useIsMobile();
  const panels = usePresencePanels(transport, conversation, renderPage);
  const sheet = usePanelSheet(panels);
  const identityId = identity.activeIdentityId ?? "vesper";
  // Only an agent that loads a model before it can answer sleeps: Jester, or
  // Vesper on a local model. Claude and Codex start fast and never do.
  const coldStart =
    identityId === "jester" ||
    conversation.defaultModel?.providerId === "local" ||
    conversation.defaultModel?.providerId === "hermes";
  const until = identity.awakeUntil[identityId];
  const asleep = coldStart && (until === undefined || Date.parse(until) <= Date.now());
  const wakeWhileTyping = useWakeWhileTyping(transport);
  const state = intelligenceState(conversation, listening, asleep);
  const questions = openQuestions(conversation.turns);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = window.setTimeout(function tick() {
      setNow(new Date());
      timer = window.setTimeout(tick, msToNextMinute(new Date()));
    }, msToNextMinute(new Date()));
    return () => {
      window.clearTimeout(timer);
    };
  }, []);
  const greeting = greetingFor(now);
  const clock = clockText(now);
  // The day so far, re-read as each turn settles and when the day rolls over.
  const [digest, setDigest] = useState<DigestView>();
  useEffect(() => {
    if (transport === undefined || state !== "idle") {
      return;
    }

    const now = new Date();
    void transport
      .request(
        "GET",
        `/digest?from=${encodeURIComponent(localMidnight(now).toISOString())}&to=${encodeURIComponent(now.toISOString())}`,
      )
      .then((response) => {
        const parsed = DigestSchema.safeParse(response.body);
        setDigest(parsed.success ? parsed.data : undefined);
      })
      .catch(() => {
        setDigest(undefined);
      });
  }, [transport, state, clock.day]);
  const today = todayLine(digest);
  const error = conversation.error ?? identity.error;
  const accent = identityAccent[identityId].primary;
  const exchange = sent ? lastExchange(conversation) : undefined;
  const asking = conversation.turns.at(-1);
  const presenceRun = lastRun(conversation.turns);

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
        gap: 24,
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
      {/* Always wrapped, so a side panel arriving never remounts the composer. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <div
          style={{
            alignSelf: "stretch",
            display: "flex",
            // On a phone the marker has a line of its own, so the clock below it
            // is centred and a long date cannot push the marker around.
            flexDirection: mobile ? "column" : "row",
            alignItems: mobile ? "stretch" : "flex-start",
            justifyContent: "space-between",
            gap: mobile ? 6 : 0,
          }}
        >
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
          {!mobile && <UsageLimits transport={transport} now={now} mobile={false} />}
          <time
            dateTime={now.toISOString()}
            aria-label={`${clock.time}, ${clock.day}`}
            style={{
              display: "grid",
              justifyItems: mobile ? "center" : "end",
              marginLeft: "auto",
              marginRight: mobile ? "auto" : 0,
            }}
          >
            <span
              style={{
                font: `200 ${String(mobile ? 40 : 56)}px/1 ${typography.family}`,
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "0.02em",
                color: typography.color.primary,
              }}
            >
              {clock.time}
            </span>
            <span
              style={{
                fontSize: typography.scale.sm,
                color: typography.color.muted,
                letterSpacing: "0.08em",
              }}
            >
              {clock.day}
            </span>
            {today !== undefined && (
              <span
                data-presence-digest
                style={{
                  fontSize: typography.scale.xs,
                  color: typography.color.muted,
                  marginTop: 6,
                }}
              >
                {today}
              </span>
            )}
          </time>
          {/* Under the clock on a phone, so the time stays the first thing seen. */}
          {mobile && <UsageLimits transport={transport} now={now} mobile />}
        </div>
        <ProductivityPresence
          transport={transport}
          {...(onOpenTaskThread ? { onOpenThread: onOpenTaskThread } : {})}
          {...(onOpenReminders ? { onOpenReminders } : {})}
        />
        {/* The app's one core flies into this box; it is drawn above the page. */}
        <div
          data-core-slot="hero"
          style={{
            flex: "1 1 320px",
            width: "100%",
            maxWidth: 690,
            minHeight: mobile ? 200 : 280,
            maxHeight: mobile ? 430 : 530,
            position: "relative",
          }}
        >
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
            {state === "idle" && questions.length > 0
              ? "Waiting for your answer"
              : STATE_WORDS[state]}
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
                  <div style={{ display: "flex", gap: 12 }}>
                    <span aria-hidden="true" style={{ color: accent }}>
                      ✦
                    </span>
                    <Markdown text={exchange.reply} />
                  </div>
                )}
                <ExchangeOutputs
                  outputs={exchange.outputs}
                  outputUrl={conversation.outputUrl}
                  mobile={mobile}
                />
              </div>
              {questions.length > 0 && asking !== undefined && (
                <div style={{ marginTop: 10 }}>
                  <AgentQuestions
                    key={asking.id}
                    questions={questions}
                    answerable
                    onAnswer={(text) => {
                      // On the model that asked, not the identity's default.
                      onSend(text, { model: asking.model });
                    }}
                  />
                </div>
              )}
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
          {mobile && (
            <MarkdownFiles.Provider value={panels.imageUrl}>
              <PanelSheet panels={panels} sheet={sheet} />
              <PanelTray panels={panels} sheet={sheet} />
            </MarkdownFiles.Provider>
          )}
          <AddPanel
            transport={transport}
            identityId={identityId}
            owner={{ presence: true }}
            {...pagePanelContext(panels, {
              thread: conversation.thread,
              roots: conversation.roots,
            })}
            onAdded={() => panels.sources.forEach((source) => source.composition.refresh())}
          />
          <PromptForm
            identityId={identityId}
            models={conversation.models}
            defaultModel={conversation.defaultModel}
            disabled={transport === undefined}
            canAttach={conversation.canAttach}
            roots={conversation.roots}
            {...(conversation.thread === undefined ? {} : { threadId: conversation.thread.id })}
            {...(presenceRun === undefined ? {} : { current: presenceRun })}
            onSend={(text, options) => {
              setSent(true);
              onSend(text, options);
            }}
            {...(onSwitchIdentity === undefined ? {} : { onSwitchIdentity })}
            asleep={asleep}
            onWake={() => void identity.wake(identityId)}
            wakeWhileTyping={wakeWhileTyping}
          />
          {/* Not mid-turn: the turn would carry on in a thread Presence had just let go of. */}
          {conversation.thread !== undefined && (state === "idle" || state === "listening") && (
            <button
              type="button"
              onClick={() => {
                setSent(false);
                void conversation.startFresh();
              }}
              style={{
                display: "block",
                margin: "8px auto 0",
                minHeight: 44,
                background: "transparent",
                border: "none",
                color: typography.color.muted,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              New chat
            </button>
          )}
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
      </div>
      {!mobile && <PresenceSideColumn panels={panels} />}
    </section>
  );
}
