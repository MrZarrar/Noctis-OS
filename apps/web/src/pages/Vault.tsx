import type { VaultSphereEdge, VaultSphereNode } from "@noctis/ui";
import { RecallSurface, VaultSphere, semantic, spacing, typography } from "@noctis/ui";
import type { RecallEvidenceView } from "@noctis/ui";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { Markdown } from "../conversation/Markdown.js";
import { Page, buttonStyle, fieldStyle, glass } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

import type { VaultEdit } from "./VaultEdits.js";
import { VaultEditSchema, VaultEdits } from "./VaultEdits.js";
import { VaultLock } from "./VaultLock.js";

/**
 * The dedicated Vault view (Section 7).
 *
 * Threads receives a focused recall Surface,
 * and this is where the whole graph lives. Arriving here from a recall carries
 * `focusId` and a return control, so the handoff is a round trip rather than a
 * one-way navigation that loses the objective.
 */

export const GraphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      name: z.string(),
      type: z.enum(["capture", "project", "person", "reference", "daily", "agent", "note"]),
      itemId: z.string().nullable(),
      path: z.string().nullable(),
      x: z.number().nullable(),
      y: z.number().nullable(),
      z: z.number().nullable(),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      target: z.string(),
      type: z.string(),
      lifecycle: z.enum(["resolved", "unresolved"]),
    }),
  ),
  total: z.number(),
  /** The core says so rather than quietly returning a slice. See MAX_GRAPH_NODES. */
  truncated: z.boolean(),
});

export const StatusSchema = z.object({
  configured: z.boolean(),
  live: z.boolean(),
  writesEnabled: z.boolean(),
});

export const RecallSchema = z.object({
  entityIds: z.array(z.string()),
  evidence: z.array(
    z.object({
      itemId: z.string(),
      entityId: z.string(),
      path: z.string(),
      quote: z.string(),
      freshness: z.enum(["current", "stale", "unavailable", "unknown"]),
    }),
  ),
  freshness: z.enum(["current", "stale", "unavailable", "unknown"]),
});

export const NoteSchema = z.object({ path: z.string(), title: z.string(), text: z.string() });
export const EditsSchema = z.object({ edits: z.array(VaultEditSchema) });

/** The opened node's note: being read, read, or a name nobody has written a note for. */
export type NoteState =
  | { kind: "reading" }
  | { kind: "note"; path: string; text: string }
  | { kind: "none" }
  | { kind: "failed" };

let keySequence = 0;

function nextKey(): string {
  keySequence += 1;

  return `web-vault-${String(keySequence)}-${String(Date.now())}`;
}

export interface VaultProps {
  transport: CoreTransport | undefined;
  /** Set when arriving from a recall Surface. */
  focusId?: string;
  onReturn?: () => void;
}

export function firstDrawnHit(
  entityIds: readonly string[],
  nodes: readonly VaultSphereNode[],
): string | undefined {
  return entityIds.find((id) =>
    nodes.some(
      (node) =>
        node.id === id && node.x !== undefined && node.y !== undefined && node.z !== undefined,
    ),
  );
}

export function Vault({ transport, focusId, onReturn }: VaultProps): JSX.Element {
  const [status, setStatus] = useState<z.infer<typeof StatusSchema>>();
  const [nodes, setNodes] = useState<readonly VaultSphereNode[]>([]);
  const [edges, setEdges] = useState<readonly VaultSphereEdge[]>([]);
  const [focus, setFocus] = useState<string | undefined>(focusId);
  const [query, setQuery] = useState("");
  const [recall, setRecall] = useState<z.infer<typeof RecallSchema> & { query: string }>();
  const [error, setError] = useState<string>();
  const [commandError, setCommandError] = useState<string>();
  const [edits, setEdits] = useState<readonly VaultEdit[]>([]);
  const [truncated, setTruncated] = useState<{ shown: number; total: number }>();
  const [revision, setRevision] = useState(0);
  const [note, setNote] = useState<NoteState>();

  useEffect(() => {
    setFocus(focusId);
  }, [focusId]);

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const [statusResponse, graphResponse, editsResponse] = await Promise.all([
          transport.request("GET", "/vault"),
          transport.request("GET", "/vault/graph"),
          transport.request("GET", "/vault/edits"),
        ]);

        if (cancelled) {
          return;
        }

        const parsedStatus = StatusSchema.safeParse(statusResponse.body);
        const parsedGraph = GraphSchema.safeParse(graphResponse.body);
        const parsedEdits = EditsSchema.safeParse(editsResponse.body);

        if (!parsedStatus.success || !parsedGraph.success) {
          setError("The core returned a Vault shape that does not match its contract");
          return;
        }

        setStatus(parsedStatus.data);
        // The filed list is extra: the graph still draws without it.
        setEdits(parsedEdits.success ? parsedEdits.data.edits : []);
        setNodes(
          parsedGraph.data.nodes.map((node) => ({
            id: node.id,
            name: node.name,
            type: node.type,
            ...(node.x === null ? {} : { x: node.x }),
            ...(node.y === null ? {} : { y: node.y }),
            ...(node.z === null ? {} : { z: node.z }),
            path: node.path,
          })),
        );
        setEdges(parsedGraph.data.edges);
        setTruncated(
          parsedGraph.data.truncated
            ? { shown: parsedGraph.data.nodes.length, total: parsedGraph.data.total }
            : undefined,
        );
        setError(undefined);
      } catch (failure: unknown) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "could not read the Vault");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [transport, revision]);

  // The note is read from disk by the core each time a node opens, so the page
  // always shows the file as it is now, and nothing of it is stored.
  useEffect(() => {
    if (transport === undefined || focus === undefined) {
      setNote(undefined);
      return;
    }

    let cancelled = false;

    setNote({ kind: "reading" });
    void transport
      .request("GET", `/vault/notes/${encodeURIComponent(focus)}`)
      .then((response) => {
        const parsed = NoteSchema.safeParse(response.body);

        if (!cancelled) {
          setNote(
            response.status === 200 && parsed.success
              ? { kind: "note", path: parsed.data.path, text: parsed.data.text }
              : { kind: response.status === 404 ? "none" : "failed" },
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNote({ kind: "failed" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [transport, focus, revision]);

  const focusName = nodes.find((node) => node.id === focus)?.name;

  const editCommand = useCallback(
    async (
      command: "undo_edit" | "apply_revision" | "decline_revision" | "promote_now",
      editId?: string,
    ) => {
      if (transport === undefined) {
        return;
      }

      try {
        const response = await transport.request("POST", `/commands/vault.${command}`, {
          idempotencyKey: nextKey(),
          ...(editId === undefined ? {} : { editId }),
        });

        if (response.status === 200) {
          setCommandError(undefined);
        } else {
          const body = response.body as { error?: { message?: unknown }; message?: unknown } | null;
          const message = body?.error?.message ?? body?.message;
          setCommandError(
            typeof message === "string" ? message : "The core refused the Vault change.",
          );
        }
      } catch (failure: unknown) {
        setCommandError(failure instanceof Error ? failure.message : "Could not change the Vault.");
      } finally {
        setRevision((current) => current + 1);
      }
    },
    [transport],
  );

  const reindex = useCallback(async () => {
    if (transport === undefined) {
      return;
    }

    const response = await transport.request("POST", "/commands/vault.reindex", {
      idempotencyKey: nextKey(),
    });

    if (response.status === 200) {
      setRevision((current) => current + 1);
      setError(undefined);
    } else {
      setError(
        response.status === 404
          ? "No Vault is configured. Set NOCTIS_VAULT_ROOT to a test Vault."
          : "The core refused to reindex",
      );
    }
  }, [transport]);

  const search = useCallback(async () => {
    if (transport === undefined || query.trim() === "") {
      return;
    }

    const response = await transport.request(
      "GET",
      `/vault/recall?query=${encodeURIComponent(query.trim())}&limit=10`,
    );

    const parsed = RecallSchema.safeParse(response.body);

    if (response.status === 200 && parsed.success) {
      setRecall({ ...parsed.data, query: query.trim() });
      setFocus(firstDrawnHit(parsed.data.entityIds, nodes));
      setError(undefined);
    } else {
      setError("The core returned a recall that does not match its contract");
    }
  }, [transport, query, nodes]);

  return (
    <Page
      title="Vault"
      subtitle={<VaultStatus status={status} />}
      actions={
        <>
          {onReturn !== undefined && (
            <button type="button" onClick={onReturn} style={buttonStyle}>
              Return to the Objective
            </button>
          )}
          <button
            type="button"
            disabled={transport === undefined}
            onClick={() => {
              void editCommand("promote_now");
            }}
            style={buttonStyle}
          >
            Promote now
          </button>
          <button
            type="button"
            onClick={() => {
              void reindex();
            }}
            style={buttonStyle}
          >
            Reindex
          </button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
        style={{ display: "flex", gap: spacing.sm, alignItems: "center", maxWidth: 560 }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: spacing.sm, flex: 1 }}>
          <span>Recall</span>
          <input
            value={query}
            placeholder="Ask the Vault what it knows"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            style={fieldStyle}
          />
        </label>
        <button type="submit" style={buttonStyle}>
          Search
        </button>
      </form>

      <VaultLock
        transport={transport}
        onChange={() => {
          setRecall(undefined);
          setRevision((current) => current + 1);
        }}
      />

      {recall !== undefined && (
        <div style={{ ...glass, padding: spacing.lg }}>
          <RecallSurface
            query={recall.query}
            freshness={recall.freshness}
            evidence={recall.evidence}
            onOpenInVault={(evidence: RecallEvidenceView) => {
              setFocus(evidence.entityId);
            }}
          />
        </div>
      )}

      {truncated !== undefined && (
        <p style={{ color: semantic.stale, margin: 0 }}>
          Showing {truncated.shown} of {truncated.total} notes — this Vault is larger than one graph
          read. Recall searches all of it.
        </p>
      )}

      <VaultSphere
        nodes={nodes}
        edges={edges}
        {...(focus === undefined ? {} : { focusId: focus })}
        onFocus={setFocus}
      />

      {note !== undefined && focusName !== undefined && <VaultNote name={focusName} state={note} />}

      <VaultEdits
        edits={edits}
        onUndo={(editId) => {
          void editCommand("undo_edit", editId);
        }}
        onApply={(editId) => {
          void editCommand("apply_revision", editId);
        }}
        onDecline={(editId) => {
          void editCommand("decline_revision", editId);
        }}
      />

      {(commandError ?? error) !== undefined && (
        <p role="alert" style={{ color: semantic.error, margin: 0 }}>
          {commandError ?? error}
        </p>
      )}
    </Page>
  );
}

/** What the opened node's own note says, under the sphere. */
export function VaultNote({ name, state }: { name: string; state: NoteState }): JSX.Element {
  return (
    <section aria-label={`Note: ${name}`} style={{ ...glass, padding: spacing.lg, minWidth: 0 }}>
      <h2 style={{ margin: 0, fontSize: typography.scale.md }}>{name}</h2>
      {state.kind === "note" && (
        <>
          <p style={{ margin: `2px 0 ${String(spacing.sm)}px`, color: typography.color.muted }}>
            {state.path}
          </p>
          <div style={{ maxWidth: typography.measurePx, lineHeight: 1.55 }}>
            <Markdown text={state.text} />
          </div>
        </>
      )}
      {state.kind === "reading" && (
        <p style={{ margin: 0, color: typography.color.muted }}>Reading the note…</p>
      )}
      {state.kind === "none" && (
        <p style={{ margin: 0, color: typography.color.muted }}>
          No note has been written for {name} yet. Other notes link to it.
        </p>
      )}
      {state.kind === "failed" && (
        <p style={{ margin: 0, color: semantic.error }}>The core could not read this note.</p>
      )}
    </section>
  );
}

function VaultStatus({
  status,
}: {
  status: z.infer<typeof StatusSchema> | undefined;
}): JSX.Element {
  if (status === undefined) {
    return <span style={{ color: typography.color.muted }}>reading…</span>;
  }

  if (!status.configured) {
    return (
      <span style={{ color: semantic.stale }}>
        no Vault configured — set NOCTIS_VAULT_ROOT to a test Vault
      </span>
    );
  }

  return (
    <span style={{ color: typography.color.muted }}>
      {/* Both switches are reported, because both are off by default and both
          matter: a live Vault is read-only until Phase 14, and writes are a
          separate grant again. */}
      indexed · {status.live ? "live Vault" : "test Vault"} ·{" "}
      {status.writesEnabled ? "writes enabled" : "writes disabled"}
    </span>
  );
}
