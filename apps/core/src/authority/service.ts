import type {
  AuthorityDecision,
  RequestAuthorityCommand,
  StandingPermission,
} from "@noctis/contracts";
import { AuthorityDecisionSchema, StandingPermissionSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { conflict, evaluateAuthority, ok } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import { getMission } from "../missions/service.js";
import { getObjective } from "../objectives/service.js";

type PermissionRow = {
  id: string;
  actor_id: string;
  capability: string;
  operation_class: string;
  constraints_json: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

type ApprovalRow = {
  id: string;
  outcome: string | null;
  policy_id: string | null;
  reason_codes_json: string;
  permission_id: string | null;
  decided_at: string | null;
  expires_at: string | null;
};

function loadStandingPermissions(db: NoctisDatabase, actorId: string): StandingPermission[] {
  const rows = db
    .prepare(
      `SELECT id, actor_id, capability, operation_class, constraints_json,
              granted_at, expires_at, revoked_at
         FROM standing_permissions
        WHERE actor_id = ? AND revoked_at IS NULL`,
    )
    .all(actorId) as PermissionRow[];

  return rows.map((row) =>
    StandingPermissionSchema.parse({
      id: row.id,
      actorId: row.actor_id,
      capability: row.capability,
      operationClass: row.operation_class,
      constraints: JSON.parse(row.constraints_json) as unknown,
      grantedAt: row.granted_at,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    }),
  );
}

/** Reads back a recorded decision — used to answer an idempotent replay. */
export function getAuthorityDecision(
  db: NoctisDatabase,
  requestId: string,
): AuthorityDecision | undefined {
  const row = db
    .prepare(
      `SELECT id, outcome, policy_id, reason_codes_json, permission_id, decided_at, expires_at
         FROM approvals WHERE id = ?`,
    )
    .get(requestId) as ApprovalRow | undefined;

  if (row === undefined || row.outcome === null || row.decided_at === null) {
    return undefined;
  }

  return AuthorityDecisionSchema.parse({
    requestId: row.id,
    outcome: row.outcome,
    policyId: row.policy_id,
    reasonCodes: JSON.parse(row.reason_codes_json) as unknown,
    ...(row.permission_id === null ? {} : { permissionId: row.permission_id }),
    decidedAt: row.decided_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  });
}

/**
 * Records one authority request and its decision as a single append-only row.
 * The policy is synchronous and pure, so there is no window in which a request
 * exists without a decision, and nothing ever updates the row afterwards.
 */
export function requestAuthority(
  kernel: Kernel,
  context: CommandContext,
  command: RequestAuthorityCommand,
): Result<AuthorityDecision> {
  const id = kernel.ids.nextId();
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<AuthorityDecision>(
    kernel,
    { scope: "authority.request", key: command.idempotencyKey, resultId: id },
    (tx) => {
      const objective =
        command.objectiveId === undefined ? undefined : getObjective(tx, command.objectiveId);

      if (command.objectiveId !== undefined && objective === undefined) {
        return conflict({ kind: "not_found", entity: "objective", id: command.objectiveId });
      }

      if (command.missionId !== undefined && getMission(tx, command.missionId) === undefined) {
        return conflict({ kind: "not_found", entity: "mission", id: command.missionId });
      }

      const evaluation = evaluateAuthority({
        operationClass: command.operationClass,
        capability: command.capability,
        actorId: command.actorId,
        objectiveIsActive: objective?.status === "active",
        standingPermissions: loadStandingPermissions(tx, command.actorId),
        now: kernel.clock.now(),
      });

      const decision = AuthorityDecisionSchema.parse({
        requestId: id,
        outcome: evaluation.outcome,
        policyId: evaluation.policyId,
        reasonCodes: evaluation.reasonCodes,
        ...(evaluation.permissionId === undefined ? {} : { permissionId: evaluation.permissionId }),
        decidedAt: now,
      });

      tx.prepare(
        `INSERT INTO approvals
           (id, objective_id, mission_id, actor_id, operation_class, capability, target_json,
            consequence_summary, reversibility, estimated_cost_gbp, idempotency_key,
            outcome, policy_id, reason_codes_json, permission_id, requested_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        command.objectiveId ?? null,
        command.missionId ?? null,
        command.actorId,
        command.operationClass,
        command.capability,
        JSON.stringify(command.target),
        command.consequenceSummary,
        command.reversibility,
        // ponytail: REAL. Fine for an estimate shown to a human before approval.
        // Convert to integer pence the moment anything sums or reconciles it.
        command.estimatedCostGbp ?? null,
        command.idempotencyKey,
        decision.outcome,
        decision.policyId,
        JSON.stringify(decision.reasonCodes),
        decision.permissionId ?? null,
        now,
        decision.decidedAt,
      );

      return ok({
        value: decision,
        events: [
          {
            id: kernel.ids.nextId(),
            // Its own stream, not the Objective's. An authority decision may
            // reference an Objective, a Mission, both, or neither, so filing it
            // under one of them would misdescribe the other three cases.
            streamType: "authority",
            streamId: id,
            type: "authority.decision_recorded.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              requestId: id,
              ...(command.objectiveId === undefined ? {} : { objectiveId: command.objectiveId }),
              ...(command.missionId === undefined ? {} : { missionId: command.missionId }),
              actorId: command.actorId,
              operationClass: command.operationClass,
              capability: command.capability,
              target: command.target,
              reversibility: command.reversibility,
              outcome: decision.outcome,
              policyId: decision.policyId,
              reasonCodes: decision.reasonCodes,
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}
