import type {
  CancelNodeJobCommand,
  EnqueueNodeJobCommand,
  NodeCapability,
  NodeJob,
  NodeJobStatus,
} from "@noctis/contracts";
import { CAPABILITY_CONTRACTS, CAPABILITY_OPERATION_CLASS, NodeJobSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { conflict, evaluateAuthority, ok, transitionNodeJobStatus } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { Mutation } from "../db/transactions.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import { loadStandingPermissionsFor } from "../authority/service.js";
import { getMission } from "../missions/service.js";

/** Short enough that a lost node frees its work quickly; long enough for a real read. */
export const LEASE_MS = 30_000;

/**
 * A job that has burned this many leases is not going to succeed. Cancelled
 * rather than left queued, so nothing re-dispatches it forever.
 */
export const MAX_ATTEMPTS = 3;

/** Terminal for the purposes of "is this job still going to do something". */
const TERMINAL: ReadonlySet<NodeJobStatus> = new Set<NodeJobStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * Capabilities never re-run blind even though their class is `read_inspect`. A
 * turn may have edited files before its lease lapsed; re-running it is how one
 * uncertain edit becomes two.
 */
const NEVER_RETRIED: ReadonlySet<NodeCapability> = new Set<NodeCapability>(["runtime.turn"]);

type JobRow = {
  id: string;
  mission_id: string | null;
  node_id: string | null;
  pinned_node_id: string | null;
  capability: string;
  status: string;
  idempotency_key: string;
  lease_expires_at: string | null;
  attempts: number;
  payload_version: number;
  payload_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  result_json: string | null;
  failure_reason: string | null;
};

const JOB_COLUMNS = `id, mission_id, node_id, pinned_node_id, capability, status, idempotency_key, lease_expires_at,
                     attempts, payload_version, payload_json, revision, created_at, updated_at,
                     result_json, failure_reason`;

/**
 * `NodeJob` plus what a node returned. The contract schema describes the job,
 * not its evidence, so the evidence rides alongside rather than being forced
 * into a shape that would then have to be optional everywhere.
 */
export interface NodeJobRecord {
  job: NodeJob;
  result?: unknown;
  failureReason?: string;
}

function toRecord(row: JobRow): NodeJobRecord {
  const job = NodeJobSchema.parse({
    id: row.id,
    ...(row.mission_id === null ? {} : { missionId: row.mission_id }),
    ...(row.node_id === null ? {} : { nodeId: row.node_id }),
    ...(row.pinned_node_id === null ? {} : { pinnedNodeId: row.pinned_node_id }),
    capability: row.capability,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    attempts: row.attempts,
    payloadVersion: row.payload_version,
    payload: JSON.parse(row.payload_json) as unknown,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return {
    job,
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }),
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
  };
}

export function getJob(db: NoctisDatabase, id: string): NodeJobRecord | undefined {
  const row = db.prepare(`SELECT ${JOB_COLUMNS} FROM node_jobs WHERE id = ?`).get(id) as
    JobRow | undefined;

  return row === undefined ? undefined : toRecord(row);
}

export function listQueuedJobs(db: NoctisDatabase, limit: number): NodeJobRecord[] {
  const rows = db
    .prepare(`SELECT ${JOB_COLUMNS} FROM node_jobs WHERE status = 'queued' ORDER BY id LIMIT ?`)
    .all(limit) as JobRow[];

  return rows.map(toRecord);
}

/** Jobs whose lease has run out. Ordered by id so a sweep is deterministic. */
export function listExpiredLeases(db: NoctisDatabase, nowIso: string): NodeJobRecord[] {
  const rows = db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM node_jobs
        WHERE status IN ('leased', 'running') AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
        ORDER BY id`,
    )
    .all(nowIso) as JobRow[];

  return rows.map(toRecord);
}

export interface EnqueueJobInput {
  /** Pre-allocated so the caller's idempotency claim can name it. Allocated here if absent. */
  id?: string;
  capability: NodeCapability;
  payload: unknown;
  idempotencyKey: string;
  missionId?: string;
  pinnedNodeId?: string;
}

/**
 * Queues one job inside a transaction the caller already holds. `enqueueJob`
 * wraps it in its own command; a service queuing a job as part of a larger
 * command (a conversation turn) calls this directly, so nothing nests `runCommand`.
 */
export function enqueueJobInTransaction(
  tx: NoctisDatabase,
  kernel: Kernel,
  context: CommandContext,
  input: EnqueueJobInput,
): Result<Mutation<NodeJobRecord>> {
  const id = input.id ?? kernel.ids.nextId();
  const nowIso = new Date(kernel.clock.now()).toISOString();
  // Parsed here rather than at execution, so a payload the capability cannot
  // accept never becomes a queued job that will fail on some node later.
  const payload = CAPABILITY_CONTRACTS[input.capability].payload.parse(input.payload);

  if (input.missionId !== undefined) {
    const mission = getMission(tx, input.missionId);

    if (mission === undefined) {
      return conflict({ kind: "not_found", entity: "mission", id: input.missionId });
    }
  }

  // Section 9: "Test action dispatcher and node execution through
  // AuthorityService only." A queued job is work a node will do on a real
  // machine, so the policy decides here, before the row exists — not at
  // lease time, where a refusal would leave a job nobody may ever run, and
  // not on the node, which is the thing being authorised.
  //
  // The operation class comes from CAPABILITY_OPERATION_CLASS rather than
  // from the command, so a caller cannot understate what it is asking for.
  const operationClass = CAPABILITY_OPERATION_CLASS[input.capability];
  const decision = evaluateAuthority({
    operationClass,
    capability: input.capability,
    actorId: context.actorId,
    target: { type: "capability", id: input.capability },
    objectiveIsActive: false,
    standingPermissions: loadStandingPermissionsFor(tx, context.actorId),
    now: kernel.clock.now(),
  });

  if (decision.outcome !== "allow") {
    // Enqueuing is preparation, and preparation stops at the consequence
    // boundary. Anything needing a human answer goes through
    // authority.request and authority.confirm first, and arrives here as a
    // capability the policy already allows.
    return conflict({
      kind: "authority_refused",
      requestId: id,
      outcome: decision.outcome,
      reasonCodes: decision.reasonCodes,
    });
  }

  tx.prepare(
    `INSERT INTO node_jobs
       (id, mission_id, pinned_node_id, capability, status, idempotency_key, attempts,
        payload_version, payload_json, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, 0, 1, ?, 0, ?, ?)`,
  ).run(
    id,
    input.missionId ?? null,
    input.pinnedNodeId ?? null,
    input.capability,
    input.idempotencyKey,
    JSON.stringify(payload),
    nowIso,
    nowIso,
  );

  const record = getJob(tx, id);

  if (record === undefined) {
    throw new Error(`Job ${id} vanished mid-transaction`);
  }

  return ok({
    value: record,
    events: [
      {
        id: kernel.ids.nextId(),
        streamType: "node_job",
        streamId: id,
        type: "node.job_queued.v1",
        actorType: context.actorType,
        actorId: context.actorId,
        payloadVersion: 1,
        payload: {
          capability: input.capability,
          operationClass,
          ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
          ...(input.pinnedNodeId === undefined ? {} : { pinnedNodeId: input.pinnedNodeId }),
        },
        correlationId: context.correlationId,
        occurredAt: nowIso,
      },
    ],
  });
}

export function enqueueJob(
  kernel: Kernel,
  context: CommandContext,
  command: EnqueueNodeJobCommand,
): Result<NodeJobRecord> {
  const id = kernel.ids.nextId();

  return runCommand<NodeJobRecord>(
    kernel,
    { scope: "node.job_enqueue", key: command.idempotencyKey, resultId: id },
    (tx) =>
      enqueueJobInTransaction(tx, kernel, context, {
        id,
        capability: command.capability,
        payload: command.payload,
        idempotencyKey: command.idempotencyKey,
        ...(command.missionId === undefined ? {} : { missionId: command.missionId }),
      }),
  );
}

export function leaseJob(
  kernel: Kernel,
  context: CommandContext,
  input: { jobId: string; nodeId: string; attempts: number; leaseMs?: number },
): Result<NodeJobRecord> {
  const now = kernel.clock.now();
  const nowIso = new Date(now).toISOString();
  const leaseExpiresAt = new Date(now + (input.leaseMs ?? LEASE_MS)).toISOString();

  return runCommand<NodeJobRecord>(
    kernel,
    // Keyed by attempt as well as job: re-leasing a job whose lease expired is a
    // new claim, not a replay of the one that was lost.
    {
      scope: "node.job_lease",
      key: `${input.jobId}:${String(input.attempts + 1)}`,
      resultId: input.jobId,
    },
    (tx) => {
      const existing = getJob(tx, input.jobId);

      if (existing === undefined) {
        return conflict({ kind: "not_found", entity: "node_job", id: input.jobId });
      }

      const transition = transitionNodeJobStatus(existing.job.status, "leased");

      if (!transition.ok) {
        return conflict(transition.conflict);
      }

      const attempts = existing.job.attempts + 1;

      tx.prepare(
        `UPDATE node_jobs
            SET status = 'leased', node_id = ?, lease_expires_at = ?, attempts = ?,
                revision = revision + 1, updated_at = ?
          WHERE id = ?`,
      ).run(input.nodeId, leaseExpiresAt, attempts, nowIso, input.jobId);

      const updated = getJob(tx, input.jobId);

      if (updated === undefined) {
        throw new Error(`Job ${input.jobId} vanished mid-transaction`);
      }

      return ok({
        value: updated,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "node_job",
            streamId: input.jobId,
            type: "node.job_leased.v1",
            actorType: "system",
            actorId: "core",
            payloadVersion: 1,
            payload: {
              nodeId: input.nodeId,
              capability: existing.job.capability,
              attempt: attempts,
              leaseExpiresAt,
            },
            correlationId: context.correlationId,
            occurredAt: nowIso,
          },
        ],
      });
    },
  );
}

export interface JobResultInput {
  jobId: string;
  /** The node the frame arrived from, not a node the frame claims to be. */
  nodeId: string;
  outcome: "succeeded" | "failed";
  evidence: unknown;
  failureReason?: string;
}

export class EvidenceRejected extends Error {}

/**
 * Records a node's result.
 *
 * Everything a node asserts is checked against what the core already knows: the
 * job exists, it was leased to this node, its lease has not run out, and the
 * evidence matches the schema its capability declares. A node cannot report a
 * result for a job it was not given, and cannot report evidence of a shape the
 * capability never promised — Section 10 step 7.
 */
export function completeJob(
  kernel: Kernel,
  context: CommandContext,
  input: JobResultInput,
): Result<NodeJobRecord> {
  const now = kernel.clock.now();
  const nowIso = new Date(now).toISOString();

  return runCommand<NodeJobRecord>(
    kernel,
    // One result per job, whatever the node sends afterwards.
    { scope: "node.job_result", key: `result:${input.jobId}`, resultId: input.jobId },
    (tx) => {
      const existing = getJob(tx, input.jobId);

      if (existing === undefined || existing.job.nodeId !== input.nodeId) {
        return conflict({ kind: "not_found", entity: "node_job", id: input.jobId });
      }

      if (
        existing.job.leaseExpiresAt !== undefined &&
        Date.parse(existing.job.leaseExpiresAt) <= now
      ) {
        // The lease is what authorised the work. Accepting a result after it
        // lapsed would let two nodes both "win" a job the core already requeued.
        return conflict({
          kind: "forbidden_transition",
          machine: "node_job",
          from: `${existing.job.status}:lease_expired`,
          to: input.outcome,
        });
      }

      const transition = transitionNodeJobStatus(existing.job.status, input.outcome);

      if (!transition.ok) {
        return conflict(transition.conflict);
      }

      const capability = existing.job.capability as NodeCapability;
      const contract = Object.hasOwn(CAPABILITY_CONTRACTS, capability)
        ? CAPABILITY_CONTRACTS[capability]
        : undefined;

      if (contract === undefined) {
        throw new EvidenceRejected(`Job ${input.jobId} names unknown capability ${capability}`);
      }

      // A failed job carries a reason, not evidence: there is no successful
      // observation to validate, and demanding one would force a node to invent it.
      const evidence =
        input.outcome === "succeeded" ? contract.evidence.parse(input.evidence) : null;

      tx.prepare(
        `UPDATE node_jobs
            SET status = ?, result_json = ?, failure_reason = ?, lease_expires_at = NULL,
                revision = revision + 1, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.outcome,
        evidence === null ? null : JSON.stringify(evidence),
        input.failureReason ?? null,
        nowIso,
        input.jobId,
      );

      const updated = getJob(tx, input.jobId);

      if (updated === undefined) {
        throw new Error(`Job ${input.jobId} vanished mid-transaction`);
      }

      const missionId = existing.job.missionId;

      if (missionId !== undefined && evidence !== null) {
        // Mission-linked evidence belongs on the Mission too, or a Mission's
        // evidence trail would stop at the boundary of whatever ran the step.
        tx.prepare(
          `INSERT INTO mission_evidence
             (id, mission_id, kind, host_id, summary, payload_version, payload_json, observed_at)
           VALUES (?, ?, 'result', ?, ?, 1, ?, ?)`,
        ).run(
          kernel.ids.nextId(),
          missionId,
          input.nodeId,
          `${capability} completed on node ${input.nodeId}`,
          JSON.stringify(evidence),
          nowIso,
        );
      }

      return ok({
        value: updated,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "node_job",
            streamId: input.jobId,
            type: "node.job_result.v1",
            actorType: "node",
            actorId: input.nodeId,
            payloadVersion: 1,
            payload: {
              outcome: input.outcome,
              capability,
              attempt: existing.job.attempts,
              ...(missionId === undefined ? {} : { missionId }),
              ...(evidence === null ? {} : { evidence }),
              ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
            },
            correlationId: context.correlationId,
            occurredAt: nowIso,
          },
        ],
      });
    },
  );
}

function changeStatus(
  kernel: Kernel,
  context: CommandContext,
  input: { jobId: string; to: NodeJobStatus; reason: string; scope: string; key: string },
): Result<NodeJobRecord> {
  const nowIso = new Date(kernel.clock.now()).toISOString();

  return runCommand<NodeJobRecord>(
    kernel,
    { scope: input.scope, key: input.key, resultId: input.jobId },
    (tx) => {
      const existing = getJob(tx, input.jobId);

      if (existing === undefined) {
        return conflict({ kind: "not_found", entity: "node_job", id: input.jobId });
      }

      const transition = transitionNodeJobStatus(existing.job.status, input.to);

      if (!transition.ok) {
        return conflict(transition.conflict);
      }

      // Leaving the node on the row would claim it still owns work it does not.
      const clearNode = input.to === "queued";
      // A running job is still leased: clearing the lease here would make it
      // un-expirable, and a result that arrived years later would be accepted.
      const keepLease = input.to === "running";

      tx.prepare(
        `UPDATE node_jobs
            SET status = ?, lease_expires_at = ?, node_id = ?,
                revision = revision + 1, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.to,
        keepLease ? (existing.job.leaseExpiresAt ?? null) : null,
        clearNode ? null : (existing.job.nodeId ?? null),
        nowIso,
        input.jobId,
      );

      const updated = getJob(tx, input.jobId);

      if (updated === undefined) {
        throw new Error(`Job ${input.jobId} vanished mid-transaction`);
      }

      return ok({
        value: updated,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "node_job",
            streamId: input.jobId,
            type: "node.job_status_changed.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              from: existing.job.status,
              to: input.to,
              reason: input.reason,
              attempt: existing.job.attempts,
            },
            correlationId: context.correlationId,
            occurredAt: nowIso,
          },
        ],
      });
    },
  );
}

/**
 * The node has started doing the work: leased -> running, once. A second call
 * is a no-op with no event, so a node that streams a thousand frames writes one
 * status change.
 */
export function startJob(
  kernel: Kernel,
  context: CommandContext,
  input: { jobId: string; nodeId: string },
): Result<NodeJobRecord> {
  const existing = getJob(kernel.db, input.jobId);

  if (existing === undefined || existing.job.nodeId !== input.nodeId) {
    return conflict({ kind: "not_found", entity: "node_job", id: input.jobId });
  }

  if (existing.job.status === "running") {
    return ok(existing);
  }

  return changeStatus(kernel, context, {
    jobId: input.jobId,
    to: "running",
    reason: "runtime_started",
    scope: "node.job_start",
    key: `${input.jobId}:${String(existing.job.attempts)}`,
  });
}

/**
 * Pushes a held lease forward by `LEASE_MS` from `now`. True if a row changed;
 * false means the node does not hold this job any more and the frame that
 * prompted the renewal should not be trusted.
 *
 * ponytail: a direct UPDATE, no command, no event, no idempotency claim. A
 * renewal is an advisory heartbeat like progress; writing an event per frame
 * would append to the ledger every few hundred milliseconds. If a reader ever
 * needs lease history, add a `node.job_renewed.v1` behind a sampling gate.
 */
export function renewLease(
  db: NoctisDatabase,
  input: { jobId: string; nodeId: string; now: number },
): boolean {
  const nowIso = new Date(input.now).toISOString();
  const outcome = db
    .prepare(
      `UPDATE node_jobs SET lease_expires_at = ?
        WHERE id = ? AND node_id = ? AND status IN ('leased', 'running')
          AND lease_expires_at > ?`,
    )
    .run(new Date(input.now + LEASE_MS).toISOString(), input.jobId, input.nodeId, nowIso);

  return outcome.changes > 0;
}

/** The lease ran out. A separate step from requeueing, because they are separate facts. */
export function expireJob(
  kernel: Kernel,
  context: CommandContext,
  input: { jobId: string; attempts: number },
): Result<NodeJobRecord> {
  return changeStatus(kernel, context, {
    jobId: input.jobId,
    to: "expired",
    reason: "lease_expired",
    scope: "node.job_expire",
    key: `${input.jobId}:${String(input.attempts)}`,
  });
}

/**
 * Section 10 step 8: "Lease expiry permits safe retry only for idempotent
 * operations. Consequential operations require reconciliation."
 *
 * Only `read_inspect` capabilities are safe to re-run blind. Anything else stays
 * `expired` — a state that means "somebody has to find out what actually
 * happened", which is the honest answer when a write may or may not have landed.
 */
export function isRetryable(capability: string): boolean {
  return (
    Object.hasOwn(CAPABILITY_OPERATION_CLASS, capability) &&
    !NEVER_RETRIED.has(capability as NodeCapability) &&
    CAPABILITY_OPERATION_CLASS[capability as NodeCapability] === "read_inspect"
  );
}

export function requeueJob(
  kernel: Kernel,
  context: CommandContext,
  input: { jobId: string; attempts: number },
): Result<NodeJobRecord> {
  return changeStatus(kernel, context, {
    jobId: input.jobId,
    to: "queued",
    reason: "retry_after_lease_expiry",
    scope: "node.job_requeue",
    key: `${input.jobId}:${String(input.attempts)}`,
  });
}

export function cancelJob(
  kernel: Kernel,
  context: CommandContext,
  command: CancelNodeJobCommand,
): Result<NodeJobRecord> {
  return changeStatus(kernel, context, {
    jobId: command.jobId,
    to: "cancelled",
    reason: "operator_cancelled",
    scope: "node.job_cancel",
    key: command.idempotencyKey,
  });
}

export function abandonJob(
  kernel: Kernel,
  context: CommandContext,
  input: { jobId: string; attempts: number },
): Result<NodeJobRecord> {
  return changeStatus(kernel, context, {
    jobId: input.jobId,
    to: "cancelled",
    reason: "attempts_exhausted",
    scope: "node.job_abandon",
    key: `${input.jobId}:${String(input.attempts)}`,
  });
}

export function isTerminal(status: NodeJobStatus): boolean {
  return TERMINAL.has(status);
}
