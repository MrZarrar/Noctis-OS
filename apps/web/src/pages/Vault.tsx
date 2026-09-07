import type { VaultSphereEdge, VaultSphereNode } from "@noctis/ui";
import {
  RecallSurface,
  VaultSphere,
  corner,
  material,
  semantic,
  spacing,
  typography,
} from "@noctis/ui";
import type { RecallEvidenceView } from "@noctis/ui";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import type { CoreTransport } from "../transport/CoreTransport.js";

/**
 * The dedicated Vault view (Section 7).
 *
 * Separate from Command on purpose: Command receives a focused recall Surface,
 * and this is where the whole graph lives. Arriving here from a recall carries
 * `focusId` and a return control, so the handoff is a round trip rather than a
 * one-way navigation that loses the objective.
 */

const GraphSchema = z.object({
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

const StatusSchema = z.object({
  configured: z.boolean(),
  live: z.boolean(),
  writesEnabled: z.boolean(),
});

const RecallSchema = z.object({
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

export function Vault({ transport, focusId, onReturn }: VaultProps): JSX.Element {
  const [status, setStatus] = useState<z.infer<typeof StatusSchema>>();
  const [nodes, setNodes] = useState<readonly VaultSphereNode[]>([]);
  const [edges, setEdges] = useState<readonly VaultSphereEdge[]>([]);
  const [focus, setFocus] = useState<string | undefined>(focusId);
  const [query, setQuery] = useState("");
  const [recall, setRecall] = useState<z.infer<typeof RecallSchema> & { query: string }>();
  const [error, setError] = useState<string>();
  const [truncated, setTruncated] = useState<{ shown: number; total: number }>();
  const [revision, setRevision] = useState(0);

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
        const [statusResponse, graphResponse] = await Promise.all([
          transport.request("GET", "/vault"),
          transport.request("GET", "/vault/graph"),
        ]);

        if (cancelled) {
          return;
        }

        const parsedStatus = StatusSchema.safeParse(statusResponse.body);
        const parsedGraph = GraphSchema.safeParse(graphResponse.body);

        if (!parsedStatus.success || !parsedGraph.success) {
          setError("The core returned a Vault shape that does not match its contract");
          return;
        }

        setStatus(parsedStatus.data);
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
      setFocus(parsed.data.entityIds[0]);
      setError(undefined);
    } else {
      setError("The core returned a recall that does not match its contract");
    }
  }, [transport, query]);

  return (
    <section
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: spacing.md,
        padding: spacing.lg,
        minWidth: 0,
        overflow: "auto",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: spacing.md }}>
        <h1 style={{ margin: 0, font: `${String(typography.scale.lg)}px ${typography.family}` }}>
          Vault
        </h1>
        <VaultStatus status={status} />
        <span style={{ flex: 1 }} />
        {onReturn !== undefined && (
          <button type="button" onClick={onReturn} style={buttonStyle}>
            Return to the Objective
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            void reindex();
          }}
          style={buttonStyle}
        >
          Reindex
        </button>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
        style={{ display: "flex", gap: spacing.sm }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
          <span>Recall</span>
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            style={{
              width: 320,
              background: material.fill,
              border: `1px solid ${material.border}`,
              borderRadius: corner.sm,
              color: "inherit",
              padding: spacing.sm,
            }}
          />
        </label>
        <button type="submit" style={buttonStyle}>
          Search
        </button>
      </form>

      {recall !== undefined && (
        <div
          style={{
            border: `1px solid ${material.border}`,
            borderRadius: corner.lg,
            padding: spacing.md,
          }}
        >
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

      {error !== undefined && <p style={{ color: semantic.error, margin: 0 }}>{error}</p>}
    </section>
  );
}

const buttonStyle = {
  background: material.fill,
  color: "inherit",
  border: `1px solid ${material.border}`,
  borderRadius: corner.sm,
  padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
  cursor: "pointer",
} as const;

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
