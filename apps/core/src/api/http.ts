import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ActivateIdentityCommandSchema,
  AttentionStateSchema,
  CancelNodeJobCommandSchema,
  ConfirmAuthorityCommandSchema,
  ChangeMissionStatusCommandSchema,
  ChangeObjectiveStatusCommandSchema,
  ChangeSurfaceLifecycleCommandSchema,
  ComposeSurfacesCommandSchema,
  CreateMissionCommandSchema,
  CreateObjectiveCommandSchema,
  EnqueueNodeJobCommandSchema,
  ExecuteAuthorityCommandSchema,
  GrantStandingPermissionCommandSchema,
  GrantNodeCapabilityCommandSchema,
  ImportArtifactCommandSchema,
  IssueNodePairingCodeCommandSchema,
  ObserveSourceCommandSchema,
  PairNodeRequestSchema,
  RecallVaultCommandSchema,
  RecordArtifactCommandSchema,
  RegisterSourceCommandSchema,
  ReindexVaultCommandSchema,
  ReleaseSurfaceOverrideCommandSchema,
  RequestAuthorityCommandSchema,
  RevokeNodeCommandSchema,
  RevokeStandingPermissionCommandSchema,
  SetSurfaceOverrideCommandSchema,
  SurfaceDisplaySchema,
  UpsertSurfaceIntentCommandSchema,
  UuidSchema,
} from "@noctis/contracts";
import type { DomainConflict, Result } from "@noctis/domain";
import type { z } from "zod";

import {
  confirmAuthority,
  executeAuthority,
  getApproval,
  getAuthorityDecision,
  getStandingPermission,
  grantStandingPermission,
  listApprovals,
  listStandingPermissions,
  requestAuthority,
  revokeStandingPermission,
} from "../authority/service.js";
import {
  getArtifact,
  importArtifact,
  importOf,
  listArtifacts,
  recordArtifact,
} from "../artifacts/service.js";
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
import {
  changeSurfaceLifecycle,
  composeSurfaces,
  getSnapshotForDisplay,
  getSurfaceIntent,
  getSurfaceOverride,
  listSurfaceIntents,
  listSurfaceOverrides,
  planFor,
  releaseSurfaceOverride,
  replayComposition,
  setSurfaceOverride,
  upsertSurfaceIntent,
} from "../objectives/surface-intents.js";
import {
  getSource as getSourceRecord,
  getSourceState,
  listSources,
  observeSource,
  registerSource,
  sourceState,
} from "../sources/service.js";
import { indexVault, listVaultItems } from "../vault/indexer.js";
import { getRecall, recallFor, recordRecall } from "../vault/recall.js";
import type { VaultRoot } from "../vault/root.js";
import { writesEnabled } from "../vault/writes.js";
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
  /** Absent when no Vault is configured, which is the default. */
  vaultRoot?: VaultRoot;
  /** The environment the Vault write switch is read from. */
  vaultEnv?: Readonly<Record<string, string | undefined>>;
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
    case "authority_refused":
      return {
        status: 403,
        body: errorBody("authority_refused", "Authority did not permit that", {
          requestId: domainConflict.requestId,
          outcome: domainConflict.outcome,
          // The reason codes, never the confirmation phrase: the phrase names
          // the target, and an error body is a poor place to repeat it.
          reasonCodes: domainConflict.reasonCodes,
        }),
      };
    case "unavailable":
      return {
        status: 503,
        body: errorBody("unavailable", `${domainConflict.entity} is unavailable`, {
          reason: domainConflict.reason,
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
    deps: ApiDeps,
    context: CommandContext,
    body: unknown,
  ) => { status: number; body: unknown };
}

/**
 * A command that needs more than the kernel — the Vault root, say, which is
 * resolved once at startup and deliberately not reachable from a command body.
 */
function defineDepsCommand<S extends z.ZodType>(
  schema: S,
  run: (deps: ApiDeps, context: CommandContext, command: z.infer<S>) => Result<unknown>,
  replay: Replay,
): CommandRoute {
  return {
    handle(deps, context, body) {
      const kernel = deps.kernel;
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

      const outcome = run(deps, context, parsed.data);

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

/** The common case: a command that needs only the kernel. */
function defineCommand<S extends z.ZodType>(
  schema: S,
  run: (kernel: Kernel, context: CommandContext, command: z.infer<S>) => Result<unknown>,
  replay: Replay,
): CommandRoute {
  return defineDepsCommand(
    schema,
    (deps, context, command) => run(deps.kernel, context, command),
    replay,
  );
}

/** Refusal for a Vault command when no Vault is configured. Off is the default. */
function vaultNotConfigured(): Result<never> {
  return {
    ok: false,
    conflict: { kind: "not_found", entity: "vault_root", id: "NOCTIS_VAULT_ROOT" },
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
  "authority.confirm": defineCommand(ConfirmAuthorityCommandSchema, confirmAuthority, (db, id) =>
    getApproval(db, id),
  ),
  "authority.execute": defineCommand(ExecuteAuthorityCommandSchema, executeAuthority, (db, id) =>
    getApproval(db, id),
  ),
  "authority.grant_permission": defineCommand(
    GrantStandingPermissionCommandSchema,
    grantStandingPermission,
    (db, id) => getStandingPermission(db, id),
  ),
  "authority.revoke_permission": defineCommand(
    RevokeStandingPermissionCommandSchema,
    revokeStandingPermission,
    (db, id) => getStandingPermission(db, id),
  ),
  "source.register": defineCommand(RegisterSourceCommandSchema, registerSource, (db, id) =>
    getSourceRecord(db, id),
  ),
  "source.observe": defineDepsCommand(
    ObserveSourceCommandSchema,
    (deps, context, command) => observeSource(deps.kernel, context, command),
    // A replay answers with the state as it is now, not as it was: freshness is
    // a function of the clock, so a cached "current" would be the one thing a
    // retry must never resurrect.
    () => undefined,
  ),
  "artifact.record": defineCommand(RecordArtifactCommandSchema, recordArtifact, (db, id) =>
    getArtifact(db, id),
  ),
  "artifact.import": defineCommand(ImportArtifactCommandSchema, importArtifact, (db, id) =>
    getArtifact(db, id),
  ),
  "surface.upsert_intent": defineCommand(
    UpsertSurfaceIntentCommandSchema,
    upsertSurfaceIntent,
    (db, id) => getSurfaceIntent(db, id),
  ),
  "surface.change_lifecycle": defineCommand(
    ChangeSurfaceLifecycleCommandSchema,
    changeSurfaceLifecycle,
    (db, id) => getSurfaceIntent(db, id),
  ),
  "surface.set_override": defineCommand(
    SetSurfaceOverrideCommandSchema,
    setSurfaceOverride,
    (db, id) => getSurfaceOverride(db, id),
  ),
  "surface.release_override": defineCommand(
    ReleaseSurfaceOverrideCommandSchema,
    releaseSurfaceOverride,
    (db, id) => getSurfaceOverride(db, id),
  ),
  "surface.compose": defineCommand(ComposeSurfacesCommandSchema, composeSurfaces, (db, id) =>
    replayComposition(db, id),
  ),
  "vault.reindex": defineDepsCommand(
    ReindexVaultCommandSchema,
    (deps, context, command) =>
      deps.vaultRoot === undefined
        ? vaultNotConfigured()
        : indexVault(deps.kernel, context, deps.vaultRoot, command.idempotencyKey),
    // Reindexing has no stored result to replay; a retried key is answered by
    // the conflict path, which is honest about the work not being repeated.
    () => undefined,
  ),
  "vault.recall": defineDepsCommand(
    RecallVaultCommandSchema,
    (deps, context, command) => recordRecall(deps.kernel, context, command, deps.vaultRoot),
    (db, id) => getRecall(db, id),
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

function parseLimit(raw: string | null, max: number, fallback: number): number | undefined {
  if (raw === null) {
    return fallback;
  }

  const limit = Number(raw);

  return Number.isInteger(limit) && limit > 0 && limit <= max ? limit : undefined;
}

/**
 * The workbench's read of an Objective's Surfaces, including the composition it
 * should render.
 *
 * A GET writes nothing, and this one is no exception — it recomputes the plan
 * rather than returning the stored one. That is only safe because the
 * compositor is pure: the plan a client renders after a restart is identical to
 * the one `surface.compose` committed before it, and `snapshot` is returned
 * alongside so a caller can see whether anything has drifted since.
 */
function handleSurfaceRead(
  deps: ApiDeps,
  objectiveId: string,
  url: URL,
): { status: number; body: unknown } {
  if (getObjective(deps.kernel.db, objectiveId) === undefined) {
    return { status: 404, body: errorBody("not_found", "objective not found") };
  }

  const clientId = url.searchParams.get("clientId") ?? "";
  const display = SurfaceDisplaySchema.safeParse({
    fingerprint: url.searchParams.get("fingerprint") ?? "",
    widthPx: Number(url.searchParams.get("widthPx") ?? Number.NaN),
  });
  const attentionState = AttentionStateSchema.safeParse(url.searchParams.get("attentionState"));
  const focusedSurfaceId = url.searchParams.get("focusedSurfaceId");

  if (clientId === "" || !display.success || !attentionState.success) {
    return {
      status: 400,
      body: errorBody(
        "invalid_request",
        "clientId, fingerprint, widthPx, and attentionState are required",
      ),
    };
  }

  if (focusedSurfaceId !== null && !UuidSchema.safeParse(focusedSurfaceId).success) {
    return { status: 400, body: errorBody("invalid_request", "focusedSurfaceId must be a UUID") };
  }

  const request = {
    objectiveId,
    clientId,
    display: display.data,
    attentionState: attentionState.data,
    ...(focusedSurfaceId === null ? {} : { focusedSurfaceId }),
    generatedAt: new Date(deps.kernel.clock.now()).toISOString(),
  };

  return {
    status: 200,
    body: {
      intents: listSurfaceIntents(deps.kernel.db, objectiveId),
      overrides: listSurfaceOverrides(
        deps.kernel.db,
        objectiveId,
        clientId,
        display.data.fingerprint,
      ),
      snapshot:
        getSnapshotForDisplay(deps.kernel.db, objectiveId, display.data.fingerprint)?.plan ?? null,
      plan: planFor(deps.kernel.db, request),
    },
  };
}

/**
 * The graph the Vault view draws: entities, their edges, and their persisted
 * coordinates. Coordinates come from `vault_layout`, never recomputed here, so
 * every client draws the same sphere and a reload does not rearrange it.
 *
 * This is a whole-graph read, not a page of one, so it does not share the
 * collection page size. `MAX_PAGE_SIZE` capped it at 500 and said nothing when
 * it bit, which turned a large Vault into an alphabetical slice of itself with
 * no way for a caller to tell. A cap still exists — an unbounded graph read is
 * a way to hang the renderer — but it is the graph's own, and `truncated`
 * plus `total` mean a client can always say so out loud.
 */
export const MAX_GRAPH_NODES = 5000;

function readGraph(
  db: NoctisDatabase,
  limit: number,
): {
  nodes: unknown[];
  edges: unknown[];
  total: number;
  truncated: boolean;
} {
  const total = (
    db.prepare("SELECT COUNT(*) AS count FROM vault_entities").get() as { count: number }
  ).count;

  const nodes = db
    .prepare(
      `SELECT e.id, e.key, e.name, e.type, e.item_id AS itemId, i.path,
              l.x, l.y, l.z
         FROM vault_entities e
         LEFT JOIN vault_items i ON i.id = e.item_id
         LEFT JOIN vault_layout l ON l.entity_id = e.id
        ORDER BY e.key
        LIMIT ?`,
    )
    .all(limit) as Array<{ id: string }>;

  // Only edges whose endpoints both survived the cap. The previous read took
  // the first `limit * 4` edges by id, so a truncated graph could hand the
  // renderer edges pointing at nodes it was never sent.
  const kept = new Set(nodes.map((node) => node.id));
  const edges = (
    db
      .prepare(
        `SELECT id, src_entity_id AS source, dst_entity_id AS target, type, lifecycle
           FROM vault_edges ORDER BY id`,
      )
      .all() as Array<{ source: string; target: string }>
  ).filter((edge) => kept.has(edge.source) && kept.has(edge.target));

  return { nodes, edges, total, truncated: total > nodes.length };
}

function handleRead(
  deps: ApiDeps,
  segments: readonly string[],
  url: URL,
): { status: number; body: unknown } {
  // The Vault graph is a whole graph, not a page of a collection, so it gets
  // its own ceiling and its own default. Everything else pages.
  const isGraph = segments.length === 2 && segments[0] === "vault" && segments[1] === "graph";
  const maxLimit = isGraph ? MAX_GRAPH_NODES : MAX_PAGE_SIZE;
  const limit = parseLimit(
    url.searchParams.get("limit"),
    maxLimit,
    isGraph ? MAX_GRAPH_NODES : DEFAULT_PAGE_SIZE,
  );

  if (limit === undefined) {
    return {
      status: 400,
      body: errorBody("invalid_request", `limit must be an integer 1-${String(maxLimit)}`),
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

  if (segments.length === 1 && segments[0] === "vault") {
    return {
      status: 200,
      body: {
        // The path itself is never returned. A client has no use for it and the
        // shell should not be able to learn where the notes live.
        configured: deps.vaultRoot !== undefined,
        live: deps.vaultRoot?.live ?? false,
        writesEnabled: writesEnabled(deps.vaultEnv ?? {}),
        items: deps.vaultRoot === undefined ? [] : listVaultItems(deps.kernel.db).slice(0, limit),
      },
    };
  }

  if (isGraph) {
    return { status: 200, body: readGraph(deps.kernel.db, limit) };
  }

  if (segments.length === 2 && segments[0] === "vault" && segments[1] === "recall") {
    const query = url.searchParams.get("query") ?? "";

    if (query.trim() === "") {
      return { status: 400, body: errorBody("invalid_request", "query is required") };
    }

    // A read, so nothing is recorded. `vault.recall` is the command that audits.
    return {
      status: 200,
      body: recallFor(deps.kernel.db, query, { root: deps.vaultRoot, limit }),
    };
  }

  if (segments.length === 1 && segments[0] === "approvals") {
    return { status: 200, body: { approvals: listApprovals(deps.kernel.db, limit) } };
  }

  if (segments.length === 1 && segments[0] === "permissions") {
    // Section 9.1: standing permissions are "visible in Settings". Revoked ones
    // are returned too, with their reason — a permission that quietly vanished
    // from the list would leave a past decision unexplainable.
    return { status: 200, body: { permissions: listStandingPermissions(deps.kernel.db, limit) } };
  }

  if (segments.length === 1 && segments[0] === "sources") {
    const now = deps.kernel.clock.now();

    return {
      status: 200,
      body: {
        sources: listSources(deps.kernel.db, limit).map((source) =>
          sourceState(deps.kernel.db, source, now),
        ),
      },
    };
  }

  if (segments.length === 1 && segments[0] === "artifacts") {
    return {
      status: 200,
      body: {
        artifacts: listArtifacts(deps.kernel.db, limit).map((artifact) => ({
          ...artifact,
          // Lineage in both directions: an external reference says whether it
          // has been imported, so the UI never has to infer it from a URI.
          importedAs: importOf(deps.kernel.db, artifact.id)?.id ?? null,
        })),
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

  if (collection === "objectives" && sub === "surfaces") {
    return handleSurfaceRead(deps, id, url);
  }

  if (collection === "approvals" && sub === undefined) {
    const approval = getApproval(deps.kernel.db, id);

    return approval === undefined
      ? { status: 404, body: errorBody("not_found", "approval not found") }
      : { status: 200, body: approval };
  }

  if (collection === "sources" && sub === undefined) {
    const state = getSourceState(deps.kernel.db, id, deps.kernel.clock.now());

    return state === undefined
      ? { status: 404, body: errorBody("not_found", "source not found") }
      : { status: 200, body: state };
  }

  if (collection === "artifacts" && sub === undefined) {
    const artifact = getArtifact(deps.kernel.db, id);

    return artifact === undefined
      ? { status: 404, body: errorBody("not_found", "artifact not found") }
      : {
          status: 200,
          body: {
            ...artifact,
            importedAs: importOf(deps.kernel.db, artifact.id)?.id ?? null,
          },
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
    const result = route.handle(deps, context, body);

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
