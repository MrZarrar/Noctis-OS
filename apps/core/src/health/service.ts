import type {
  AllowHealthCommand,
  DisallowHealthCommand,
  HealthCommand,
  HealthDecideCommand,
  HealthStatus,
  NodeCapability,
} from "@noctis/contracts";
import {
  HEALTH_CAPABILITIES,
  HealthRunEvidenceSchema,
  MAX_HEALTH_REPORT_BYTES,
} from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";

import { grantStandingPermission, revokeStandingPermission } from "../authority/service.js";
import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import type { Dispatcher } from "../nodes/dispatch.js";
import type { NodeJobRecord } from "../nodes/jobs.js";
import { enqueueJobInTransaction, getJob } from "../nodes/jobs.js";
import { grantCapability } from "../nodes/registry.js";
import type { Notifier } from "../notify/push.js";
import { lastWeeklyAt } from "../productivity/triggers.js";
import {
  parseHealthReport,
  proposedIds,
  readHealthReport,
  storeHealthReport,
  suggestionIds,
} from "./store.js";

const PERMISSIONS = [
  { actorId: "local", capability: "health.run" },
  { actorId: "local", capability: "health.decide" },
  { actorId: "health", capability: "health.run" },
] as const;
const IN_FLIGHT = "('queued', 'leased', 'running')";

const healthNode = (db: NoctisDatabase, now: number): string | undefined =>
  (
    db
      .prepare(
        `SELECT node_id FROM node_capabilities c JOIN nodes n ON n.id = node_id WHERE n.status != 'revoked' AND capability = 'health.run' AND c.revoked_at IS NULL
           AND (c.expires_at IS NULL OR c.expires_at > ?) ORDER BY granted_at DESC LIMIT 1`,
      )
      .get(new Date(now).toISOString()) as { node_id: string } | undefined
  )?.node_id;

function inFlight(db: NoctisDatabase): "run" | "decide" | "report" | null {
  const row = db
    .prepare(
      `SELECT capability FROM node_jobs WHERE capability LIKE 'health.%' AND status IN ${IN_FLIGHT} ORDER BY capability = 'health.run' DESC LIMIT 1`,
    )
    .get() as { capability: string } | undefined;
  return row === undefined
    ? null
    : (row.capability.slice("health.".length) as "run" | "decide" | "report");
}

export interface HealthServiceDeps {
  kernel: Kernel;
  dispatcher: Pick<Dispatcher, "isConnected" | "pass" | "sendGrants">;
  notifier: Pick<Notifier, "send">;
  weeklyAt: () => string;
  timeZone: string;
}

export interface HealthService {
  accept(nodeId: string, jobId: string, body: AsyncIterable<Buffer>): Promise<boolean>;
  status(): HealthStatus;
  allow(context: CommandContext, command: AllowHealthCommand): Result<{ id: string }>;
  disallow(context: CommandContext, command: DisallowHealthCommand): Result<{ id: string }>;
  refresh(context: CommandContext, command: HealthCommand): Result<NodeJobRecord>;
  runNow(context: CommandContext, command: HealthCommand): Result<NodeJobRecord>;
  decide(context: CommandContext, command: HealthDecideCommand): Result<NodeJobRecord>;
  pass(): void;
  close(): void;
}

export function createHealthService(deps: HealthServiceDeps): HealthService {
  const { kernel } = deps;
  const iso = (): string => new Date(kernel.clock.now()).toISOString();
  let refusedFor: string | undefined;

  function enqueue(
    context: CommandContext,
    key: string,
    capability: NodeCapability,
    payload: Record<string, unknown>,
    after?: (tx: NoctisDatabase, jobId: string) => void,
  ): Result<NodeJobRecord> {
    const nodeId = healthNode(kernel.db, kernel.clock.now());
    if (nodeId === undefined)
      return conflict({ kind: "unavailable", entity: "health", reason: "not_allowed" });
    if (!deps.dispatcher.isConnected(nodeId))
      return conflict({ kind: "unavailable", entity: "health", reason: "pc_offline" });
    const id = kernel.ids.nextId();
    return runCommand<NodeJobRecord>(kernel, { scope: capability, key, resultId: id }, (tx) => {
      const busy = inFlight(tx);
      if (busy === "run")
        return conflict({ kind: "unavailable", entity: "health", reason: "run_in_progress" });
      if (capability === "health.run" && busy !== null)
        return conflict({ kind: "unavailable", entity: "health", reason: "busy" });
      const queued = enqueueJobInTransaction(tx, kernel, context, {
        id,
        capability,
        payload,
        idempotencyKey: `health:${id}`,
        pinnedNodeId: nodeId,
      });
      if (queued.ok) after?.(tx, id);
      return queued;
    });
  }

  function store(
    jobId: string,
    row: { state: "ok" | "unreadable" | "missing"; body?: string; reason?: string },
  ): void {
    storeHealthReport(kernel.db, { ...row, jobId, receivedAt: iso() });
  }

  // A report that never streamed: the node said why in its evidence.
  const unsubscribe = kernel.broker.subscribe((events) => {
    for (const event of events) {
      if (event.type !== "node.job_result.v1") continue;
      const payload = event.payload as {
        outcome?: string;
        capability?: string;
        evidence?: { report?: string };
      };
      if (payload.outcome !== "succeeded" || !payload.capability?.startsWith("health.")) continue;
      if (payload.evidence?.report === "missing") store(event.streamId, { state: "missing" });
      if (payload.evidence?.report === "too_large")
        store(event.streamId, { state: "unreadable", reason: "report.json is larger than 4 MB" });
    }
  });

  function canAccept(nodeId: string, jobId: string): boolean {
    const job = getJob(kernel.db, jobId)?.job;
    if (
      job === undefined ||
      job.nodeId !== nodeId ||
      !(HEALTH_CAPABILITIES as readonly string[]).includes(job.capability) ||
      !["leased", "running"].includes(job.status) ||
      job.leaseExpiresAt === undefined ||
      Date.parse(job.leaseExpiresAt) <= kernel.clock.now()
    )
      return false;
    return (
      kernel.db
        .prepare(
          `SELECT 1 FROM node_capabilities c JOIN nodes n ON n.id = c.node_id WHERE c.node_id = ? AND c.capability = ? AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ?) AND n.status != 'revoked'`,
        )
        .get(nodeId, job.capability, iso()) !== undefined
    );
  }

  return {
    async accept(nodeId, jobId, body) {
      const record = getJob(kernel.db, jobId);
      if (record === undefined || !canAccept(nodeId, jobId)) return false;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > MAX_HEALTH_REPORT_BYTES) return false;
        chunks.push(chunk);
      }
      if (
        !canAccept(nodeId, jobId) ||
        getJob(kernel.db, jobId)?.job.attempts !== record.job.attempts
      )
        return false;
      const text = Buffer.concat(chunks).toString("utf8");
      const parsed = parseHealthReport(text);
      const before = readHealthReport(kernel.db);
      store(jobId, parsed.state === "ok" ? { state: "ok", body: text } : parsed);
      if (record.job.capability === "health.run" && parsed.state === "ok") {
        const previous =
          before?.state === "ok" && before.body !== undefined
            ? parseHealthReport(before.body)
            : undefined;
        const known = previous?.state === "ok" ? suggestionIds(previous.report) : new Set<string>();
        const fresh = proposedIds(parsed.report).filter((id) => !known.has(id)).length;
        if (fresh > 0) {
          void deps.notifier
            .send({
              title: "Health",
              body: `${fresh} new health suggestion${fresh === 1 ? "" : "s"}`,
              url: "/",
              tag: "health",
            })
            .catch(() => undefined);
        }
      }
      return true;
    },

    status() {
      const now = kernel.clock.now();
      const nodeId = healthNode(kernel.db, now) ?? null;
      const stored = readHealthReport(kernel.db);
      const parsed =
        stored?.state === "ok" && stored.body !== undefined
          ? parseHealthReport(stored.body)
          : undefined;
      const run = kernel.db
        .prepare(
          `SELECT status, result_json, failure_reason, updated_at FROM node_jobs
                   WHERE capability = 'health.run' AND status IN ('succeeded', 'failed') ORDER BY updated_at DESC LIMIT 1`,
        )
        .get() as
        | {
            status: string;
            result_json: string | null;
            failure_reason: string | null;
            updated_at: string;
          }
        | undefined;
      const evidence = run?.result_json
        ? HealthRunEvidenceSchema.safeParse(JSON.parse(run.result_json)).data
        : undefined;
      return {
        granted: nodeId !== null,
        nodeId,
        nodeOnline: nodeId !== null && deps.dispatcher.isConnected(nodeId),
        busy: inFlight(kernel.db),
        lastRun:
          run === undefined
            ? null
            : run.status === "failed" || evidence === undefined
              ? {
                  at: run.updated_at,
                  outcome: "failed",
                  ...(run.failure_reason ? { reason: run.failure_reason.slice(0, 300) } : {}),
                }
              : {
                  at: run.updated_at,
                  outcome: evidence.outcome,
                  ...(evidence.reason === undefined ? {} : { reason: evidence.reason }),
                },
        weeklyAt: deps.weeklyAt(),
        report:
          stored === undefined
            ? { state: "none" }
            : stored.state === "missing"
              ? { state: "missing", receivedAt: stored.receivedAt }
              : parsed?.state === "ok"
                ? { state: "ok", receivedAt: stored.receivedAt, report: parsed.report }
                : {
                    state: "unreadable",
                    receivedAt: stored.receivedAt,
                    reason:
                      stored.reason ??
                      (parsed?.state === "unreadable" ? parsed.reason : "unreadable"),
                  },
        proposed: parsed?.state === "ok" ? proposedIds(parsed.report).length : 0,
      };
    },

    allow(context, command) {
      const completed = kernel.db
        .prepare("SELECT result_id FROM idempotency_keys WHERE scope = 'health.allow' AND key = ?")
        .get(command.idempotencyKey) as { result_id: string } | undefined;
      if (completed !== undefined) return ok({ id: completed.result_id });
      // Each step replays under its own derived key, so a retry after a partial failure finishes the set.
      for (const capability of HEALTH_CAPABILITIES) {
        const granted = grantCapability(kernel, context, {
          idempotencyKey: `${command.idempotencyKey}:${capability}`,
          nodeId: command.nodeId,
          capability,
          constraints: {
            repo: command.repo,
            ...(command.home === undefined ? {} : { home: command.home }),
          },
        });
        if (!granted.ok && granted.conflict.kind !== "idempotent_replay") return granted;
      }
      for (const permission of PERMISSIONS) {
        const active = kernel.db
          .prepare(
            "SELECT id FROM standing_permissions WHERE actor_id = ? AND capability = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
          )
          .get(permission.actorId, permission.capability, iso());
        if (active !== undefined) continue;
        const granted = grantStandingPermission(kernel, context, {
          idempotencyKey: `${command.idempotencyKey}:${permission.actorId}:${permission.capability}`,
          ...permission,
          operationClass: "local_reversible_edit",
          constraints: { targetType: "capability", targetIds: [permission.capability] },
        });
        if (!granted.ok && granted.conflict.kind !== "idempotent_replay") return granted;
      }
      return runCommand(
        kernel,
        { scope: "health.allow", key: command.idempotencyKey, resultId: command.nodeId },
        () => ok({ value: { id: command.nodeId }, events: [] }),
      );
    },

    disallow(context, command) {
      const completed = kernel.db
        .prepare(
          "SELECT result_id FROM idempotency_keys WHERE scope = 'health.disallow' AND key = ?",
        )
        .get(command.idempotencyKey) as { result_id: string } | undefined;
      if (completed !== undefined) return ok({ id: completed.result_id });
      const permissions = kernel.db
        .prepare(
          "SELECT id FROM standing_permissions WHERE capability LIKE 'health.%' AND revoked_at IS NULL",
        )
        .all() as { id: string }[];
      for (const { id } of permissions) {
        const revoked = revokeStandingPermission(kernel, context, {
          idempotencyKey: `${command.idempotencyKey}:${id}`,
          permissionId: id,
          reason: "health disallowed",
        });
        if (!revoked.ok && revoked.conflict.kind !== "idempotent_replay") return revoked;
      }
      const result = runCommand(
        kernel,
        { scope: "health.disallow", key: command.idempotencyKey, resultId: command.nodeId },
        (tx) => {
          tx.prepare(
            "UPDATE node_capabilities SET revoked_at = ? WHERE node_id = ? AND capability LIKE 'health.%' AND revoked_at IS NULL",
          ).run(iso(), command.nodeId);
          return ok({ value: { id: command.nodeId }, events: [] });
        },
      );
      return !result.ok && result.conflict.kind === "idempotent_replay"
        ? ok({ id: command.nodeId })
        : result;
    },

    refresh: (context, command) => enqueue(context, command.idempotencyKey, "health.report", {}),
    runNow: (context, command) => enqueue(context, command.idempotencyKey, "health.run", {}),
    decide: (context, command) =>
      enqueue(context, command.idempotencyKey, "health.decide", {
        id: command.id,
        action: command.action,
      }),

    pass() {
      const at = deps.weeklyAt();
      if (at === "") return;
      const due = lastWeeklyAt(
        { daysOfWeek: [0], timeOfDay: at, timeZone: deps.timeZone },
        kernel.clock.now(),
      );
      if (due === undefined) return;
      const occurrence = new Date(due).toISOString();
      const served = kernel.db
        .prepare("SELECT job_id FROM health_runs WHERE occurrence = ?")
        .get(occurrence) as { job_id: string } | undefined;
      const status =
        served === undefined ? undefined : getJob(kernel.db, served.job_id)?.job.status;
      if (status !== undefined && status !== "expired" && status !== "cancelled") return;
      const nodeId = healthNode(kernel.db, kernel.clock.now());
      if (
        nodeId === undefined ||
        !deps.dispatcher.isConnected(nodeId) ||
        inFlight(kernel.db) !== null
      )
        return;
      const queued = enqueue(
        { correlationId: kernel.ids.nextId(), actorType: "system", actorId: "health" },
        `weekly:${occurrence}:${kernel.ids.nextId()}`,
        "health.run",
        {},
        (tx, jobId) => {
          tx.prepare(
            `INSERT INTO health_runs (occurrence, job_id, created_at) VALUES (?, ?, ?)
           ON CONFLICT (occurrence) DO UPDATE SET job_id = excluded.job_id`,
          ).run(occurrence, jobId, iso());
        },
      );
      if (queued.ok) {
        deps.dispatcher.pass();
      } else if (refusedFor !== occurrence) {
        refusedFor = occurrence;
        kernel.logger.log("warn", "weekly health run refused", { conflict: queued.conflict.kind });
      }
    },

    close: unsubscribe,
  };
}
