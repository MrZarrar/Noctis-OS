import type {
  ApprovalRecord,
  OrchestrationEvent,
  RuntimeAnswer,
  RuntimeAsk,
} from "@noctis/contracts";

import {
  declineAuthority,
  getApproval,
  getApprovalByAskId,
  requestAuthority,
} from "../authority/service.js";
import type { CommandContext, Kernel } from "../kernel.js";
import type { Dispatcher } from "../nodes/dispatch.js";
import type { Turn } from "./service.js";

/** An ask the human has not answered yet, keyed by approval id so either event finds it. */
export interface PendingAsk {
  nodeId: string;
  jobId: string;
  askId: string;
}

/**
 * ADR-0021: the actions inside a turn ask. The ask becomes an `authority.request`
 * whose idempotency key is the ask id (ADR-0025), so a reconnecting node that
 * re-asks gets the answer already recorded rather than a second decision. The
 * evaluator decides; this only carries the decision back to the node.
 */
export function handleAsk(
  kernel: Kernel,
  dispatcher: Dispatcher,
  pending: Map<string, PendingAsk>,
  turn: Turn,
  nodeId: string,
  jobId: string,
  ask: RuntimeAsk,
): void {
  const context: CommandContext = {
    correlationId: kernel.ids.nextId(),
    actorType: "identity",
    actorId: turn.identityId,
  };
  const decision = requestAuthority(kernel, context, {
    idempotencyKey: ask.askId,
    ...(turn.objectiveId === undefined ? {} : { objectiveId: turn.objectiveId }),
    actorId: turn.identityId,
    operationClass: ask.operationClass,
    capability: ask.capability,
    target: ask.target,
    consequenceSummary: ask.summary,
    ...(ask.detail?.command === undefined ? {} : { consequenceDetail: ask.detail.command }),
    reversibility: ask.reversibility,
    nodeJobId: jobId,
    askId: ask.askId,
    ...(ask.askedBy === "runtime" ? { askedByRuntime: true } : {}),
  });

  const approval = decision.ok
    ? getApproval(kernel.db, decision.value.requestId)
    : decision.conflict.kind === "idempotent_replay"
      ? getApprovalByAskId(kernel.db, ask.askId)
      : undefined;

  if (approval === undefined) {
    // No approval row means no approval id, and an answer without one is not
    // a valid frame. The runtime stays blocked, which is the honest state.
    kernel.logger.log("warn", "an ask could not be recorded", {
      jobId,
      askId: ask.askId,
      reason: decision.ok ? "approval_missing" : decision.conflict.kind,
    });
    return;
  }

  const answer = answerFor(approval, ask.askId);

  if (answer !== undefined) {
    dispatcher.sendAnswer(nodeId, jobId, answer);
    return;
  }

  // The human has to answer. The broker subscription in service.ts watches for
  // the confirm or decline and sends the answer then.
  //
  // Nothing puts a Surface on the canvas here. `objectives/proposed-surfaces.ts`
  // does it from `authority.decision_recorded.v1`, which covers every pending
  // decision rather than only the ones a runtime asked for — a placement the
  // shell requested needs the same boundary and used to get it from the page.
  pending.set(approval.id, { nodeId, jobId, askId: ask.askId });
}

/** The answer the approval row already determines, or undefined while a human is needed. */
function answerFor(approval: ApprovalRecord, askId: string): RuntimeAnswer | undefined {
  const base = { askId, approvalId: approval.id };

  if (approval.declinedAt !== undefined) {
    return { ...base, decision: "deny", reason: "declined" };
  }

  if (approval.outcome === "allow" || approval.confirmedAt !== undefined) {
    // Allowed by policy (an active Objective's local edit, say) or already
    // confirmed by a person. Audited by the approval row; no execute step,
    // because the node's runtime is the thing that will do the act.
    return { ...base, decision: "allow" };
  }

  if (approval.outcome === "deny") {
    return { ...base, decision: "deny", reason: approval.reasonCodes.join(",") };
  }

  return undefined;
}

/** The human answered. Keyed by the approval id both events carry as `streamId`. */
export function answerFromEvent(
  dispatcher: Dispatcher,
  pending: Map<string, PendingAsk>,
  event: OrchestrationEvent,
): void {
  const entry = pending.get(event.streamId);

  if (entry === undefined) {
    return;
  }

  pending.delete(event.streamId);

  if (event.type === "authority.confirmed.v1") {
    dispatcher.sendAnswer(entry.nodeId, entry.jobId, {
      askId: entry.askId,
      approvalId: event.streamId,
      decision: "allow",
    });
    return;
  }

  // Our own `authority.declined.v1` payload; the reason is the owner's words.
  const reason = (event.payload as { reason?: string }).reason ?? "declined";

  dispatcher.sendAnswer(entry.nodeId, entry.jobId, {
    askId: entry.askId,
    approvalId: event.streamId,
    decision: "deny",
    reason,
  });
}

/**
 * The turn ended with a question still open: the node gave up waiting, was
 * cancelled, or crashed. Declining it closes the card, so nobody confirms
 * something that can no longer happen and the audit trail says why.
 */
export function closePendingAsks(
  kernel: Kernel,
  pending: Map<string, PendingAsk>,
  jobId: string,
): void {
  for (const [approvalId, entry] of pending) {
    if (entry.jobId !== jobId) {
      continue;
    }

    // Removed first, so the decline below is not sent to a node that stopped waiting.
    pending.delete(approvalId);
    declineAuthority(
      kernel,
      { correlationId: kernel.ids.nextId(), actorType: "system", actorId: "system" },
      {
        idempotencyKey: `turn-ended:${approvalId}`,
        requestId: approvalId,
        reason: "the turn ended before anyone answered",
      },
    );
  }
}
