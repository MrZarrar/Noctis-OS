import { useEffect, useState } from "react";

import type { ConversationalIdentityId } from "@noctis/contracts";
import { ConversationSummarySchema, ExternalSessionSchema } from "@noctis/contracts";
import { identityAccent, semantic, spacing, typography } from "@noctis/ui";
import { z } from "zod";

import { folderName } from "../conversation/PromptForm.js";
import type { RuntimeRootOption } from "../conversation/useConversation.js";
import { SectionHeading, buttonStyle, glass } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { ago, conversationLabel, pinnedTo } from "./conversations-view.js";

/**
 * Every conversation an identity has, and the two ways to start another: a
 * new one, or a session an agent already keeps on a PC (VS Code, a terminal),
 * continued here. Opening one hands its id to the page; the free chat is
 * `undefined`, the thread the page shows by default.
 */

const ListSchema = z.object({ conversations: z.array(ConversationSummarySchema) }).strict();
const SessionsSchema = z.object({ sessions: z.array(ExternalSessionSchema) }).strict();
const CreatedSchema = z.object({ id: z.string() }).loose();

type Summary = z.infer<typeof ListSchema>["conversations"][number];
type Session = z.infer<typeof SessionsSchema>["sessions"][number];

type Step = { kind: "list" } | { kind: "places" } | { kind: "sessions"; place: RuntimeRootOption };

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

const AGENTS: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex" };

function placeLabel(place: RuntimeRootOption): string {
  return `${folderName(place.path)} on ${place.hostId}`;
}

function newKey(): string {
  return crypto.randomUUID();
}

export function Conversations({
  transport,
  identityId,
  roots,
  currentThreadId,
  onOpen,
  onClose,
}: {
  transport: CoreTransport;
  identityId: ConversationalIdentityId;
  roots: readonly RuntimeRootOption[];
  currentThreadId: string | undefined;
  /** A thread to show; `undefined` is the free chat. */
  onOpen: (threadId: string | undefined) => void;
  onClose: () => void;
}): JSX.Element {
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [conversations, setConversations] = useState<Summary[]>();
  const [sessions, setSessions] = useState<Session[]>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const now = Date.now();

  useEffect(() => {
    let live = true;

    void transport
      .request("GET", `/conversations?identityId=${identityId}`)
      .then((response) => {
        const parsed = ListSchema.safeParse(response.body);

        if (live) {
          if (parsed.success) {
            setConversations(parsed.data.conversations);
          } else {
            setProblem("The core did not answer with conversations.");
          }
        }
      })
      .catch(() => {
        if (live) {
          setProblem("The core did not answer.");
        }
      });

    return () => {
      live = false;
    };
  }, [transport, identityId]);

  useEffect(() => {
    if (step.kind !== "sessions") {
      return;
    }

    let live = true;
    const query = new URLSearchParams({ node: step.place.nodeId, root: step.place.grantId });

    setSessions(undefined);
    setProblem(undefined);
    void transport
      .request("GET", `/sessions?${query.toString()}`)
      .then((response) => {
        const parsed = SessionsSchema.safeParse(response.body);
        const message = (response.body as { error?: { message?: unknown } } | null)?.error?.message;

        if (live) {
          if (parsed.success) {
            setSessions(parsed.data.sessions);
          } else {
            setProblem(typeof message === "string" ? message : "That PC did not answer.");
          }
        }
      })
      .catch(() => {
        if (live) {
          setProblem("That PC did not answer.");
        }
      });

    return () => {
      live = false;
    };
  }, [transport, step]);

  /** A command that answers with a thread, which then opens. */
  async function openCreated(name: string, body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setProblem(undefined);

    try {
      const response = await transport.request("POST", `/commands/${name}`, {
        idempotencyKey: newKey(),
        identityId,
        ...body,
      });
      const created = CreatedSchema.safeParse(response.body);

      if (response.status === 200 && created.success) {
        onOpen(created.data.id);
        onClose();
      } else {
        const message = (response.body as { error?: { message?: unknown } } | null)?.error?.message;

        setProblem(
          typeof message === "string" ? message : `The core answered ${String(response.status)}.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const back =
    step.kind === "list" ? (
      <button type="button" onClick={onClose} style={buttonStyle}>
        Close
      </button>
    ) : (
      <button
        type="button"
        onClick={() => {
          setProblem(undefined);
          setStep(step.kind === "sessions" ? { kind: "places" } : { kind: "list" });
        }}
        style={buttonStyle}
      >
        Back
      </button>
    );

  return (
    <section aria-label="Conversations" style={{ display: "grid", gap: spacing.md }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.sm, alignItems: "center" }}>
        {back}
        {step.kind === "list" && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void openCreated("conversation.create_thread", {})}
              style={{ ...buttonStyle, borderColor: identityAccent.vesper.primary }}
            >
              New conversation
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setStep({ kind: "places" })}
              style={buttonStyle}
            >
              Continue a session
            </button>
          </>
        )}
      </div>

      {problem !== undefined && (
        <p role="alert" style={{ margin: 0, color: semantic.error }}>
          {problem}
        </p>
      )}

      {step.kind === "list" && (
        <>
          <SectionHeading>Conversations</SectionHeading>
          {conversations === undefined ? (
            <p style={{ margin: 0, color: typography.color.muted }}>Loading…</p>
          ) : conversations.length === 0 ? (
            <p style={{ margin: 0, color: typography.color.muted }}>
              Nothing yet. Start a new conversation, or continue a session from one of your PCs.
            </p>
          ) : (
            <ul style={listStyle}>
              {conversations.map((conversation) => {
                const label = conversationLabel(conversation);
                const where = pinnedTo(conversation, roots);
                const open =
                  conversation.id === currentThreadId ||
                  (conversation.kind === "free" && currentThreadId === undefined);

                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      aria-label={label}
                      aria-current={open ? "true" : undefined}
                      onClick={() => {
                        onOpen(conversation.kind === "free" ? undefined : conversation.id);
                        onClose();
                      }}
                      style={{
                        ...rowStyle,
                        outline: open ? `2px solid ${identityAccent.vesper.primary}` : "none",
                      }}
                    >
                      <span
                        style={{
                          ...detailStyle,
                          fontSize: typography.scale.base,
                          color: "inherit",
                        }}
                      >
                        {label}
                      </span>
                      <span style={detailStyle}>
                        {ago(conversation.lastActiveAt, now)}
                        {where === undefined ? "" : ` · ${where}`}
                        {conversation.preview === undefined || conversation.title === undefined
                          ? ""
                          : ` · ${conversation.preview}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {step.kind === "places" && (
        <>
          <SectionHeading>Which folder?</SectionHeading>
          <p style={{ margin: 0, color: typography.color.muted }}>
            Sessions Claude or Codex keep for a shared folder, started in VS Code or a terminal.
          </p>
          <ul style={listStyle}>
            {roots
              .filter((root) => root.connected)
              .map((root) => (
                <li key={`${root.nodeId}:${root.grantId}`}>
                  <button
                    type="button"
                    aria-label={placeLabel(root)}
                    onClick={() => setStep({ kind: "sessions", place: root })}
                    style={rowStyle}
                  >
                    <span>{placeLabel(root)}</span>
                  </button>
                </li>
              ))}
          </ul>
          {roots.every((root) => !root.connected) && (
            <p style={{ margin: 0, color: typography.color.muted }}>No PC is online right now.</p>
          )}
        </>
      )}

      {step.kind === "sessions" && (
        <>
          <SectionHeading>{placeLabel(step.place)}</SectionHeading>
          {sessions === undefined && problem === undefined && (
            <p style={{ margin: 0, color: typography.color.muted }}>Asking {step.place.hostId}…</p>
          )}
          {sessions?.length === 0 && (
            <p style={{ margin: 0, color: typography.color.muted }}>
              No Claude or Codex sessions in this folder.
            </p>
          )}
          {sessions !== undefined && sessions.length > 0 && (
            <ul style={listStyle}>
              {sessions.map((session) => (
                <li key={`${session.providerId}:${session.sessionRef}`}>
                  <button
                    type="button"
                    aria-label={session.title}
                    disabled={busy}
                    onClick={() =>
                      void openCreated("conversation.adopt_session", {
                        nodeId: step.place.nodeId,
                        rootGrantId: step.place.grantId,
                        providerId: session.providerId,
                        sessionRef: session.sessionRef,
                        title: session.title.trim() === "" ? "Untitled session" : session.title,
                      })
                    }
                    style={rowStyle}
                  >
                    <span
                      style={{ ...detailStyle, fontSize: typography.scale.base, color: "inherit" }}
                    >
                      {session.title}
                    </span>
                    <span style={detailStyle}>
                      {AGENTS[session.providerId] ?? session.providerId} ·{" "}
                      {ago(session.lastActiveAt, now)}
                      {session.source === undefined ? "" : ` · ${session.source}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
