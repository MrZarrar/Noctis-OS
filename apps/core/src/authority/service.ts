import type {
  ApprovalRecord,
  AuthorityDecision,
  ConfirmAuthorityCommand,
  DeclineAuthorityCommand,
  ExecuteAuthorityCommand,
  GrantStandingPermissionCommand,
  RequestAuthorityCommand,
  RevokeStandingPermissionCommand,
  StandingPermission,
} from "@noctis/contracts";
import {
  ApprovalRecordSchema,
  AuthorityDecisionSchema,
  StandingPermissionSchema,
} from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { confirmationMatches, conflict, evaluateAuthority, ok } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import { getMission } from "../missions/service.js";
import { getObjective } from "../objectives/service.js";

/**
 * The AuthorityService (Section 9.1).
 *
 * It has three acts and they are deliberately separate calls:
 *
 * - `requestAuthority` asks what the policy says and records the answer;
 * - `confirmAuthority` is a human answering at the exact consequence boundary;
 * - `executeAuthority` records that the consequence happened, once.
 *
 * Collapsing any two of them would remove the boundary. A request that also
 * confirmed would let the caller answer its own question; a confirmation that
 * also executed would make preparation and commitment the same act, which is
 * exactly what Section 9.1's "preparation ... must stop before the external
 * commit boundary" forbids.
 */

type PermissionRow = {
  id: string;
  actor_id: string;
  capability: string;
  operation_class: string;
  constraints_json: string;
  granted_at: string;
  granted_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
};

type ApprovalRow = {
  id: string;
  objective_id: string | null;
  mission_id: string | null;
  actor_id: string;
  operation_class: string;
  capability: string;
  target_json: string;
  consequence_summary: string;
  reversibility: string;
  estimated_cost_gbp: number | null;
  outcome: string | null;
  policy_id: string | null;
  reason_codes_json: string;
  permission_id: string | null;
  confirmation_phrase: string | null;
  requested_at: string;
  decided_at: string | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  executed_at: string | null;
  execution_evidence_version: number | null;
  execution_evidence_json: string | null;
  declined_at: string | null;
  declined_by: string | null;
  node_job_id: string | null;
  ask_id: string | null;
};

const APPROVAL_COLUMNS = `id, objective_id, mission_id, actor_id, operation_class, capability,
                          target_json, consequence_summary, reversibility, estimated_cost_gbp,
                          outcome, policy_id, reason_codes_json, permission_id,
                          confirmation_phrase, requested_at, decided_at, confirmed_at,
                          confirmed_by, executed_at, execution_evidence_version,
                          execution_evidence_json, declined_at, declined_by, node_job_id, ask_id`;

const PERMISSION_COLUMNS = `id, actor_id, capability, operation_class, constraints_json,
                            granted_at, granted_by, expires_at, revoked_at, revoked_reason`;

function toPermission(row: PermissionRow): StandingPermission {
  return StandingPermissionSchema.parse({
    id: row.id,
    actorId: row.actor_id,
    capability: row.capability,
    operationClass: row.operation_class,
    constraints: JSON.parse(row.constraints_json) as unknown,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    ...(row.revoked_reason === null ? {} : { revokedReason: row.revoked_reason }),
  });
}

function toApproval(row: ApprovalRow): ApprovalRecord | undefined {
  if (row.outcome === null || row.decided_at === null || row.policy_id === null) {
    return undefined;
  }

  return ApprovalRecordSchema.parse({
    id: row.id,
    ...(row.objective_id === null ? {} : { objectiveId: row.objective_id }),
    ...(row.mission_id === null ? {} : { missionId: row.mission_id }),
    actorId: row.actor_id,
    operationClass: row.operation_class,
    capability: row.capability,
    target: JSON.parse(row.target_json) as unknown,
    consequenceSummary: row.consequence_summary,
    reversibility: row.reversibility,
    ...(row.estimated_cost_gbp === null ? {} : { estimatedCostGbp: row.estimated_cost_gbp }),
    outcome: row.outcome,
    policyId: row.policy_id,
    reasonCodes: JSON.parse(row.reason_codes_json) as unknown,
    ...(row.permission_id === null ? {} : { permissionId: row.permission_id }),
    ...(row.confirmation_phrase === null ? {} : { confirmationPhrase: row.confirmation_phrase }),
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    ...(row.confirmed_at === null ? {} : { confirmedAt: row.confirmed_at }),
    ...(row.confirmed_by === null ? {} : { confirmedBy: row.confirmed_by }),
    ...(row.executed_at === null ? {} : { executedAt: row.executed_at }),
    ...(row.execution_evidence_json === null
      ? {}
      : { executionEvidence: JSON.parse(row.execution_evidence_json) as unknown }),
    ...(row.declined_at === null ? {} : { declinedAt: row.declined_at }),
    ...(row.declined_by === null ? {} : { declinedBy: row.declined_by }),
    ...(row.node_job_id === null ? {} : { nodeJobId: row.node_job_id }),
    ...(row.ask_id === null ? {} : { askId: row.ask_id }),
  });
}

/** Live grants for one actor. Revoked rows never leave the database. */
export function loadStandingPermissionsFor(
  db: NoctisDatabase,
  actorId: string,
): StandingPermission[] {
  const rows = db
    .prepare(
      `SELECT ${PERMISSION_COLUMNS} FROM standing_permissions
        WHERE actor_id = ? AND revoked_at IS NULL`,
    )
    .all(actorId) as PermissionRow[];

  return rows.map(toPermission);
}

export function listStandingPermissions(db: NoctisDatabase, limit: number): StandingPermission[] {
  const rows = db
    .prepare(`SELECT ${PERMISSION_COLUMNS} FROM standing_permissions ORDER BY granted_at LIMIT ?`)
    .all(limit) as PermissionRow[];

  return rows.map(toPermission);
}

export function getStandingPermission(
  db: NoctisDatabase,
  id: string,
): StandingPermission | undefined {
  const row = db
    .prepare(`SELECT ${PERMISSION_COLUMNS} FROM standing_permissions WHERE id = ?`)
    .get(id) as PermissionRow | undefined;

  return row === undefined ? undefined : toPermission(row);
}

export function getApproval(db: NoctisDatabase, id: string): ApprovalRecord | undefined {
  const row = db.prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?`).get(id) as
    ApprovalRow | undefined;

  return row === undefined ? undefined : toApproval(row);
}

/** The node's handle for a pending ask; `idx_approvals_ask` makes this one lookup. */
export function getApprovalByAskId(db: NoctisDatabase, askId: string): ApprovalRecord | undefined {
  const row = db
    .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE ask_id = ?`)
    .get(askId) as ApprovalRow | undefined;

  return row === undefined ? undefined : toApproval(row);
}

export function listApprovals(db: NoctisDatabase, limit: number): ApprovalRecord[] {
  const rows = db
    .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals ORDER BY requested_at DESC LIMIT ?`)
    .all(limit) as ApprovalRow[];

  return rows
    .map(toApproval)
    .filter((approval): approval is ApprovalRecord => approval !== undefined);
}

/** Reads back a recorded decision — used to answer an idempotent replay. */
export function getAuthorityDecision(
  db: NoctisDatabase,
  requestId: string,
): AuthorityDecision | undefined {
  const approval = getApproval(db, requestId);

  if (approval === undefined) {
    return undefined;
  }

  return AuthorityDecisionSchema.parse({
    requestId: approval.id,
    outcome: approval.outcome,
    policyId: approval.policyId,
    reasonCodes: approval.reasonCodes,
    ...(approval.permissionId === undefined ? {} : { permissionId: approval.permissionId }),
    ...(approval.confirmationPhrase === undefined
      ? {}
      : { confirmationPhrase: approval.confirmationPhrase }),
    decidedAt: approval.decidedAt,
  });
}

/**
 * Records one authority request and its decision as a single append-only row.
 * The policy is synchronous and pure, so there is no window in which a request
 * exists without a decision, and nothing ever updates the decision afterwards.
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
        target: command.target,
        ...(command.estimatedCostGbp === undefined
          ? {}
          : { estimatedCostGbp: command.estimatedCostGbp }),
        objectiveIsActive: objective?.status === "active",
        standingPermissions: loadStandingPermissionsFor(tx, command.actorId),
        now: kernel.clock.now(),
      });

      const decision = AuthorityDecisionSchema.parse({
        requestId: id,
        outcome: evaluation.outcome,
        policyId: evaluation.policyId,
        reasonCodes: evaluation.reasonCodes,
        ...(evaluation.permissionId === undefined ? {} : { permissionId: evaluation.permissionId }),
        ...(evaluation.confirmationPhrase === undefined
          ? {}
          : { confirmationPhrase: evaluation.confirmationPhrase }),
        decidedAt: now,
      });

      tx.prepare(
        `INSERT INTO approvals
           (id, objective_id, mission_id, actor_id, operation_class, capability, target_json,
            consequence_summary, reversibility, estimated_cost_gbp, idempotency_key,
            outcome, policy_id, reason_codes_json, permission_id, confirmation_phrase,
            requested_at, decided_at, node_job_id, ask_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        decision.confirmationPhrase ?? null,
        now,
        decision.decidedAt,
        command.nodeJobId ?? null,
        command.askId ?? null,
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
              ...(command.nodeJobId === undefined ? {} : { nodeJobId: command.nodeJobId }),
              ...(command.askId === undefined ? {} : { askId: command.askId }),
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

/**
 * A human answering at the consequence boundary.
 *
 * Two refusals matter here and neither is negotiable. A decision that demanded
 * a typed phrase is not confirmed by a click, and a decision the policy denied
 * is not confirmed at all — a user cannot approve past a `deny`, because a
 * `deny` is not a question.
 */
export function confirmAuthority(
  kernel: Kernel,
  context: CommandContext,
  command: ConfirmAuthorityCommand,
): Result<ApprovalRecord> {
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<ApprovalRecord>(
    kernel,
    { scope: "authority.confirm", key: command.idempotencyKey, resultId: command.requestId },
    (tx) => {
      const approval = getApproval(tx, command.requestId);

      if (approval === undefined) {
        return conflict({ kind: "not_found", entity: "approval", id: command.requestId });
      }

      if (approval.outcome === "deny") {
        return conflict({
          kind: "authority_refused",
          requestId: approval.id,
          outcome: "deny",
          reasonCodes: ["policy_denied_cannot_be_confirmed"],
        });
      }

      if (approval.declinedAt !== undefined) {
        return conflict({
          kind: "authority_refused",
          requestId: approval.id,
          outcome: approval.outcome,
          reasonCodes: ["declined"],
        });
      }

      if (approval.executedAt !== undefined) {
        return conflict({
          kind: "authority_refused",
          requestId: approval.id,
          outcome: approval.outcome,
          reasonCodes: ["already_executed"],
        });
      }

      if (approval.confirmedAt !== undefined) {
        // Confirming twice is not a failure, but it is not a second act either.
        // The first confirmation stands, unchanged.
        return ok({ value: approval, events: [] });
      }

      if (approval.outcome === "require_typed_confirmation") {
        const phrase = approval.confirmationPhrase;

        if (phrase === undefined || !confirmationMatches(phrase, command.typedConfirmation)) {
          return conflict({
            kind: "authority_refused",
            requestId: approval.id,
            outcome: approval.outcome,
            reasonCodes: ["typed_confirmation_did_not_match"],
          });
        }
      }

      tx.prepare("UPDATE approvals SET confirmed_at = ?, confirmed_by = ? WHERE id = ?").run(
        now,
        context.actorId,
        approval.id,
      );

      const confirmed = getApproval(tx, approval.id);

      if (confirmed === undefined) {
        throw new Error(`Approval ${approval.id} vanished mid-transaction`);
      }

      return ok({
        value: confirmed,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "authority",
            streamId: approval.id,
            type: "authority.confirmed.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              requestId: approval.id,
              operationClass: approval.operationClass,
              capability: approval.capability,
              target: approval.target,
              // Never the phrase itself. It names the target, and an audit log
              // is a poorer place for that than the approval row already is.
              typed: approval.outcome === "require_typed_confirmation",
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

/**
 * The commit boundary, crossed once.
 *
 * `executed_at` is written inside the transaction that checks it is null, so
 * two concurrent submits cannot both pass. The idempotency key makes a retry of
 * the *same* submit safe; this check is what makes a *different* submit of the
 * same consequence refuse — which is the half a key alone cannot do, because a
 * second click generates a second key.
 */
export function executeAuthority(
  kernel: Kernel,
  context: CommandContext,
  command: ExecuteAuthorityCommand,
): Result<ApprovalRecord> {
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<ApprovalRecord>(
    kernel,
    { scope: "authority.execute", key: command.idempotencyKey, resultId: command.requestId },
    (tx) => {
      const approval = getApproval(tx, command.requestId);

      if (approval === undefined) {
        return conflict({ kind: "not_found", entity: "approval", id: command.requestId });
      }

      if (approval.declinedAt !== undefined) {
        return conflict({
          kind: "authority_refused",
          requestId: approval.id,
          outcome: approval.outcome,
          reasonCodes: ["declined"],
        });
      }

      if (approval.executedAt !== undefined) {
        return conflict({
          kind: "authority_refused",
          requestId: approval.id,
          outcome: approval.outcome,
          reasonCodes: ["already_executed"],
        });
      }

      if (approval.outcome === "deny") {
        return conflict({
          kind: "authority_refused",
          requestId: approval.id,
          outcome: "deny",
          reasonCodes: ["policy_denied"],
        });
      }

      // `allow` needs no confirmation by definition; everything else does, and
      // an unconfirmed one is a preparation that tried to commit itself.
      if (approval.outcome !== "allow" && approval.confirmedAt === undefined) {
        return conflict({
          kind: "authority_refused",
          requestId: approval.id,
          outcome: approval.outcome,
          reasonCodes: ["not_confirmed"],
        });
      }

      const updated = tx
        .prepare(
          `UPDATE approvals
              SET executed_at = ?, execution_evidence_version = ?, execution_evidence_json = ?
            WHERE id = ? AND executed_at IS NULL`,
        )
        .run(now, command.evidenceVersion, JSON.stringify(command.evidence ?? null), approval.id);

      if (updated.changes !== 1) {
        // Only reachable if another writer executed between the read and the
        // write. The guard is in the `WHERE`, so it loses rather than duplicates.
        return conflict({
          kind: "authority_refused",
          requestId: approval.id,
          outcome: approval.outcome,
          reasonCodes: ["already_executed"],
        });
      }

      const executed = getApproval(tx, approval.id);

      if (executed === undefined) {
        throw new Error(`Approval ${approval.id} vanished mid-transaction`);
      }

      return ok({
        value: executed,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "authority",
            streamId: approval.id,
            type: "authority.executed.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              requestId: approval.id,
              operationClass: approval.operationClass,
              capability: approval.capability,
              target: approval.target,
              reversibility: approval.reversibility,
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

/**
 * The human says no. A policy `deny` is not a question; a decline is an answer
 * to one, and it is recorded as a fact rather than left as an absence, so the
 * executor that asked can be told.
 *
 * A yes already given at the boundary is not undone by a later no — the
 * executor was told yes and may be mid-act; telling it to stop is a separate
 * conversation. A `deny` can still be declined: it is the owner's no on top of
 * policy's, and it costs nothing to keep.
 */
export function declineAuthority(
  kernel: Kernel,
  context: CommandContext,
  command: DeclineAuthorityCommand,
): Result<ApprovalRecord> {
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<ApprovalRecord>(
    kernel,
    { scope: "authority.decline", key: command.idempotencyKey, resultId: command.requestId },
    (tx) => {
      const approval = getApproval(tx, command.requestId);

      if (approval === undefined) {
        return conflict({ kind: "not_found", entity: "approval", id: command.requestId });
      }

      if (approval.executedAt !== undefined) {
        return conflict({
          kind: "authority_refused",
          requestId: approval.id,
          outcome: approval.outcome,
          reasonCodes: ["already_executed"],
        });
      }

      if (approval.confirmedAt !== undefined) {
        return conflict({
          kind: "authority_refused",
          requestId: approval.id,
          outcome: approval.outcome,
          reasonCodes: ["already_confirmed"],
        });
      }

      if (approval.declinedAt !== undefined) {
        // Same shape as a second confirm: the first no stands, nothing new happened.
        return ok({ value: approval, events: [] });
      }

      tx.prepare("UPDATE approvals SET declined_at = ?, declined_by = ? WHERE id = ?").run(
        now,
        context.actorId,
        approval.id,
      );

      const declined = getApproval(tx, approval.id);

      if (declined === undefined) {
        throw new Error(`Approval ${approval.id} vanished mid-transaction`);
      }

      return ok({
        value: declined,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "authority",
            streamId: approval.id,
            type: "authority.declined.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              requestId: approval.id,
              operationClass: approval.operationClass,
              capability: approval.capability,
              target: approval.target,
              ...(command.reason === undefined ? {} : { reason: command.reason }),
              ...(approval.nodeJobId === undefined ? {} : { nodeJobId: approval.nodeJobId }),
              ...(approval.askId === undefined ? {} : { askId: approval.askId }),
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

export function grantStandingPermission(
  kernel: Kernel,
  context: CommandContext,
  command: GrantStandingPermissionCommand,
): Result<StandingPermission> {
  const id = kernel.ids.nextId();
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<StandingPermission>(
    kernel,
    { scope: "authority.grant_permission", key: command.idempotencyKey, resultId: id },
    (tx) => {
      tx.prepare(
        `INSERT INTO standing_permissions
           (id, actor_id, capability, operation_class, constraints_json, granted_at, granted_by,
            expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        command.actorId,
        command.capability,
        command.operationClass,
        JSON.stringify(command.constraints),
        now,
        context.actorId,
        command.expiresAt ?? null,
      );

      const permission = getStandingPermission(tx, id);

      if (permission === undefined) {
        throw new Error(`Permission ${id} vanished mid-transaction`);
      }

      return ok({
        value: permission,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "authority",
            streamId: id,
            type: "permission.granted.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              permissionId: id,
              actorId: command.actorId,
              capability: command.capability,
              operationClass: command.operationClass,
              constraints: command.constraints,
              ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

/**
 * Revocation is a timestamp, not a delete. A permission that once existed and
 * was used has to stay readable, or the decisions it upgraded become
 * unexplainable.
 */
export function revokeStandingPermission(
  kernel: Kernel,
  context: CommandContext,
  command: RevokeStandingPermissionCommand,
): Result<StandingPermission> {
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<StandingPermission>(
    kernel,
    {
      scope: "authority.revoke_permission",
      key: command.idempotencyKey,
      resultId: command.permissionId,
    },
    (tx) => {
      const existing = getStandingPermission(tx, command.permissionId);

      if (existing === undefined) {
        return conflict({
          kind: "not_found",
          entity: "standing_permission",
          id: command.permissionId,
        });
      }

      if (existing.revokedAt !== undefined) {
        return ok({ value: existing, events: [] });
      }

      tx.prepare(
        "UPDATE standing_permissions SET revoked_at = ?, revoked_reason = ? WHERE id = ?",
      ).run(now, command.reason, command.permissionId);

      const revoked = getStandingPermission(tx, command.permissionId);

      if (revoked === undefined) {
        throw new Error(`Permission ${command.permissionId} vanished mid-transaction`);
      }

      return ok({
        value: revoked,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "authority",
            streamId: command.permissionId,
            type: "permission.revoked.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              permissionId: command.permissionId,
              actorId: existing.actorId,
              capability: existing.capability,
              reason: command.reason,
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}
