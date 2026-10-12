import { useEffect, useState } from "react";

import type { LiveEntry, LiveSession } from "@noctis/contracts";
import { LiveEntrySchema, LiveSessionSchema } from "@noctis/contracts";
import { identityAccent, spacing, typography } from "@noctis/ui";
import { z } from "zod";

import { folderName } from "../conversation/PromptForm.js";
import type { RuntimeRootOption } from "../conversation/useConversation.js";
import { SectionHeading, buttonStyle, glass } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { agentName, ago } from "./conversations-view.js";

/**
 * Sessions the owner runs in VS Code or the Codex app, reported by those
 * agents' own hooks (the live bridge). Read only here: typing into one stays
 * with its own app, or Remote Control, or continuing it as a Noctis thread.
 */

const SessionsSchema = z.object({ sessions: z.array(LiveSessionSchema) });
const EntriesSchema = z.object({ entries: z.array(LiveEntrySchema) });

/** ponytail: polled while open. The ledger's `bridge.session_updated.v1` is the push upgrade. */
const POLL_MS = 3000;

const rowStyle = {
  ...glass,
  borderRadius: 12,
  display: "grid",
  gap: 2,
  width: "100%",
  minHeight: 56,
  padding: `${String(spacing.sm)}px ${String(spacing.md)}px`,
  font: `${String(typography.scale.base)}px ${typography.family}`,
  color: typography.color.primary,
  textAlign: "left",
  cursor: "pointer",
} as const;

const detailStyle = {
  color: typography.color.muted,
  fontSize: typography.scale.xs,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const listStyle = { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 } as const;

function titleOf(session: LiveSession): string {
  return session.title ?? `${agentName(session.providerId)} in ${folderName(session.cwd)}`;
}

/** The shared folder a session runs in, so it can be continued as a Noctis thread. */
export function sharedRootFor(
  session: LiveSession,
  roots: readonly RuntimeRootOption[],
): RuntimeRootOption | undefined {
  const same = (path: string): string =>
    path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();

  return roots.find(
    (root) => root.nodeId === session.nodeId && same(root.path) === same(session.cwd),
  );
}

export function LiveSessionList({
  transport,
  onOpen,
}: {
  transport: CoreTransport;
  onOpen: (session: LiveSession) => void;
}): JSX.Element | null {
  const [sessions, setSessions] = useState<LiveSession[]>();
  const now = Date.now();

  useEffect(() => {
    let live = true;
    const read = (): void => {
      void transport
        .request("GET", "/live-sessions")
        .then((response) => {
          const parsed = SessionsSchema.safeParse(response.body);

          if (live && parsed.success) {
            setSessions(parsed.data.sessions);
          }
        })
        .catch(() => undefined);
    };

    read();
    const timer = window.setInterval(read, POLL_MS);

    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [transport]);

  // Nothing to say until a PC has the bridge: most never will.
  if (sessions === undefined || sessions.length === 0) {
    return null;
  }

  return (
    <>
      <SectionHeading>Live sessions</SectionHeading>
      <p style={{ margin: 0, color: typography.color.muted, fontSize: typography.scale.sm }}>
        Running in VS Code or the Codex app. Read only here.
      </p>
      <ul style={listStyle}>
        {sessions.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              aria-label={`${titleOf(session)}, ${session.status}`}
              onClick={() => {
                onOpen(session);
              }}
              style={rowStyle}
            >
              <span style={{ ...detailStyle, fontSize: typography.scale.base, color: "inherit" }}>
                {titleOf(session)}
              </span>
              <span style={detailStyle}>
                {session.status === "live" ? "Live" : "Ended"} · {agentName(session.providerId)} ·{" "}
                {folderName(session.cwd)} on {session.hostId} · {ago(session.updatedAt, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function LiveSessionView({
  transport,
  session,
  roots,
  busy,
  onContinue,
}: {
  transport: CoreTransport;
  session: LiveSession;
  roots: readonly RuntimeRootOption[];
  busy: boolean;
  /** Continues the session as a Noctis thread, in a copy. */
  onContinue: (root: RuntimeRootOption) => void;
}): JSX.Element {
  const [entries, setEntries] = useState<LiveEntry[]>();
  const shared = sharedRootFor(session, roots);

  useEffect(() => {
    let live = true;
    const read = (): void => {
      void transport
        .request("GET", `/live-sessions/${session.id}/entries`)
        .then((response) => {
          const parsed = EntriesSchema.safeParse(response.body);

          if (live && parsed.success) {
            setEntries(parsed.data.entries);
          }
        })
        .catch(() => undefined);
    };

    read();
    const timer = window.setInterval(read, POLL_MS);

    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [transport, session.id]);

  return (
    <>
      <SectionHeading>{titleOf(session)}</SectionHeading>
      <p style={{ margin: 0, color: typography.color.muted, fontSize: typography.scale.sm }}>
        {agentName(session.providerId)} in {session.cwd} on {session.hostId}. Read only: type in its
        own app, or use Remote Control
        {shared === undefined ? "." : ", or continue it here as a Noctis conversation."}
      </p>
      {shared !== undefined && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            onContinue(shared);
          }}
          style={{ ...buttonStyle, justifySelf: "start" }}
        >
          Continue in Noctis
        </button>
      )}
      {entries?.length === 0 && (
        <p style={{ margin: 0, color: typography.color.muted }}>Nothing said yet.</p>
      )}
      <ul aria-label="Live session" style={{ ...listStyle, gap: spacing.sm }}>
        {(entries ?? []).map((entry) => (
          <li
            key={entry.id}
            style={{
              ...glass,
              borderRadius: 12,
              padding: `${String(spacing.sm)}px ${String(spacing.md)}px`,
              justifySelf: entry.role === "user" ? "end" : "start",
              maxWidth: "85%",
              borderColor: entry.role === "user" ? identityAccent.vesper.secondary : undefined,
            }}
          >
            <span
              style={{
                display: "block",
                fontSize: typography.scale.xs,
                color: typography.color.muted,
              }}
            >
              {entry.role === "user" ? "You" : agentName(session.providerId)}
            </span>
            <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{entry.body}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
