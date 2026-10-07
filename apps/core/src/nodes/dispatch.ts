import type {
  NodeJobAssignment,
  NodeServerFrame,
  RuntimeAnswer,
  RuntimeDelegationResult,
} from "@noctis/contracts";
import { NODE_ENVELOPE_VERSION } from "@noctis/contracts";

import type { CommandContext, Kernel } from "../kernel.js";
import { getMission } from "../missions/service.js";
import { signAssignment } from "./credentials.js";
import {
  abandonJob,
  expireJob,
  isRetryable,
  leaseJob,
  listExpiredLeases,
  listQueuedJobs,
  MAX_ATTEMPTS,
  requeueJob,
} from "./jobs.js";
import { disconnectNode, listRouteCandidates } from "./registry.js";
import type { RouteRefusal } from "./router.js";
import { routeJob } from "./router.js";

/** How often the core sweeps lapsed leases and retries placing queued work. */
export const DISPATCH_INTERVAL_MS = 5_000;

const DISPATCH_BATCH = 100;

export interface NodeConnection {
  nodeId: string;
  connectionId: string;
  /**
   * The credential the node received in its `welcome` frame, held for the life
   * of this connection so job signatures verify against what the node actually
   * has — not against whatever generation the row has since moved to.
   */
  credential: string;
  send(frame: NodeServerFrame): void;
  close(code: number, reason: string): void;
}

export interface Dispatcher {
  register(connection: NodeConnection): void;
  /** Ignores a stale connection, so a reconnect that raced a close is not undone. */
  unregister(connection: NodeConnection): void;
  isConnected(nodeId: string): boolean;
  sendCancel(nodeId: string, jobId: string): boolean;
  /** The core's decision on an `ask`. False if the node is not connected to receive it. */
  sendAnswer(nodeId: string, jobId: string, answer: RuntimeAnswer): boolean;
  /** How a delegation ended, on the parent turn's job. False if the node is not connected. */
  sendDelegated(nodeId: string, jobId: string, result: RuntimeDelegationResult): boolean;
  /** Drops a node's socket. Revoking a node that stays connected is not revoked. */
  disconnect(nodeId: string, code: number, reason: string): boolean;
  /** One sweep: lapsed leases first, then placement of queued work. */
  pass(): void;
  start(): void;
  stop(): void;
  /**
   * True once `stop` has run. A socket closing during shutdown must not try to
   * write its own offline transition: `stop` already recorded it, and the
   * database is about to close underneath it.
   */
  isStopping(): boolean;
  readonly connectedCount: number;
}

function systemContext(kernel: Kernel): CommandContext {
  return { correlationId: kernel.ids.nextId(), actorType: "system", actorId: "core" };
}

export interface DispatcherOptions {
  kernel: Kernel;
  intervalMs?: number;
}

/**
 * Owns which nodes are connected, and is the only thing that hands work out.
 *
 * Liveness lives here rather than in `nodes.status`, because the row records the
 * last thing that happened and a socket that died without a close frame leaves
 * `online` behind. The router is told what this map knows.
 */
export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const { kernel } = options;
  const connections = new Map<string, NodeConnection>();
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;

  function reclaimLapsedLeases(): void {
    const nowIso = new Date(kernel.clock.now()).toISOString();

    for (const record of listExpiredLeases(kernel.db, nowIso)) {
      const { id, attempts, capability } = record.job;
      const expired = expireJob(kernel, systemContext(kernel), { jobId: id, attempts });

      if (!expired.ok) {
        kernel.logger.log("warn", "could not expire a lapsed lease", {
          jobId: id,
          conflict: expired.conflict.kind,
        });
        continue;
      }

      if (!isRetryable(capability)) {
        // Section 10 step 8. Left `expired` on purpose: a consequential
        // operation may or may not have landed, and re-running it blind is how
        // one uncertain write becomes two.
        kernel.logger.log("warn", "lease expired on a job that needs reconciliation", {
          jobId: id,
          capability,
        });
        continue;
      }

      const outcome =
        attempts >= MAX_ATTEMPTS
          ? abandonJob(kernel, systemContext(kernel), { jobId: id, attempts })
          : requeueJob(kernel, systemContext(kernel), { jobId: id, attempts });

      if (!outcome.ok) {
        kernel.logger.log("warn", "could not settle an expired job", {
          jobId: id,
          conflict: outcome.conflict.kind,
        });
      }
    }
  }

  function dispatch(): void {
    const queued = listQueuedJobs(kernel.db, DISPATCH_BATCH);

    if (queued.length === 0) {
      return;
    }

    const candidates = listRouteCandidates(kernel.db).map((candidate) => ({
      ...candidate,
      connected: connections.has(candidate.nodeId),
    }));

    for (const record of queued) {
      const { id, capability, missionId, pinnedNodeId, attempts } = record.job;
      const mission = missionId === undefined ? undefined : getMission(kernel.db, missionId);
      const outcome = routeJob({
        capability: capability as NodeJobAssignment["capability"],
        // A job with no Mission has nothing constraining where it runs.
        hostPolicy: mission?.hostPolicy ?? "any_granted_host",
        ...(mission?.hostId === undefined ? {} : { hostId: mission.hostId }),
        ...(pinnedNodeId === undefined ? {} : { pinnedNodeId }),
        candidates,
        now: kernel.clock.now(),
      });

      if (!outcome.ok) {
        kernel.logger.log("debug", "job stays queued", { jobId: id, reason: outcome.reason });
        continue;
      }

      const connection = connections.get(outcome.nodeId);

      if (connection === undefined) {
        continue;
      }

      const leased = leaseJob(kernel, systemContext(kernel), {
        jobId: id,
        nodeId: outcome.nodeId,
        attempts,
      });

      if (!leased.ok) {
        kernel.logger.log("warn", "could not lease a routed job", {
          jobId: id,
          conflict: leased.conflict.kind,
        });
        continue;
      }

      const leaseExpiresAt = leased.value.job.leaseExpiresAt;

      if (leaseExpiresAt === undefined) {
        throw new Error(`Leased job ${id} has no lease expiry`);
      }

      const assignment: NodeJobAssignment = {
        jobId: id,
        nodeId: outcome.nodeId,
        capability: capability as NodeJobAssignment["capability"],
        payloadVersion: record.job.payloadVersion,
        payload: record.job.payload,
        idempotencyKey: record.job.idempotencyKey,
        leaseExpiresAt,
        attempt: leased.value.job.attempts,
      };

      const json = JSON.stringify(assignment);

      // The lease is already committed. If this send fails the job's lease
      // simply lapses and the sweep requeues it, which is the same path a node
      // that received the job and then died takes.
      connection.send({
        kind: "job",
        envelopeVersion: NODE_ENVELOPE_VERSION,
        assignment: json,
        signature: signAssignment(connection.credential, json),
      });

      // One fewer free slot on that node for the rest of this pass.
      const chosen = candidates.find((candidate) => candidate.nodeId === outcome.nodeId);

      if (chosen !== undefined) {
        chosen.activeLeases += 1;
      }
    }
  }

  function pass(): void {
    reclaimLapsedLeases();
    dispatch();
  }

  return {
    register(connection) {
      const existing = connections.get(connection.nodeId);

      if (existing !== undefined && existing !== connection) {
        // One node, one socket. A second connection for the same node is either
        // a reconnect the core has not noticed yet or a stolen credential, and
        // both are resolved by keeping the newest and closing the old.
        existing.close(1008, "replaced by a newer connection");
      }

      connections.set(connection.nodeId, connection);
    },
    unregister(connection) {
      if (connections.get(connection.nodeId) === connection) {
        connections.delete(connection.nodeId);
      }
    },
    isConnected(nodeId) {
      return connections.has(nodeId);
    },
    disconnect(nodeId, code, reason) {
      const connection = connections.get(nodeId);

      if (connection === undefined) {
        return false;
      }

      connections.delete(nodeId);
      connection.close(code, reason);
      return true;
    },
    sendCancel(nodeId, jobId) {
      const connection = connections.get(nodeId);

      if (connection === undefined) {
        return false;
      }

      connection.send({ kind: "cancel", envelopeVersion: NODE_ENVELOPE_VERSION, jobId });
      return true;
    },
    sendAnswer(nodeId, jobId, answer) {
      const connection = connections.get(nodeId);

      if (connection === undefined) {
        return false;
      }

      connection.send({ kind: "answer", envelopeVersion: NODE_ENVELOPE_VERSION, jobId, answer });
      return true;
    },
    sendDelegated(nodeId, jobId, result) {
      const connection = connections.get(nodeId);

      if (connection === undefined) {
        return false;
      }

      connection.send({
        kind: "delegated",
        envelopeVersion: NODE_ENVELOPE_VERSION,
        jobId,
        result,
      });
      return true;
    },
    pass,
    start() {
      if (timer !== undefined) {
        return;
      }

      timer = setInterval(() => {
        try {
          pass();
        } catch (error) {
          // A sweep that throws must not take the interval with it, or the core
          // silently stops dispatching for the rest of its life.
          kernel.logger.log("error", "dispatch pass failed", {
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      }, options.intervalMs ?? DISPATCH_INTERVAL_MS);

      // Never a reason to hold the process open on its own.
      timer.unref();
    },
    stop() {
      stopping = true;

      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }

      for (const connection of connections.values()) {
        // Recorded here, while the database is still open, rather than left to
        // each socket's close handler to write after shutdown has moved on.
        const marked = disconnectNode(kernel, systemContext(kernel), {
          nodeId: connection.nodeId,
          connectionId: connection.connectionId,
        });

        if (!marked.ok) {
          kernel.logger.log("warn", "could not mark node offline at shutdown", {
            nodeId: connection.nodeId,
            conflict: marked.conflict.kind,
          });
        }

        connection.close(1001, "core is shutting down");
      }

      connections.clear();
    },
    isStopping() {
      return stopping;
    },
    get connectedCount() {
      return connections.size;
    },
  };
}

/**
 * The reason a queued job has not been placed, computed on read rather than
 * stored. Always the current reason, and it costs the ledger nothing.
 */
export function explainQueued(
  kernel: Kernel,
  dispatcher: Dispatcher,
  job: { capability: string; missionId?: string; pinnedNodeId?: string },
): RouteRefusal | undefined {
  const mission = job.missionId === undefined ? undefined : getMission(kernel.db, job.missionId);
  const outcome = routeJob({
    capability: job.capability as NodeJobAssignment["capability"],
    hostPolicy: mission?.hostPolicy ?? "any_granted_host",
    ...(mission?.hostId === undefined ? {} : { hostId: mission.hostId }),
    ...(job.pinnedNodeId === undefined ? {} : { pinnedNodeId: job.pinnedNodeId }),
    candidates: listRouteCandidates(kernel.db).map((candidate) => ({
      ...candidate,
      connected: dispatcher.isConnected(candidate.nodeId),
    })),
    now: kernel.clock.now(),
  });

  return outcome.ok ? undefined : outcome.reason;
}
