import type { ConversationThread, ConversationalIdentityId, RuntimeItem } from "@noctis/contracts";
import {
  IDENTITY_PROFILES,
  corner,
  depth,
  identityAccent,
  material,
  semantic,
  spacing,
  typography,
} from "@noctis/ui";
import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties } from "react";
import { useRef } from "react";

import { Markdown } from "../conversation/Markdown.js";
import { modelLabel } from "../conversation/PromptForm.js";
import type { Turn } from "../conversation/useConversation.js";
import { buttonStyle } from "../layout/Page.js";
import { useIsMobile } from "../layout/useIsMobile.js";
import { ItemRow } from "./Threads.js";
import {
  agentsOf,
  agentStepsOf,
  formatDuration,
  isTurnRunning,
  newestTurn,
  turnActivity,
  turnTiming,
} from "./turn-activity.js";

const card: CSSProperties = {
  padding: spacing.md,
  border: `1px solid ${material.border}`,
  borderRadius: corner.md,
  background: depth.layers[1],
  minWidth: 0,
  overflowWrap: "anywhere",
};

function StatusDot({ status, pulse = false }: { status: string; pulse?: boolean }): JSX.Element {
  const reduced = useReducedMotion();
  return (
    <motion.span
      aria-hidden
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        flexShrink: 0,
        borderRadius: "50%",
        background:
          status === "running" || status === "queued" || status === "in_progress"
            ? identityAccent.vesper.primary
            : status === "completed"
              ? semantic.success
              : status === "idle"
                ? typography.color.muted
                : semantic.error,
      }}
      animate={pulse && !reduced ? { opacity: [1, 0.35, 1] } : { opacity: 1 }}
      transition={{ duration: 1.6, repeat: pulse && !reduced ? Infinity : 0 }}
    />
  );
}

function metricsOf(agent: Extract<RuntimeItem, { kind: "sub_agent" }>): string {
  return [
    agent.durationMs === undefined ? undefined : formatDuration(agent.durationMs),
    agent.tokens === undefined
      ? undefined
      : `${agent.tokens >= 1000 ? `${(agent.tokens / 1000).toFixed(1)}k` : String(agent.tokens)} tokens`,
    agent.toolUses === undefined
      ? undefined
      : `${String(agent.toolUses)} ${agent.toolUses === 1 ? "tool use" : "tool uses"}`,
  ]
    .filter((value) => value !== undefined)
    .join(" · ");
}

export function AgentMap({
  identityId,
  turns,
  children,
  now,
  onOpenThread,
  outputUrl,
}: {
  identityId: ConversationalIdentityId;
  turns: readonly Turn[];
  children: readonly ConversationThread[];
  now: number;
  onOpenThread?: ((threadId: string | undefined) => void) | undefined;
  outputUrl?: ((attachmentId: string) => string) | undefined;
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const mobile = useIsMobile();
  const agents = agentsOf(turns);
  const latest = newestTurn(turns);
  const active = newestTurn(turns.filter(isTurnRunning));
  const main = active ?? latest;
  const running = active !== undefined || agents.some((agent) => agent.status === "in_progress");
  const name =
    IDENTITY_PROFILES.find((profile) => profile.id === identityId)?.displayName ?? identityId;
  const activity = main === undefined ? undefined : turnActivity(main.items, main.model.providerId);

  return (
    <>
      <button
        type="button"
        aria-label={`Agents · ${String(1 + agents.length + children.length)}`}
        aria-haspopup="dialog"
        style={{
          ...buttonStyle,
          display: "flex",
          alignItems: "center",
          gap: spacing.sm,
          whiteSpace: "nowrap",
          ...(mobile ? { paddingInline: spacing.sm } : {}),
        }}
        onClick={() => dialog.current?.showModal()}
      >
        {running && <StatusDot status="running" pulse />}
        {`Agents${mobile ? "" : " ·"} ${String(1 + agents.length + children.length)}`}
      </button>
      <dialog
        ref={dialog}
        aria-label="Agent map"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.target === event.currentTarget &&
            (event.clientX < box.left ||
              event.clientX > box.right ||
              event.clientY < box.top ||
              event.clientY > box.bottom)
          )
            dialog.current?.close();
        }}
        style={{
          background: depth.layers[0],
          color: typography.color.primary,
          fontFamily: typography.family,
          border: `1px solid ${material.border}`,
          borderRadius: mobile ? 0 : corner.lg,
          boxSizing: "border-box",
          padding: spacing.lg,
          width: mobile ? "100vw" : "min(760px, 92vw)",
          height: mobile ? "100dvh" : undefined,
          maxWidth: mobile ? "100vw" : "92vw",
          maxHeight: mobile ? "100dvh" : "90dvh",
          margin: mobile ? 0 : "auto",
          overflowY: "auto",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.md,
            marginBottom: spacing.md,
          }}
        >
          <h2 style={{ margin: 0, flex: 1, fontSize: typography.scale.lg }}>Agent map</h2>
          <button
            type="button"
            aria-label="Close agent map"
            style={buttonStyle}
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </header>
        <article data-agent="main" style={card}>
          <div style={{ display: "flex", gap: spacing.sm, alignItems: "center" }}>
            <StatusDot status={main?.status ?? "idle"} />
            <strong>{name}</strong>
          </div>
          {latest !== undefined && (
            <p style={{ marginBlock: spacing.xs, color: typography.color.muted }}>
              {modelLabel(latest.model)}
            </p>
          )}
          <p style={{ marginBlock: spacing.xs }}>
            {main === undefined ? "Idle" : turnTiming(main, now)}
          </p>
          {activity !== undefined && <p style={{ margin: 0 }}>{activity}</p>}
        </article>
        {(agents.length > 0 || children.length > 0) && (
          <div
            style={{
              marginLeft: spacing.md,
              paddingLeft: spacing.md,
              borderLeft: `2px solid ${material.border}`,
              display: "grid",
              gap: spacing.md,
              paddingTop: spacing.md,
            }}
          >
            {agents.map((agent) => {
              const steps = agentStepsOf(turns, agent.itemId);
              const metrics = metricsOf(agent);
              return (
                <details
                  key={agent.itemId}
                  data-agent={agent.itemId}
                  data-agent-status={agent.status}
                  style={card}
                >
                  <summary style={{ cursor: "pointer", minHeight: 44 }}>
                    <span style={{ display: "inline-flex", gap: spacing.sm, alignItems: "center" }}>
                      <StatusDot status={agent.status} />
                      <strong>{agent.label}</strong>
                    </span>
                    <span style={{ display: "block", color: typography.color.muted }}>
                      {agent.status === "in_progress"
                        ? "Working"
                        : agent.status === "completed"
                          ? "Done"
                          : agent.status === "failed"
                            ? "Failed"
                            : "Declined"}
                    </span>
                    {agent.status === "in_progress" && (
                      <span style={{ display: "block" }}>
                        {agent.activity ??
                          turnActivity(
                            steps.map((step) => ({ ...step, parentItemId: undefined })),
                          ) ??
                          "working"}
                      </span>
                    )}
                    {metrics !== "" && (
                      <span style={{ display: "block", color: typography.color.muted }}>
                        {metrics}
                      </span>
                    )}
                  </summary>
                  {agent.task !== undefined && (
                    <section aria-label="Task">
                      <h3 style={{ fontSize: typography.scale.sm }}>Task</h3>
                      <p style={{ whiteSpace: "pre-wrap" }}>{agent.task}</p>
                    </section>
                  )}
                  {steps.length > 0 && (
                    <section aria-label="Steps">
                      <h3 style={{ fontSize: typography.scale.sm }}>Steps</h3>
                      <ul style={{ paddingLeft: spacing.lg }}>
                        {steps.map((item) => (
                          <li key={item.itemId}>
                            <ItemRow item={item} outputUrl={outputUrl} />
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {agent.report !== undefined && (
                    <section aria-label="Report">
                      <h3 style={{ fontSize: typography.scale.sm }}>Report</h3>
                      <Markdown text={agent.report} />
                    </section>
                  )}
                </details>
              );
            })}
            {[...children]
              .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
              .map((child, index) => (
                <article key={child.id} data-thread={child.id} style={card}>
                  <strong>{child.title ?? `Delegated thread ${String(index + 1)}`}</strong>
                  <p style={{ color: typography.color.muted }}>Delegated thread</p>
                  <button
                    type="button"
                    disabled={onOpenThread === undefined}
                    style={buttonStyle}
                    onClick={() => {
                      dialog.current?.close();
                      onOpenThread?.(child.id);
                    }}
                  >
                    Open thread
                  </button>
                </article>
              ))}
          </div>
        )}
      </dialog>
    </>
  );
}
