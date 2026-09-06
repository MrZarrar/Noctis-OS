import type { ObjectiveRecord } from "@noctis/contracts";
import { ObjectiveRecordSchema } from "@noctis/contracts";
import { IDENTITY_PROFILES, corner, material, semantic, spacing, typography } from "@noctis/ui";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { useIdentityRuntime } from "../identities/useIdentityRuntime.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { Workbench } from "../workbench/Workbench.js";
import { useComposition } from "../workbench/useComposition.js";
import { Presence } from "./Presence.js";

/**
 * A 200 does not prove the body came from the core. `parseCoreBody` says as
 * much — a proxy or captive portal can answer anything — so the shape is
 * checked rather than asserted. This exists because it was not: an unmatched
 * dev-proxy path returned the SPA's own HTML with a 200, and reading
 * `.objectives` off it took the whole page down.
 */
const ObjectiveListSchema = z.object({ objectives: z.array(ObjectiveRecordSchema) });

let keySequence = 0;

function nextKey(scope: string): string {
  keySequence += 1;

  return `web-${scope}-${String(keySequence)}-${String(Date.now())}`;
}

/**
 * The Surfaces an Objective is born with.
 *
 * Every field here comes from the Objective record itself — nothing is invented
 * to fill a frame. When Phase 8 gives the identities a provider, they propose
 * Surfaces through the same `surface.upsert_intent` command and this function
 * goes away; the upsert is keyed by Surface identity, so proposing the same
 * three twice updates them rather than duplicating them.
 */
function seedIntents(objective: ObjectiveRecord): Array<Record<string, unknown>> {
  const author =
    IDENTITY_PROFILES.find((profile) => profile.id === objective.identityId)?.displayName ??
    objective.identityId;

  return [
    {
      kind: "conversation",
      role: "primary",
      persistence: "objective",
      priority: 100,
      minSize: "standard",
      payloadVersion: 1,
      payload: { messages: [{ id: objective.id, author, text: objective.intent }] },
    },
    {
      kind: "detail",
      role: "supporting",
      // Pinned: the Objective's own facts should survive a recomposition that
      // pushes other Surfaces into overflow.
      persistence: "pinned",
      priority: 50,
      minSize: "compact",
      payloadVersion: 1,
      payload: {
        fields: [
          { label: "Title", value: objective.title },
          { label: "Status", value: objective.status },
          { label: "Identity", value: objective.identityId },
          { label: "Activated", value: objective.activatedAt ?? "not yet" },
        ],
      },
    },
    {
      kind: "list",
      role: "context",
      persistence: "objective",
      priority: 10,
      minSize: "compact",
      payloadVersion: 1,
      payload: {
        items: [
          { id: "paused", label: "Pause", detail: "keeps the Objective and its Surfaces" },
          { id: "completed", label: "Complete", detail: "closes it and clears the canvas" },
          { id: "abandoned", label: "Abandon", detail: "closes it without completing" },
        ],
      },
    },
  ];
}

export interface CommandProps {
  transport: CoreTransport | undefined;
  /** Handoff to the dedicated Vault view, from a recall Surface. */
  onOpenInVault?: (entityId: string) => void;
}

/**
 * Runs one recall for the Objective and, only if it found something, proposes
 * the Surface that shows it.
 *
 * Failing quietly is deliberate: no configured Vault, or a Vault with nothing
 * to say, should leave the canvas exactly as it was rather than adding an empty
 * frame explaining its own absence.
 */
async function recallForObjective(
  transport: CoreTransport,
  objective: ObjectiveRecord,
): Promise<void> {
  const response = await transport.request("POST", "/commands/vault.recall", {
    idempotencyKey: nextKey("vault.recall"),
    query: objective.title,
    objectiveId: objective.id,
  });

  const parsed = RecallResultSchema.safeParse(response.body);

  if (response.status !== 200 || !parsed.success || parsed.data.evidence.length === 0) {
    return;
  }

  await transport.request("POST", "/commands/surface.upsert_intent", {
    idempotencyKey: nextKey("surface.upsert_intent"),
    objectiveId: objective.id,
    kind: "vault_recall",
    role: "context",
    persistence: "objective",
    priority: 30,
    minSize: "compact",
    payloadVersion: 1,
    payload: {
      query: objective.title,
      freshness: parsed.data.freshness,
      evidence: parsed.data.evidence,
    },
  });
}

/**
 * What the Vault already knows about a freshly activated Objective.
 *
 * Section 7: "Command receives only a focused recall Surface". The recall runs
 * once, on activation, and becomes one Surface among the others — Command never
 * shows a graph, and a Surface is only created when there is something to show.
 */
const RecallResultSchema = z.object({
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

/**
 * The Command page: Presence when there is no active Objective, Active Canvas
 * when there is.
 *
 * Objective is state, not a route (Section 5.1) — which is why activating one
 * changes what this single page renders rather than navigating anywhere.
 */
export function Command({ transport, onOpenInVault }: CommandProps): JSX.Element {
  const identity = useIdentityRuntime(transport);
  const [objectives, setObjectives] = useState<readonly ObjectiveRecord[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  const active = objectives.find((objective) => objective.id === identity.activeObjectiveId);
  const composition = useComposition(transport, active?.id);

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let cancelled = false;

    transport
      .request("GET", "/objectives?limit=25")
      .then((response) => {
        if (cancelled || response.status !== 200) {
          return;
        }

        const parsed = ObjectiveListSchema.safeParse(response.body);

        if (parsed.success) {
          setObjectives(parsed.data.objectives);
        } else {
          setError("The core returned something that is not a list of Objectives");
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "could not read Objectives");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [transport, revision]);

  const propose = useCallback(async () => {
    if (transport === undefined || title.trim() === "") {
      return;
    }

    const response = await transport.request("POST", "/commands/objective.create", {
      idempotencyKey: nextKey("objective.create"),
      title: title.trim(),
      // Born suggested, exactly as Section 4.2 has it: a proposal, not work.
      status: "suggested",
      intent: title.trim(),
      identityId: identity.activeIdentityId ?? "vesper",
      protocolIds: identity.protocolIds,
    });

    if (response.status === 200) {
      setTitle("");
      setRevision((current) => current + 1);
      setError(undefined);
    } else {
      setError("The core refused that Objective");
    }
  }, [transport, title, identity.activeIdentityId, identity.protocolIds]);

  const changeStatus = useCallback(
    async (objective: ObjectiveRecord, status: string) => {
      if (transport === undefined) {
        return;
      }

      const response = await transport.request("POST", "/commands/objective.change_status", {
        idempotencyKey: nextKey("objective.change_status"),
        objectiveId: objective.id,
        expectedRevision: objective.revision,
        status,
      });

      if (response.status !== 200) {
        setError(`The core refused to move that Objective to ${status}`);
        return;
      }

      const updated = response.body as ObjectiveRecord;

      if (status === "active") {
        for (const intent of seedIntents(updated)) {
          await transport.request("POST", "/commands/surface.upsert_intent", {
            idempotencyKey: nextKey("surface.upsert_intent"),
            objectiveId: updated.id,
            ...intent,
          });
        }

        await recallForObjective(transport, updated);
      }

      identity.setActiveObjectiveId(status === "active" ? updated.id : undefined);
      setRevision((current) => current + 1);
      setError(undefined);
    },
    [transport, identity],
  );

  if (active === undefined) {
    return (
      <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Presence identity={identity} transport={transport} />
        <ObjectiveList
          objectives={objectives}
          title={title}
          onTitleChange={setTitle}
          onPropose={() => {
            void propose();
          }}
          onChangeStatus={(objective, status) => {
            void changeStatus(objective, status);
          }}
        />
        {error !== undefined && (
          <p style={{ color: semantic.error, padding: spacing.md }}>{error}</p>
        )}
      </section>
    );
  }

  return (
    <section
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: spacing.md,
        padding: spacing.lg,
        minWidth: 0,
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: spacing.md }}>
        <h1 style={{ margin: 0, font: `${String(typography.scale.lg)}px ${typography.family}` }}>
          {active.title}
        </h1>
        <span style={{ color: typography.color.muted }}>{active.status}</span>
        <span style={{ flex: 1 }} />
        {(["paused", "completed", "abandoned"] as const).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => {
              void changeStatus(active, status);
            }}
            style={buttonStyle}
          >
            {status === "paused" ? "Pause" : status === "completed" ? "Complete" : "Abandon"}
          </button>
        ))}
      </header>

      <Workbench
        composition={composition}
        {...(onOpenInVault === undefined
          ? {}
          : {
              onOpenInVault: (evidence: { entityId: string }) => {
                onOpenInVault(evidence.entityId);
              },
            })}
      />

      {(error ?? composition.error) !== undefined && (
        <p style={{ color: semantic.error, margin: 0 }}>{error ?? composition.error}</p>
      )}
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

interface ObjectiveListProps {
  objectives: readonly ObjectiveRecord[];
  title: string;
  onTitleChange: (title: string) => void;
  onPropose: () => void;
  onChangeStatus: (objective: ObjectiveRecord, status: string) => void;
}

/** A suggested Objective becomes draft, then active. Never a shortcut between them. */
function nextStatus(objective: ObjectiveRecord): string | undefined {
  if (objective.status === "suggested") {
    return "draft";
  }

  return objective.status === "draft" || objective.status === "paused" ? "active" : undefined;
}

function ObjectiveList({
  objectives,
  title,
  onTitleChange,
  onPropose,
  onChangeStatus,
}: ObjectiveListProps): JSX.Element {
  return (
    <div style={{ padding: spacing.xl, display: "grid", gap: spacing.md, justifyItems: "center" }}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onPropose();
        }}
        style={{ display: "flex", gap: spacing.sm }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
          <span>New Objective</span>
          <input
            value={title}
            onChange={(event) => {
              onTitleChange(event.target.value);
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
          Propose
        </button>
      </form>

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: spacing.xs }}>
        {objectives.map((objective) => {
          const next = nextStatus(objective);

          return (
            <li
              key={objective.id}
              style={{ display: "flex", gap: spacing.sm, alignItems: "center" }}
            >
              <span style={{ minWidth: 320 }}>{objective.title}</span>
              <span style={{ color: typography.color.muted, minWidth: 80 }}>
                {objective.status}
              </span>
              {next !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    onChangeStatus(objective, next);
                  }}
                  style={buttonStyle}
                >
                  {next === "draft" ? "Accept" : "Activate"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
