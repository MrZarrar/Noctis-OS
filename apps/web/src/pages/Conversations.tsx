import { Fragment, useEffect, useState } from "react";

import type { ConversationalIdentityId, LiveSession } from "@noctis/contracts";
import { ConversationSummarySchema, ExternalSessionSchema } from "@noctis/contracts";
import { identityAccent, semantic, spacing, typography } from "@noctis/ui";
import { z } from "zod";

import { folderName } from "../conversation/PromptForm.js";
import type { RuntimeRootOption } from "../conversation/useConversation.js";
import { SectionHeading, buttonStyle, glass } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { LiveSessionList, LiveSessionView } from "./LiveSessions.js";
import {
  agentName,
  ago,
  conversationGroups,
  conversationLabel,
  pinnedTo,
} from "./conversations-view.js";

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

type Step =
  | { kind: "list" }
  | { kind: "places" }
  | { kind: "sessions"; place: RuntimeRootOption }
  | { kind: "live"; session: LiveSession };

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

/** Beside a row: small, but never under the touch floor. */
const actionStyle = {
  ...buttonStyle,
  minHeight: 44,
  padding: `0 ${String(spacing.sm)}px`,
  fontSize: typography.scale.xs,
} as const;

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
  const [archived, setArchived] = useState(false);
  /** Bumped after a rename or an archive, so the list reads again. */
  const [changes, setChanges] = useState(0);
  const [renaming, setRenaming] = useState<{ id: string; title: string }>();
  const now = Date.now();

  useEffect(() => {
    let live = true;

    setConversations(undefined);
    void transport
      .request("GET", `/conversations?identityId=${identityId}${archived ? "&archived=1" : ""}`)
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
  }, [transport, identityId, archived, changes]);

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

  /** A command on the owner's behalf. Resolves to the thread it answered with, if it worked. */
  async function run(name: string, body: Record<string, unknown>): Promise<string | undefined> {
    setBusy(true);
    setProblem(undefined);

    try {
      const response = await transport.request("POST", `/commands/${name}`, {
        idempotencyKey: newKey(),
        ...body,
      });
      const created = CreatedSchema.safeParse(response.body);

      if (response.status === 200 && created.success) {
        return created.data.id;
      }

      const message = (response.body as { error?: { message?: unknown } } | null)?.error?.message;

      setProblem(
        typeof message === "string" ? message : `The core answered ${String(response.status)}.`,
      );

      return undefined;
    } finally {
      setBusy(false);
    }
  }

  /** A command that answers with a new thread, which then opens. */
  async function openCreated(name: string, body: Record<string, unknown>): Promise<void> {
    const id = await run(name, { identityId, ...body });

    if (id !== undefined) {
      onOpen(id);
      onClose();
    }
  }

  /** A change to one conversation, then the list again. */
  async function change(name: string, body: Record<string, unknown>): Promise<void> {
    if ((await run(name, body)) !== undefined) {
      setRenaming(undefined);
      setChanges((count) => count + 1);
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
            <button
              type="button"
              aria-pressed={archived}
              onClick={() => {
                setRenaming(undefined);
                setArchived(!archived);
              }}
              style={buttonStyle}
            >
              {archived ? "Show current" : "Show archived"}
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
          <SectionHeading>{archived ? "Archived" : "Conversations"}</SectionHeading>
          {conversations === undefined ? (
            <p style={{ margin: 0, color: typography.color.muted }}>Loading…</p>
          ) : conversations.length === 0 ? (
            <p style={{ margin: 0, color: typography.color.muted }}>
              {archived
                ? "Nothing archived."
                : "Nothing yet. Start a new conversation, or continue a session from one of your PCs."}
            </p>
          ) : (
            conversationGroups(conversations).map((group) =>
              group.conversations.length === 0 ? null : (
                <Fragment key={group.taskId ?? "free"}>
                  {group.taskId !== undefined && <SectionHeading>{group.label}</SectionHeading>}
                  <ul style={listStyle}>
                    {group.conversations.map((conversation) => {
                      const label = conversationLabel(conversation);
                      const where = pinnedTo(conversation, roots);
                      const open =
                        conversation.id === currentThreadId ||
                        (conversation.kind === "free" && currentThreadId === undefined);

                      if (renaming?.id === conversation.id) {
                        return (
                          <li key={conversation.id}>
                            <form
                              onSubmit={(event) => {
                                event.preventDefault();
                                void change("conversation.rename_thread", {
                                  threadId: conversation.id,
                                  title: renaming.title,
                                });
                              }}
                              style={{ display: "flex", flexWrap: "wrap", gap: spacing.xs }}
                            >
                              <input
                                aria-label="Conversation name"
                                value={renaming.title}
                                maxLength={200}
                                autoFocus
                                onChange={(event) =>
                                  setRenaming({ id: conversation.id, title: event.target.value })
                                }
                                style={{ ...rowStyle, flex: "1 1 12rem", cursor: "text" }}
                              />
                              <button
                                type="submit"
                                disabled={busy || renaming.title.trim() === ""}
                                style={buttonStyle}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setRenaming(undefined)}
                                style={buttonStyle}
                              >
                                Cancel
                              </button>
                            </form>
                          </li>
                        );
                      }

                      return (
                        <li
                          key={conversation.id}
                          style={{ display: "flex", gap: spacing.xs, alignItems: "stretch" }}
                        >
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
                              minWidth: 0,
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
                              {conversation.preview === undefined ||
                              conversation.title === undefined
                                ? ""
                                : ` · ${conversation.preview}`}
                            </span>
                          </button>
                          {/* Free chat is where a message with no thread goes: it keeps its name and place. */}
                          {conversation.kind === "named" && (
                            <>
                              <button
                                type="button"
                                aria-label={`Rename ${label}`}
                                disabled={busy}
                                onClick={() => setRenaming({ id: conversation.id, title: label })}
                                style={actionStyle}
                              >
                                Rename
                              </button>
                              <button
                                type="button"
                                aria-label={`${archived ? "Restore" : "Archive"} ${label}`}
                                disabled={busy}
                                onClick={() =>
                                  void change("conversation.archive_thread", {
                                    threadId: conversation.id,
                                    archived: !archived,
                                  })
                                }
                                style={actionStyle}
                              >
                                {archived ? "Restore" : "Archive"}
                              </button>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </Fragment>
              ),
            )
          )}
          {!archived && (
            <LiveSessionList
              transport={transport}
              onOpen={(session) => {
                setStep({ kind: "live", session });
              }}
            />
          )}
        </>
      )}

      {step.kind === "live" && (
        <LiveSessionView
          transport={transport}
          session={step.session}
          roots={roots}
          busy={busy}
          onContinue={(root) =>
            void openCreated("conversation.adopt_session", {
              nodeId: step.session.nodeId,
              rootGrantId: root.grantId,
              providerId: step.session.providerId,
              sessionRef: step.session.sessionRef,
              title: step.session.title ?? "Live session",
            })
          }
        />
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
                      {agentName(session.providerId)} · {ago(session.lastActiveAt, now)}
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
