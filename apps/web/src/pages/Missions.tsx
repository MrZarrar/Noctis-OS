import type { ConversationalIdentityId } from "@noctis/contracts";
import { corner, material, semantic, spacing, typography } from "@noctis/ui";
import { useEffect, useState } from "react";
import { z } from "zod";

import { modelLabel } from "../conversation/PromptForm.js";
import type { Turn } from "../conversation/useConversation.js";
import { TurnSchema } from "../conversation/useConversation.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { ItemRow } from "./Chat.js";

/**
 * Missions: every turn Noctis has run, across every thread.
 *
 * Chat answers "what did we say"; this answers "what did it do, where, and on
 * whose model" — the turn, its job, the host that took it, the model, and each
 * item the runtime produced. Nothing here is a control: the only action is
 * going back to the conversation the turn belongs to, because a turn is only
 * explicable beside the prompt that caused it.
 *
 * ponytail: one read of the newest page of turns, refreshed when the page is
 * opened. Not live — turns in flight are watched in Chat, which already holds
 * the socket. Upgrade path: subscribe here too if this becomes where a long
 * run is watched from.
 */

const TurnsSchema = z.object({ turns: z.array(TurnSchema) }).strict();
const NodesSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), hostId: z.string(), connected: z.boolean() }).loose()),
});

export interface MissionsProps {
  transport: CoreTransport | undefined;
  /** Takes the rail to the thread this turn ran on. */
  onOpenChat: (turn: Turn) => void;
}

export function Missions({ transport, onOpenChat }: MissionsProps): JSX.Element {
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [hosts, setHosts] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const [turnResponse, nodeResponse] = await Promise.all([
          transport.request("GET", "/turns"),
          transport.request("GET", "/nodes"),
        ]);

        if (cancelled) {
          return;
        }

        const parsedTurns = TurnsSchema.safeParse(turnResponse.body);
        const parsedNodes = NodesSchema.safeParse(nodeResponse.body);

        if (!parsedTurns.success || !parsedNodes.success) {
          setError("The core returned a shape that does not match its contract");
          return;
        }

        setTurns(parsedTurns.data.turns);
        setHosts(
          new Map(
            parsedNodes.data.nodes.map((node) => [
              node.id,
              node.connected ? node.hostId : `${node.hostId} (offline)`,
            ]),
          ),
        );
        setError(undefined);
      } catch (failure: unknown) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "could not read turns");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [transport]);

  return (
    <section
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: spacing.lg,
        padding: spacing.lg,
        minWidth: 0,
        overflow: "auto",
      }}
    >
      <h1 style={{ margin: 0, font: `${String(typography.scale.lg)}px ${typography.family}` }}>
        Missions
      </h1>

      {turns.length === 0 ? (
        <p style={{ margin: 0, color: typography.color.muted }}>
          Nothing has run yet. A prompt in Chat is the first mission.
        </p>
      ) : (
        <ul aria-label="Turns" style={listStyle}>
          {turns.map((turn) => (
            <TurnCard
              key={turn.id}
              turn={turn}
              host={turn.nodeId === undefined ? undefined : hosts.get(turn.nodeId)}
              onOpenChat={() => {
                onOpenChat(turn);
              }}
            />
          ))}
        </ul>
      )}

      {error !== undefined && <p style={{ color: semantic.error, margin: 0 }}>{error}</p>}
    </section>
  );
}

const IDENTITY_NAME: Readonly<Record<ConversationalIdentityId, string>> = {
  vesper: "Vesper",
  jester: "Jester",
};

function TurnCard({
  turn,
  host,
  onOpenChat,
}: {
  turn: Turn;
  /** Absent until a node takes the job; a queued turn has no host yet. */
  host: string | undefined;
  onOpenChat: () => void;
}): JSX.Element {
  return (
    <li
      data-entry="mission"
      data-turn-status={turn.status}
      style={{
        border: `1px solid ${material.border}`,
        borderRadius: corner.md,
        padding: spacing.md,
        display: "grid",
        gap: spacing.xs,
        font: `${String(typography.scale.xs)}px ${typography.family}`,
      }}
    >
      <p style={{ margin: 0, display: "flex", gap: spacing.sm, alignItems: "center" }}>
        <strong>{turn.status}</strong>
        <span style={{ color: typography.color.muted }}>
          {IDENTITY_NAME[turn.identityId]} · {modelLabel(turn.model)} ·{" "}
          {host ?? (turn.status === "queued" ? "waiting for a host" : "no host recorded")}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onOpenChat} style={buttonStyle}>
          Open in Chat
        </button>
      </p>

      <p style={{ margin: 0, color: typography.color.muted }}>
        <time dateTime={turn.startedAt}>{turn.startedAt}</time>
        {turn.completedAt !== undefined && ` → ${turn.completedAt}`}
        {" · job "}
        {turn.jobId ?? "none"}
        {turn.objectiveId === undefined ? " · free chat" : " · under an Objective"}
        {turn.failureReason === undefined ? "" : ` — ${turn.failureReason}`}
      </p>

      {turn.items.length > 0 && (
        // Collapsed: a turn's items are the detail, and a page of turns that
        // opens every one of them is unreadable after three runs.
        <details>
          <summary style={{ cursor: "pointer", color: typography.color.muted }}>
            {turn.items.length} item{turn.items.length === 1 ? "" : "s"}
          </summary>
          <ul aria-label="Turn items" style={{ ...listStyle, gap: spacing.xs }}>
            {turn.items.map((item) => (
              <li key={item.itemId} data-item-kind={item.kind} data-item-status={item.status}>
                <ItemRow item={item} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

const listStyle = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: spacing.sm,
} as const;

const buttonStyle = {
  minHeight: 44,
  background: material.fillElevated,
  color: "inherit",
  border: `1px solid ${material.border}`,
  borderRadius: corner.sm,
  padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
  cursor: "pointer",
} as const;
