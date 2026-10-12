import type { ObjectiveRecord } from "@noctis/contracts";
import { ObjectiveRecordSchema } from "@noctis/contracts";
import { material, semantic, spacing, typography } from "@noctis/ui";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import type { ConversationState, SendOptions } from "../conversation/useConversation.js";
import type { IdentityRuntimeState } from "../identities/useIdentityRuntime.js";
import { nextKey } from "../idempotency.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { Workbench } from "../workbench/Workbench.js";
import { useComposition } from "../workbench/useComposition.js";
import { useShellSurfaces } from "../workbench/useShellSurfaces.js";
import { ObjectiveList, buttonStyle } from "./ObjectiveList.js";
import { Presence } from "./Presence.js";

/**
 * A 200 does not prove the body came from the core. `parseCoreBody` says as
 * much — a proxy or captive portal can answer anything — so the shape is
 * checked rather than asserted. This exists because it was not: an unmatched
 * dev-proxy path returned the SPA's own HTML with a 200, and reading
 * `.objectives` off it took the whole page down.
 */
const ObjectiveListSchema = z.object({ objectives: z.array(ObjectiveRecordSchema) });

/**
 * As much of an approval as this page acts on. It renders none of it — the
 * Surface does — so only the three fields the retry is derived from.
 */
const ApprovalRecordSchema = z.object({
  id: z.string().min(1),
  capability: z.string().min(1),
  target: z.object({ type: z.string().min(1), id: z.string().min(1) }),
});

export interface CommandProps {
  transport: CoreTransport | undefined;
  /**
   * Owned by App, because Chat needs the same identity and the same Objective.
   * Two `useIdentityRuntime` calls would be two copies of "which identity is
   * active" that could disagree.
   */
  identity: IdentityRuntimeState;
  /** The identity's conversation, for Presence's model selector. */
  conversation: Pick<ConversationState, "models" | "defaultModel" | "canAttach" | "roots">;
  /** Whether a composer has the focus, for Presence's words. */
  listening: boolean;
  /** Presence's prompt: sends on the thread and takes the rail to Chat. */
  onSend: (text: string, options: SendOptions) => void;
  /** Handoff to the dedicated Vault view, from a recall Surface. */
  onOpenInVault?: (entityId: string) => void;
}

/**
 * The Command page: Presence when there is no active Objective, Active Canvas
 * when there is.
 *
 * Objective is state, not a route (Section 5.1) — which is why activating one
 * changes what this single page renders rather than navigating anywhere.
 *
 * It proposes no Surfaces of its own. Task 2.7 moved that into the core
 * (`objectives/proposed-surfaces.ts`): the seed intents, the Vault recall and
 * every pending approval are proposed from committed events, so an Objective
 * activated from the phone gets the same canvas as one activated here. What
 * remains client-side is in `useShellSurfaces`, and only because the core has
 * no Win32 to survey with.
 */
export function Command({
  transport,
  identity,
  conversation,
  listening,
  onSend,
  onOpenInVault,
}: CommandProps): JSX.Element {
  const [objectives, setObjectives] = useState<readonly ObjectiveRecord[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  const active = objectives.find((objective) => objective.id === identity.activeObjectiveId);
  const composition = useComposition(
    transport,
    active === undefined ? undefined : { objectiveId: active.id },
  );
  const { refresh } = composition;
  const shell = useShellSurfaces({ transport, active, composition });
  const { retryConfirmed } = shell;

  /**
   * Confirms a decision, then carries out the thing it authorised.
   *
   * The second half is what makes the first half mean anything.
   * `authority.confirm` records that a person agreed; it does not perform the
   * act, because the core cannot move a window or open a browser — only the
   * shell can. So the act is retried with the approval in hand, and the shell
   * re-checks that the approval covers the thing it is about to do.
   *
   * Nothing re-proposes the approval Surface here any more. The core does it
   * from `authority.confirmed.v1` and `authority.executed.v1`, which is both
   * shorter and more correct: the payload it writes is read from the record
   * after the event, so it can never claim an agreement nobody recorded.
   */
  const confirmApproval = useCallback(
    (approvalId: string, typedConfirmation?: string) => {
      if (transport === undefined) {
        return;
      }

      void (async () => {
        const confirmed = await transport.request("POST", "/commands/authority.confirm", {
          idempotencyKey: nextKey("authority.confirm"),
          requestId: approvalId,
          ...(typedConfirmation === undefined ? {} : { typedConfirmation }),
        });

        if (confirmed.status !== 200) {
          // The core refused — a near-miss on the typed phrase, or an approval
          // that is not confirmable. Nothing is retried.
          setError("That confirmation was not accepted");
          refresh();

          return;
        }

        const record = ApprovalRecordSchema.safeParse(
          (await transport.request("GET", `/approvals/${approvalId}`)).body,
        );

        if (record.success) {
          await retryConfirmed(record.data);
        }

        refresh();
      })().catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : "could not confirm that decision");
      });
    },
    [transport, refresh, retryConfirmed],
  );

  /**
   * Says no to a decision. No retry follows — a decline authorises nothing —
   * and the runtime waiting on this ask is answered by the core from the
   * `authority.declined.v1` event, which also re-proposes the Surface.
   */
  const declineApproval = useCallback(
    (approvalId: string) => {
      if (transport === undefined) {
        return;
      }

      void (async () => {
        const declined = await transport.request("POST", "/commands/authority.decline", {
          idempotencyKey: nextKey("authority.decline"),
          requestId: approvalId,
        });

        if (declined.status !== 200) {
          setError("That decline was not accepted");
        }

        refresh();
      })().catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : "could not decline that decision");
      });
    },
    [transport, refresh],
  );

  /**
   * The "Review the decision" handoff both Surfaces offer.
   *
   * A refresh, now that the core keeps the approval Surface current: the
   * decision is already on the canvas, and re-reading the composition is what
   * brings the latest version of it into view.
   */
  const reviewApproval = useCallback(() => {
    refresh();
  }, [refresh]);

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

  /**
   * Moves an Objective, and nothing else.
   *
   * Activation used to be followed here by three seed intents, a Vault recall
   * and a native survey — a page deciding what an Objective is made of. The
   * core proposes all of that from `objective.activated.v1` now, so this posts
   * one command and lets the events do the rest.
   */
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

      identity.setActiveObjectiveId(status === "active" ? objective.id : undefined);
      setRevision((current) => current + 1);
      setError(undefined);
    },
    [transport, identity],
  );

  if (active === undefined) {
    return (
      <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Presence
          identity={identity}
          transport={transport}
          conversation={conversation}
          listening={listening}
          onSend={onSend}
        />
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
            style={{ ...buttonStyle, background: material.fill }}
          >
            {status === "paused" ? "Pause" : status === "completed" ? "Complete" : "Abandon"}
          </button>
        ))}
      </header>

      <Workbench
        composition={composition}
        handoffs={{
          ...(onOpenInVault === undefined
            ? {}
            : {
                onOpenInVault: (evidence: { entityId: string }) => {
                  onOpenInVault(evidence.entityId);
                },
              }),
          // Agreeing to a consequence needs no shell, so these three are always
          // supplied. The rest arrive only when a desktop shell is behind the page.
          onConfirm: confirmApproval,
          onDecline: declineApproval,
          onReviewApproval: reviewApproval,
          ...shell.handoffs,
        }}
        /**
         * `authority.approve` unconditionally, because agreeing to a
         * consequence is a core concern and works in a plain browser — and
         * because the `approval` registry entry requires it, so without it every
         * proposed decision rendered as a fallback.
         *
         * The shell's two come from `useShellSurfaces` and are empty in a
         * browser. Neither is an authority grant: the core still decides every
         * act on every request.
         */
        capabilities={["authority.approve", ...shell.capabilities]}
      />

      {(error ?? composition.error) !== undefined && (
        <p style={{ color: semantic.error, margin: 0 }}>{error ?? composition.error}</p>
      )}
    </section>
  );
}
