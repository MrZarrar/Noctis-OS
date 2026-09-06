import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ActivateIdentityCommandSchema,
  CancelNodeJobCommandSchema,
  ChangeMissionStatusCommandSchema,
  ChangeObjectiveStatusCommandSchema,
  CreateMissionCommandSchema,
  CreateObjectiveCommandSchema,
  EnqueueNodeJobCommandSchema,
  GrantNodeCapabilityCommandSchema,
  IssueNodePairingCodeCommandSchema,
  PairNodeRequestSchema,
  RequestAuthorityCommandSchema,
  RevokeNodeCommandSchema,
  UuidSchema,
} from "@noctis/contracts";
import type { DomainConflict, Result } from "@noctis/domain";
import type { z } from "zod";

import { requestAuthority, getAuthorityDecision } from "../authority/service.js";
import type { NoctisDatabase } from "../db/connection.js";
import { latestSequence, readEventsAfter } from "../db/events.js";
import {
  activateIdentity,
  getActiveIdentity,
  getThreadForIdentity,
  replayActivation,
} from "../identities/service.js";
import type { CommandContext, Kernel } from "../kernel.js";
import {
  changeMissionStatus,
  createMission,
  getMission,
  listMissionsForObjective,
} from "../missions/service.js";
import type { Dispatcher } from "../nodes/dispatch.js";
import { explainQueued } from "../nodes/dispatch.js";
import { cancelJob, enqueueJob, getJob } from "../nodes/jobs.js";
import {
  currentCredential,
  getGrant,
  getNode,
  getPairingCode,
  grantCapability,
  issuePairingCode,
  listGrants,
  listNodes,
  pairNode,
  revokeNode,
} from "../nodes/registry.js";
import {
  changeObjectiveStatus,
  createObjective,
  getObjective,
  listObjectives,
} from "../objectives/service.js";
import type { CoreConfig } from "../config/server.js";
import { isAuthorized, isOriginAllowed } from "./auth.js";

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;

/** The one path that does not require the core bearer token. See `pairNode`. */
export const PAIR_PATH = "/node/pair";

export interface ApiDeps {
  kernel: Kernel;
  config: CoreConfig;
  /** Set once at startup; reported by /ready and /diagnostics. */
  schemaVersion: number;
  startedAt: number;
  dispatcher: Dispatcher;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * Fixed, non-revealing error bodies. Nothing here ever carries a stack trace,
 * a SQL fragment, or the value that failed validation — only its field path.
 */
function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function send(res: ServerResponse, status: number, body: unknown, correlationId: string): void {
  const payload = JSON.stringify(body);

  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-correlation-id": correlationId,
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too_large"> {
  const declared = Number(req.headers["content-length"] ?? "0");

  if (Number.isFinite(declared) && declared > limit) {
    return "too_large";
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;

    if (total > limit) {
      req.destroy();
      return "too_large";
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function conflictResponse(domainConflict: DomainConflict): { status: number; body: ErrorBody } {
  switch (domainConflict.kind) {
    case "not_found":
      return {
        status: 404,
        body: errorBody("not_found", `${domainConflict.entity} not found`),
      };
    case "revision_conflict":
      return {
        status: 409,
        body: errorBody("revision_conflict", "The record has changed since it was read", {
          expected: domainConflict.expected,
          actual: domainConflict.actual,
        }),
      };
    case "forbidden_transition":
      return {
        status: 409,
        body: errorBody("forbidden_transition", "That status change is not allowed", {
          machine: domainConflict.machine,
          from: domainConflict.from,
          to: domainConflict.to,
        }),
      };
    case "idempotent_replay":
      // Handled by the command dispatcher, which answers with the original
      // result. Reaching here means a command claimed a key it cannot replay.
      return {
        status: 409,
        body: errorBody("idempotency_key_reused", "That idempotency key belongs to another result"),
      };
  }
}

type Replay = (db: NoctisDatabase, id: string) => unknown;

interface CommandRoute {
  handle: (
    kernel: Kernel,
    context: CommandContext,
    body: unknown,
  ) => { status: number; body: unknown };
}

function defineCommand<S extends z.ZodType>(
  schema: S,
  run: (kernel: Kernel, context: CommandContext, command: z.infer<S>) => Result<unknown>,
  replay: Replay,
): CommandRoute {
  return {
    handle(kernel, context, body) {
      const parsed = schema.safeParse(body);

      if (!parsed.success) {
        return {
          status: 400,
          body: errorBody(
            "invalid_request",
            "The command did not match its schema",
            parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              code: issue.code,
            })),
          ),
        };
      }

      const outcome = run(kernel, context, parsed.data);

      if (outcome.ok) {
        return { status: 200, body: outcome.value };
      }

      if (outcome.conflict.kind === "idempotent_replay") {
        // A retry of a command that already succeeded returns what it returned
        // the first time. That is the whole point of requiring the key.
        const existing = replay(kernel.db, outcome.conflict.existingId);

        if (existing !== undefined) {
          return { status: 200, body: existing };
        }
      }

      return conflictResponse(outcome.conflict);
    },
  };
}

const COMMANDS: Readonly<Record<string, CommandRoute>> = {
  "objective.create": defineCommand(CreateObjectiveCommandSchema, createObjective, (db, id) =>
    getObjective(db, id),
  ),
  "objective.change_status": defineCommand(
    ChangeObjectiveStatusCommandSchema,
    changeObjectiveStatus,
    (db, id) => getObjective(db, id),
  ),
  "mission.create": defineCommand(CreateMissionCommandSchema, createMission, (db, id) =>
    getMission(db, id),
  ),
  "mission.change_status": defineCommand(
    ChangeMissionStatusCommandSchema,
    changeMissionStatus,
    (db, id) => getMission(db, id),
  ),
  "identity.activate": defineCommand(ActivateIdentityCommandSchema, activateIdentity, (db, id) =>
    replayActivation(db, id),
  ),
  "authority.request": defineCommand(RequestAuthorityCommandSchema, requestAuthority, (db, id) =>
    getAuthorityDecision(db, id),
  ),
  "node.issue_pairing_code": defineCommand(
    IssueNodePairingCodeCommandSchema,
    issuePairingCode,
    // Deliberately not the code: the core kept only its digest, so a replay can
    // say the code exists and when it expires but can never repeat it.
    (db, id) => getPairingCode(db, id),
  ),
  "node.revoke": defineCommand(RevokeNodeCommandSchema, revokeNode, (db, id) => getNode(db, id)),
  "node.grant_capability": defineCommand(
    GrantNodeCapabilityCommandSchema,
    grantCapability,
    (db, id) => getGrant(db, id),
  ),
  "node.job_enqueue": defineCommand(EnqueueNodeJobCommandSchema, enqueueJob, (db, id) =>
    getJob(db, id),
  ),
  "node.job_cancel": defineCommand(CancelNodeJobCommandSchema, cancelJob, (db, id) =>
    getJob(db, id),
  ),
};

function parseLimit(raw: string | null): number | undefined {
  if (raw === null) {
    return DEFAULT_PAGE_SIZE;
  }

  const limit = Number(raw);

  return Number.isInteger(limit) && limit > 0 && limit <= MAX_PAGE_SIZE ? limit : undefined;
}

function handleRead(
  deps: ApiDeps,
  segments: readonly string[],
  url: URL,
): { status: number; body: unknown } {
  const limit = parseLimit(url.searchParams.get("limit"));

  if (limit === undefined) {
    return {
      status: 400,
      body: errorBody("invalid_request", `limit must be an integer 1-${String(MAX_PAGE_SIZE)}`),
    };
  }

  if (segments.length === 1 && segments[0] === "objectives") {
    return { status: 200, body: { objectives: listObjectives(deps.kernel.db, limit) } };
  }

  if (segments.length === 1 && segments[0] === "identities") {
    const activeIdentityId = getActiveIdentity(deps.kernel.db);

    return {
      status: 200,
      body: {
        activeIdentityId: activeIdentityId ?? null,
        threads: (["vesper", "jester"] as const)
          .map((identityId) => getThreadForIdentity(deps.kernel.db, identityId))
          .filter((thread) => thread !== undefined),
      },
    };
  }

  if (segments.length === 1 && segments[0] === "nodes") {
    return {
      status: 200,
      body: {
        nodes: listNodes(deps.kernel.db, limit).map((node) => ({
          ...node,
          connected: deps.dispatcher.isConnected(node.id),
        })),
      },
    };
  }

  if (segments.length === 1 && segments[0] === "events") {
    const afterRaw = url.searchParams.get("after") ?? "0";
    const after = Number(afterRaw);

    if (!Number.isInteger(after) || after < 0) {
      return {
        status: 400,
        body: errorBody("invalid_request", "after must be a non-negative integer"),
      };
    }

    return {
      status: 200,
      body: {
        events: readEventsAfter(deps.kernel.db, after, limit),
        latestSequence: latestSequence(deps.kernel.db),
      },
    };
  }

  const [collection, id, sub] = segments;

  if (id === undefined || !UuidSchema.safeParse(id).success) {
    return { status: 404, body: errorBody("not_found", "No such resource") };
  }

  if (collection === "objectives" && sub === undefined) {
    const objective = getObjective(deps.kernel.db, id);

    return objective === undefined
      ? { status: 404, body: errorBody("not_found", "objective not found") }
      : { status: 200, body: objective };
  }

  if (collection === "objectives" && sub === "missions") {
    return {
      status: 200,
      body: { missions: listMissionsForObjective(deps.kernel.db, id, limit) },
    };
  }

  if (collection === "missions" && sub === undefined) {
    const mission = getMission(deps.kernel.db, id);

    return mission === undefined
      ? { status: 404, body: errorBody("not_found", "mission not found") }
      : { status: 200, body: mission };
  }

  if (collection === "nodes" && sub === undefined) {
    const node = getNode(deps.kernel.db, id);

    return node === undefined
      ? { status: 404, body: errorBody("not_found", "node not found") }
      : {
          status: 200,
          body: {
            ...node,
            connected: deps.dispatcher.isConnected(node.id),
            grants: listGrants(deps.kernel.db, node.id),
          },
        };
  }

  if (collection === "jobs" && sub === undefined) {
    const record = getJob(deps.kernel.db, id);

    if (record === undefined) {
      return { status: 404, body: errorBody("not_found", "node_job not found") };
    }

    // Computed on read rather than stored, so it is the reason right now — see
    // the note in migration 0002.
    const routingReason =
      record.job.status === "queued"
        ? explainQueued(deps.kernel, deps.dispatcher, {
            capability: record.job.capability,
            ...(record.job.missionId === undefined ? {} : { missionId: record.job.missionId }),
          })
        : undefined;

    return {
      status: 200,
      body: {
        ...record,
        ...(routingReason === undefined ? {} : { routingReason }),
      },
    };
  }

  return { status: 404, body: errorBody("not_found", "No such resource") };
}

/**
 * Redeems a pairing code.
 *
 * The only unauthenticated write in the core. A node agent has no core token by
 * construction — it is being introduced to the core for the first time — so the
 * one-time code is the whole credential, and it is single-use, expiring, bound
 * to a host, and stored only as a digest.
 */
function handlePair(
  deps: ApiDeps,
  context: CommandContext,
  body: unknown,
): { status: number; body: unknown } {
  const parsed = PairNodeRequestSchema.safeParse(body);

  if (!parsed.success) {
    return {
      status: 400,
      body: errorBody("invalid_request", "The pairing request did not match its schema"),
    };
  }

  const outcome = pairNode(deps.kernel, context, parsed.data, deps.config.token);

  if (outcome.ok) {
    return { status: 200, body: outcome.value };
  }

  if (outcome.conflict.kind === "idempotent_replay") {
    // A retried pair request must answer with the same credential, or a lost
    // response would leave an agent that cannot connect and cannot pair again.
    // The core kept no copy — it re-derives it.
    const existing = currentCredential(
      deps.kernel.db,
      outcome.conflict.existingId,
      deps.config.token,
      parsed.data,
    );

    if (existing !== undefined) {
      return { status: 200, body: existing };
    }

    // A spent code presented by a different machine. Answered exactly as a wrong
    // code is, so this is not an oracle for codes that once existed.
    return { status: 404, body: errorBody("not_found", "pairing_code not found") };
  }

  return conflictResponse(outcome.conflict);
}

/**
 * Single entry point for the REST realm. Order matters: origin, then token, then
 * routing. A caller that fails either check learns nothing about which paths
 * exist. `/node/pair` sits between the two on purpose, and is the only path that
 * does.
 */
export async function handleRequest(
  deps: ApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const correlationHeader = req.headers["x-correlation-id"];
  const correlationId =
    typeof correlationHeader === "string" && UuidSchema.safeParse(correlationHeader).success
      ? correlationHeader
      : deps.kernel.ids.nextId();

  const url = new URL(req.url ?? "/", `http://${deps.config.bindAddress}`);
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const logger = deps.kernel.logger.child({
    correlationId,
    method: req.method,
    path: url.pathname,
  });

  try {
    // Liveness only, and deliberately unauthenticated: it reveals that a process
    // is listening, which a port scan reveals anyway, and nothing else.
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { status: "ok" }, correlationId);
      return;
    }

    if (!isOriginAllowed(req.headers.origin, deps.config.allowedOrigins)) {
      logger.log("warn", "rejected request from disallowed origin", { origin: req.headers.origin });
      send(res, 403, errorBody("forbidden_origin", "Origin is not permitted"), correlationId);
      return;
    }

    const isPair = req.method === "POST" && url.pathname === PAIR_PATH;

    if (!isPair && !isAuthorized(req.headers.authorization, deps.config.token)) {
      logger.log("warn", "rejected unauthenticated request");
      send(res, 401, errorBody("unauthorized", "A valid bearer token is required"), correlationId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/ready") {
      send(res, 200, { status: "ready", schemaVersion: deps.schemaVersion }, correlationId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/diagnostics") {
      send(
        res,
        200,
        {
          schemaVersion: deps.schemaVersion,
          latestSequence: latestSequence(deps.kernel.db),
          connectedClients: deps.kernel.broker.listenerCount,
          connectedNodes: deps.dispatcher.connectedCount,
          uptimeMs: deps.kernel.clock.now() - deps.startedAt,
        },
        correlationId,
      );
      return;
    }

    if (req.method === "GET") {
      const result = handleRead(deps, segments, url);
      send(res, result.status, result.body, correlationId);
      return;
    }

    const isCommand = req.method === "POST" && segments[0] === "commands" && segments.length === 2;

    if (!isCommand && !isPair) {
      send(res, 404, errorBody("not_found", "No such resource"), correlationId);
      return;
    }

    const name = segments[1] ?? "";
    const route = isPair ? undefined : Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;

    if (!isPair && route === undefined) {
      send(res, 404, errorBody("not_found", "No such command"), correlationId);
      return;
    }

    const contentType = req.headers["content-type"] ?? "";

    if (!contentType.startsWith("application/json")) {
      send(
        res,
        415,
        errorBody("unsupported_media_type", "Commands must be application/json"),
        correlationId,
      );
      return;
    }

    const raw = await readBody(req, MAX_BODY_BYTES);

    if (raw === "too_large") {
      send(res, 413, errorBody("payload_too_large", "Request body is too large"), correlationId);
      return;
    }

    let body: unknown;

    try {
      body = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      send(res, 400, errorBody("invalid_request", "Body is not valid JSON"), correlationId);
      return;
    }

    if (isPair) {
      const context: CommandContext = { correlationId, actorType: "system", actorId: "pairing" };
      const result = handlePair(deps, context, body);

      logger.log("info", "pairing request handled", { status: result.status });
      send(res, result.status, result.body, correlationId);
      return;
    }

    if (route === undefined) {
      send(res, 404, errorBody("not_found", "No such command"), correlationId);
      return;
    }

    const context: CommandContext = { correlationId, actorType: "user", actorId: "local" };
    const result = route.handle(deps.kernel, context, body);

    if (result.status === 200) {
      // The two commands whose effect reaches beyond the database. Both run after
      // the commit, never inside it: a job frame that describes state a rollback
      // erased is worse than one that arrives a millisecond late.
      if (name === "node.job_enqueue") {
        deps.dispatcher.pass();
      } else if (name === "node.revoke") {
        const revoked = RevokeNodeCommandSchema.safeParse(body);

        if (revoked.success) {
          // A revoked node that keeps its socket is only revoked on paper: it
          // could still answer for work it already holds.
          deps.dispatcher.disconnect(revoked.data.nodeId, 1008, "node revoked");
        }
      } else if (name === "node.job_cancel") {
        const cancelled = CancelNodeJobCommandSchema.safeParse(body);
        const record = cancelled.success ? getJob(deps.kernel.db, cancelled.data.jobId) : undefined;

        if (record?.job.nodeId !== undefined) {
          deps.dispatcher.sendCancel(record.job.nodeId, record.job.id);
        }
      }
    }

    logger.log("info", "command handled", { command: name, status: result.status });
    send(res, result.status, result.body, correlationId);
  } catch (error) {
    logger.log("error", "unhandled request failure", {
      reason: error instanceof Error ? error.message : "unknown",
    });

    if (!res.headersSent) {
      send(
        res,
        500,
        errorBody("internal", "The core could not complete that request"),
        correlationId,
      );
    }
  }
}
