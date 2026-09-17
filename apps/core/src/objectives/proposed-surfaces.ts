import type { ApprovalRecord, ObjectiveRecord, OrchestrationEvent } from "@noctis/contracts";
import { ApprovalPayloadSchema } from "@noctis/contracts";

import { getApproval } from "../authority/service.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { recallFor } from "../vault/recall.js";
import type { VaultRoot } from "../vault/root.js";
import { getObjective } from "./service.js";
import { upsertSurfaceIntent } from "./surface-intents.js";

/**
 * The Surfaces the core proposes for itself (task 2.7).
 *
 * Until now the page did this: activating an Objective made `apps/web` post
 * three seed intents, run a Vault recall and upsert a fourth, and every pending
 * decision was put on the canvas by whichever page happened to notice. That is
 * policy living in a client. It meant an Objective activated from the phone got
 * a different canvas from one activated at the desk, and it meant `Command.tsx`
 * carried a copy of what an Objective is made of.
 *
 * All five moved here unchanged. The three seeds look like duplication of
 * Command's header, and they are not: the header is chrome around the canvas,
 * and these are what the compositor arranges *on* it. Without them an activated
 * Objective shows an empty canvas until a runtime proposes something, which is
 * the state `apps/web/e2e/workbench.keyboard.test.mjs` exists to prove is not
 * what happens.
 *
 * Everything here runs from committed events, after the commit, so a Surface
 * can never describe state a rollback erased. A failure is logged and dropped:
 * a canvas that did not appear is worse than nothing, but far better than an
 * Objective that could not be activated because a Surface refused.
 *
 * What the page still proposes, and should: `native_application` and
 * `external_tool`. Both describe what is running on the machine in front of the
 * owner, and only a desktop shell can see that. The core has no Win32.
 */

export interface ProposedSurfaceDeps {
  kernel: Kernel;
  vaultRoot?: VaultRoot;
}

/** How many recall quotes a Surface carries. Section 7: focused, not a graph. */
const RECALL_LIMIT = 6;

function context(kernel: Kernel, actorId: string): CommandContext {
  return { correlationId: kernel.ids.nextId(), actorType: "identity", actorId };
}

function skip(kernel: Kernel, reason: string, fields: Record<string, unknown>): void {
  kernel.logger.log("warn", "core surface proposal skipped", { reason, ...fields });
}

/**
 * The Surfaces an Objective is born with.
 *
 * Every field comes from the Objective record itself — nothing is invented to
 * fill a frame. The three are the conversation that started it, the Objective's
 * own facts, and the three things that can be done to it.
 */
export function seedIntents(
  objective: ObjectiveRecord,
): Array<{ kind: string; payload: unknown; role: string; persistence: string; priority: number }> {
  // The identity's own id, capitalised. `IDENTITY_PROFILES` lives in
  // `@noctis/ui` and the core does not depend on a rendering package — and the
  // two names it would look up are "Vesper" and "Jester", which is what this
  // produces. A profile with a display name unlike its id belongs to the
  // renderer, which is free to show something else.
  const author = objective.identityId.charAt(0).toUpperCase() + objective.identityId.slice(1);

  return [
    {
      kind: "conversation",
      role: "primary",
      persistence: "objective",
      priority: 100,
      payload: { messages: [{ id: objective.id, author, text: objective.intent }] },
    },
    {
      kind: "detail",
      role: "supporting",
      // Pinned: the Objective's own facts should survive a recomposition that
      // pushes other Surfaces into overflow.
      persistence: "pinned",
      priority: 50,
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

function placeSeeds(deps: ProposedSurfaceDeps, objective: ObjectiveRecord): void {
  for (const [index, intent] of seedIntents(objective).entries()) {
    const upserted = upsertSurfaceIntent(deps.kernel, context(deps.kernel, objective.identityId), {
      idempotencyKey: `seed:${objective.id}:${String(index)}`,
      objectiveId: objective.id,
      kind: intent.kind,
      role: intent.role as "primary",
      persistence: intent.persistence as "objective",
      priority: intent.priority,
      minSize: index === 0 ? "standard" : "compact",
      sourceIds: [],
      artifactIds: [],
      payloadVersion: 1,
      payload: intent.payload,
    });

    if (!upserted.ok && upserted.conflict.kind !== "idempotent_replay") {
      skip(deps.kernel, upserted.conflict.kind, { objectiveId: objective.id, kind: intent.kind });
    }
  }
}

/**
 * What the Vault already knows about a freshly activated Objective.
 *
 * Section 7: "Command receives only a focused recall Surface". It runs once, on
 * activation, and produces a Surface only when there is something to show —
 * a frame explaining the absence of a Vault would be a frame about Noctis
 * rather than about the work.
 */
function placeRecall(deps: ProposedSurfaceDeps, objective: ObjectiveRecord): void {
  if (deps.vaultRoot === undefined) {
    return;
  }

  const found = recallFor(deps.kernel.db, objective.title, {
    root: deps.vaultRoot,
    limit: RECALL_LIMIT,
  });

  if (found.evidence.length === 0) {
    return;
  }

  const upserted = upsertSurfaceIntent(deps.kernel, context(deps.kernel, objective.identityId), {
    idempotencyKey: `recall:${objective.id}`,
    objectiveId: objective.id,
    kind: "vault_recall",
    role: "context",
    persistence: "objective",
    priority: 30,
    minSize: "compact",
    sourceIds: [],
    artifactIds: [],
    payloadVersion: 1,
    payload: {
      query: objective.title,
      freshness: found.freshness,
      evidence: found.evidence,
    },
  });

  if (!upserted.ok && upserted.conflict.kind !== "idempotent_replay") {
    skip(deps.kernel, upserted.conflict.kind, { objectiveId: objective.id, kind: "vault_recall" });
  }
}

/** The whole approval, as the Surface renders it. Built from the record, never from a summary. */
export function approvalPayload(approval: ApprovalRecord): unknown {
  return ApprovalPayloadSchema.parse({
    id: approval.id,
    consequenceSummary: approval.consequenceSummary,
    operationClass: approval.operationClass,
    capability: approval.capability,
    targetType: approval.target.type,
    targetId: approval.target.id,
    reversibility: approval.reversibility,
    outcome: approval.outcome,
    reasonCodes: approval.reasonCodes,
    ...(approval.estimatedCostGbp === undefined
      ? {}
      : { estimatedCostGbp: approval.estimatedCostGbp }),
    ...(approval.confirmationPhrase === undefined
      ? {}
      : { confirmationPhrase: approval.confirmationPhrase }),
    ...(approval.confirmedAt === undefined ? {} : { confirmedAt: approval.confirmedAt }),
    ...(approval.executedAt === undefined ? {} : { executedAt: approval.executedAt }),
    ...(approval.declinedAt === undefined ? {} : { declinedAt: approval.declinedAt }),
  });
}

/**
 * Puts a decision on the Objective's canvas, and keeps it truthful afterwards.
 *
 * Re-proposed on confirm, execute and decline as well as on the original
 * decision, because the payload carries `confirmedAt`, `executedAt` and
 * `declinedAt` — a Surface left saying "waiting for you" about something
 * already agreed to is a claim about somebody's consent, and that is the one
 * place a stale payload is not merely untidy.
 *
 * ponytail: `sourceIds: []`, so one approval Surface per Objective and a second
 * pending decision replaces the first on the canvas. The approvals list and the
 * authority events still show both. Key it by approval when two simultaneous
 * decisions under one Objective become real.
 */
function placeApproval(deps: ProposedSurfaceDeps, approvalId: string): void {
  const approval = getApproval(deps.kernel.db, approvalId);

  if (approval?.objectiveId === undefined) {
    // A free-chat decision has no canvas. Chat renders it from the authority
    // events it already receives.
    return;
  }

  const objective = getObjective(deps.kernel.db, approval.objectiveId);

  if (objective === undefined) {
    skip(deps.kernel, "no_objective_for_approval", { approvalId });
    return;
  }

  const upserted = upsertSurfaceIntent(deps.kernel, context(deps.kernel, objective.identityId), {
    // Keyed by approval *and* by what has happened to it, so each re-proposal
    // is its own claim rather than a replay of the first one.
    idempotencyKey: `approval:${approvalId}:${approval.declinedAt ?? approval.executedAt ?? approval.confirmedAt ?? "pending"}`,
    objectiveId: approval.objectiveId,
    kind: "approval",
    // Section 5.5's attention state: a decision Noctis is blocked on is the one
    // thing on the canvas that is not about the work but about Noctis waiting.
    role: "attention",
    persistence: "objective",
    // Above every other Surface. A consequence boundary that composed into
    // overflow would be a boundary nobody was asked at.
    priority: 1000,
    minSize: "standard",
    sourceIds: [],
    artifactIds: [],
    payloadVersion: 1,
    payload: approvalPayload(approval),
  });

  if (!upserted.ok && upserted.conflict.kind !== "idempotent_replay") {
    skip(deps.kernel, upserted.conflict.kind, { approvalId, kind: "approval" });
  }
}

/** Outcomes a person still has to answer. The other two are already decided. */
const NEEDS_A_PERSON: ReadonlySet<string> = new Set([
  "require_confirmation",
  "require_typed_confirmation",
]);

/**
 * One committed event in, zero or more Surfaces out.
 *
 * Exported separately from the subscription so the whole rule is testable
 * without a broker, a socket or a clock.
 */
export function proposeFor(deps: ProposedSurfaceDeps, event: OrchestrationEvent): void {
  switch (event.type) {
    case "objective.activated.v1": {
      const objective = getObjective(deps.kernel.db, event.streamId);

      if (objective === undefined) {
        skip(deps.kernel, "objective_missing", { objectiveId: event.streamId });
        return;
      }

      placeSeeds(deps, objective);
      placeRecall(deps, objective);
      return;
    }

    case "authority.decision_recorded.v1": {
      const outcome = (event.payload as { outcome?: unknown }).outcome;

      // An allow or a deny is already settled. Putting it on the canvas as an
      // attention Surface would ask the owner to answer a decided question.
      if (typeof outcome === "string" && NEEDS_A_PERSON.has(outcome)) {
        placeApproval(deps, event.streamId);
      }

      return;
    }

    case "authority.confirmed.v1":
    case "authority.executed.v1":
    case "authority.declined.v1":
      placeApproval(deps, event.streamId);
      return;

    default:
      return;
  }
}

/**
 * Subscribes to the broker. Returns nothing to unsubscribe with, because the
 * broker's lifetime is the core's: `server.ts` subscribes once at start-up and
 * the process owns both.
 */
export function proposeSurfacesFromEvents(deps: ProposedSurfaceDeps): void {
  deps.kernel.broker.subscribe((events) => {
    for (const event of events) {
      try {
        proposeFor(deps, event);
      } catch (error) {
        // A listener that throws takes the broker's other subscribers with it
        // (`createEventBroker` reports but does not isolate per event), and a
        // missing Surface must never cost a push notification.
        skip(deps.kernel, error instanceof Error ? error.message : "unknown", {
          eventType: event.type,
        });
      }
    }
  });
}
