import type { RuntimeProposal } from "@noctis/contracts";
import { SURFACE_PAYLOAD_SCHEMAS } from "@noctis/contracts";

import type { CommandContext, Kernel } from "../kernel.js";
import { createObjective, getObjective } from "../objectives/service.js";
import { upsertSurfaceIntent } from "../objectives/surface-intents.js";
import type { Turn } from "./service.js";

/**
 * ADR-0024: a model's proposal is data until the core turns it into one of the
 * existing commands, under `actorType: "identity"`. Nothing here trusts the
 * shape the runtime sent: a Surface payload is validated against the same
 * schema the renderer applies, and an Objective is born `suggested` (0.6) —
 * the model may suggest one, never activate one.
 *
 * Runs as its own command after the item that carried it has committed. It is
 * never nested inside that command.
 */
export function applyProposal(
  kernel: Kernel,
  context: CommandContext,
  turn: Turn,
  proposal: RuntimeProposal,
  idempotencyKey: string,
): void {
  const skip = (reason: string, fields: Record<string, unknown> = {}): void => {
    kernel.logger.log("warn", "runtime proposal skipped", {
      turnId: turn.id,
      kind: proposal.kind,
      reason,
      ...fields,
    });
  };

  if (proposal.kind === "objective") {
    const created = createObjective(kernel, context, {
      idempotencyKey,
      title: proposal.title,
      intent: proposal.intent,
      status: "suggested",
      identityId: turn.identityId,
      protocolIds: [],
    });

    if (!created.ok && created.conflict.kind !== "idempotent_replay") {
      skip(created.conflict.kind);
    }

    return;
  }

  const contract = Object.hasOwn(SURFACE_PAYLOAD_SCHEMAS, proposal.surfaceKind)
    ? SURFACE_PAYLOAD_SCHEMAS[proposal.surfaceKind]
    : undefined;

  if (contract === undefined || contract.payloadVersion !== proposal.payloadVersion) {
    skip("unknown_surface_kind_or_version", { surfaceKind: proposal.surfaceKind });
    return;
  }

  const payload = contract.schema.safeParse(proposal.payload);

  if (!payload.success) {
    skip("invalid_surface_payload", { surfaceKind: proposal.surfaceKind });
    return;
  }

  // A free-chat turn has no canvas to put a Surface on: Chat is the answer there.
  const objectiveId = proposal.objectiveId ?? turn.objectiveId;

  if (objectiveId === undefined || getObjective(kernel.db, objectiveId) === undefined) {
    skip("no_objective_for_surface");
    return;
  }

  const upserted = upsertSurfaceIntent(kernel, context, {
    idempotencyKey,
    objectiveId,
    kind: proposal.surfaceKind,
    role: proposal.role,
    persistence: proposal.persistence,
    priority: proposal.priority,
    // The runtime never says how big: the smallest size, and composition decides.
    minSize: "compact",
    sourceIds: [],
    artifactIds: [],
    payloadVersion: proposal.payloadVersion,
    payload: payload.data,
  });

  if (!upserted.ok && upserted.conflict.kind !== "idempotent_replay") {
    skip(upserted.conflict.kind, { surfaceKind: proposal.surfaceKind });
  }
}
