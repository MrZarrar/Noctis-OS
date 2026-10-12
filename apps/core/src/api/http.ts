import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";

import {
  ActivateIdentityCommandSchema,
  AdoptRuntimeSessionCommandSchema,
  ArchiveConversationThreadCommandSchema,
  CreateConversationThreadCommandSchema,
  RenameConversationThreadCommandSchema,
  StartFreshConversationCommandSchema,
  AttentionStateSchema,
  CancelConversationTurnCommandSchema,
  CancelNodeJobCommandSchema,
  ConfirmAuthorityCommandSchema,
  ConversationalIdentityIdSchema,
  ChangeMissionStatusCommandSchema,
  ChangeObjectiveStatusCommandSchema,
  ChangeSurfaceLifecycleCommandSchema,
  ComposeSurfacesCommandSchema,
  CreateMissionCommandSchema,
  CreateObjectiveCommandSchema,
  DeclineAuthorityCommandSchema,
  EnqueueNodeJobCommandSchema,
  ExecuteAuthorityCommandSchema,
  GrantStandingPermissionCommandSchema,
  GrantNodeCapabilityCommandSchema,
  ImportArtifactCommandSchema,
  IssueNodePairingCodeCommandSchema,
  ObserveSourceCommandSchema,
  OpenRemoteDesktopCommandSchema,
  PairNodeRequestSchema,
  RecallVaultCommandSchema,
  RecordArtifactCommandSchema,
  RegisterSourceCommandSchema,
  ReindexVaultCommandSchema,
  ReleaseSurfaceOverrideCommandSchema,
  RequestAuthorityCommandSchema,
  RevokeNodeCommandSchema,
  RevokeStandingPermissionCommandSchema,
  SendConversationMessageCommandSchema,
  SetIdentityDefaultModelCommandSchema,
  SetSurfaceOverrideCommandSchema,
  SurfaceDisplaySchema,
  UpsertSurfaceIntentCommandSchema,
  FileRelativePathSchema,
  MAX_ATTACHMENT_BYTES,
  ScreenViewPayloadSchema,
  UuidSchema,
} from "@noctis/contracts";
import type { DomainConflict, Result } from "@noctis/domain";
import { z } from "zod";

import {
  confirmAuthority,
  declineAuthority,
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
import { getAttachment, readAttachmentBytes, uploadAttachment } from "../attachments/service.js";
import { catalogue, defaultModelFor, setDefaultModel } from "../conversation/models.js";
import type { ConversationService } from "../conversation/service.js";
import {
  getTurn,
  getTurnByJobId,
  listMessages,
  listRecentTurns,
  listTurns,
} from "../conversation/service.js";
import {
  archiveThread,
  findThread,
  getThread,
  listChildThreads,
  listConversations,
  renameThread,
  startFresh,
} from "../conversation/threads.js";
import type { NoctisDatabase } from "../db/connection.js";
import { latestSequence, readEventsAfter } from "../db/events.js";
import type { FileGateway, FileLocation } from "../files/gateway.js";
import { FileUnavailable, fileMediaType, parseRange } from "../files/gateway.js";
import type { LiveBroker } from "../events/live.js";
import type { ScreenGateway } from "../screen/gateway.js";
import { SCREEN_RECHECK_MS, ScreenUnavailable, screenGranted } from "../screen/gateway.js";
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
import { parseNodeAuthorization, verifyCredential } from "../nodes/credentials.js";
import {
  currentCredential,
  getCredentialGeneration,
  getGrant,
  getNode,
  getPairingCode,
  grantCapability,
  issuePairingCode,
  listGrants,
  listNodes,
  listRuntimeRoots,
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
import { listRemoteHosts, openRemoteDesktop } from "../remote/service.js";
import { readDigest } from "../notify/digest.js";
import { indexVault, listVaultItems } from "../vault/indexer.js";
import { VISIBLE_ENTITY, getRecall, recallFor, recordRecall } from "../vault/recall.js";
import type { VaultRoot } from "../vault/root.js";
import {
  isUnlocked,
  lockPasscode,
  passcodeStatus,
  setupPasscode,
  unlockPasscode,
} from "../vault/passcode.js";
import type { PasscodeResult } from "../vault/passcode.js";
import { writesEnabled } from "../vault/writes.js";
import type { CoreConfig } from "../config/server.js";
import type { Notifier } from "../notify/push.js";
import { PushSubscriptionSchema } from "../notify/push.js";
import type { AuthorizeResult } from "./auth.js";
import { authorize, isAuthorized, isOriginAllowed } from "./auth.js";
import { serializeCookie } from "./cookie.js";
import type { SessionDeps } from "./session.js";
import {
  SESSION_COOKIE,
  createSession,
  refreshCsrf,
  revokeSession,
  verifySession,
} from "./session.js";
import { openEventStream } from "./sse.js";
import { isApiPath, pageSecurityPolicy, serveStatic } from "./static.js";

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;
/** SSE heartbeat: a comment line often enough that a reverse proxy never times the connection out idle. */
const SSE_HEARTBEAT_MS = 15_000;

/** The one path that does not require the core bearer token. See `pairNode`. */
export const PAIR_PATH = "/node/pair";

/** Uploads a file for a prompt (task 2.4). Client realm, so it is behind the gate and needs CSRF. */
export const ATTACHMENT_UPLOAD_PATH = "/attachments";
/** `GET /node/attachments/:id` — the node realm, with a node credential, not the core token. */
const NODE_ATTACHMENT_PREFIX = "/node/attachments/";
/** The filename a browser sends alongside the bytes. There is no multipart parser here by design. */
export const ATTACHMENT_FILENAME_HEADER = "x-noctis-filename";
/** `POST /node/outputs` — a file a turn made, handed over by the node running it. */
export const NODE_OUTPUT_PATH = "/node/outputs";
/** The job the output belongs to. The node must hold it. */
export const OUTPUT_JOB_HEADER = "x-noctis-job";
/** `POST /node/files` — the bytes of a `file.read` or `screen.view` job, streamed by the node holding it. */
export const NODE_FILE_PATH = "/node/files";

const screenUploads = new WeakSet<Readable>();

export function isScreenUpload(req: IncomingMessage): boolean {
  return screenUploads.has(req);
}
/** The file's whole size, and the range the body carries. */
export const FILE_SIZE_HEADER = "x-noctis-file-size";
export const FILE_OFFSET_HEADER = "x-noctis-file-offset";
export const FILE_LENGTH_HEADER = "x-noctis-file-length";

/** Exchanges the core token for a cookie. The other path that runs before the gate. */
export const LOGIN_PATH = "/session/login";
export const LOGOUT_PATH = "/session/logout";
/** Re-mints the CSRF value from a cookie the browser still holds. Behind the gate. */
export const SESSION_PATH = "/session";

/** Web push. Behind the credential gate like everything else. */
export const PUSH_KEY_PATH = "/push/key";
export const PUSH_SUBSCRIBE_PATH = "/push/subscribe";
export const PUSH_UNSUBSCRIBE_PATH = "/push/unsubscribe";

const LoginBodySchema = z.object({ token: z.string().min(1) }).strict();
const UnsubscribeBodySchema = z.object({ endpoint: z.url() }).strict();

export interface ApiDeps {
  kernel: Kernel;
  config: CoreConfig;
  /** Set once at startup; reported by /ready and /diagnostics. */
  schemaVersion: number;
  startedAt: number;
  dispatcher: Dispatcher;
  conversation: ConversationService;
  /** Files on a PC, listed and streamed through jobs on its node (v1 S4). */
  files: FileGateway;
  /** A PC's desktop, watched through a job on its node. */
  screen: ScreenGateway;
  /** Token deltas for streaming clients. Never persisted. */
  live: LiveBroker;
  /** Web push. Present always; without VAPID keys its `publicKey()` is undefined. */
  notifier: Notifier;
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

/**
 * A repeated request header arrives as an array. A credential presented twice is
 * not a credential, so only the single-valued form is read.
 */
function headerValue(raw: string | string[] | undefined): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

function sessionDeps(deps: ApiDeps): SessionDeps {
  return { db: deps.kernel.db, clock: deps.kernel.clock, ids: deps.kernel.ids };
}

/**
 * The attributes every session cookie carries. Only the value and lifetime vary,
 * so a logout clears exactly what a login set.
 *
 * ponytail: `Secure` is unconditional. Tailscale Serve terminates TLS, so the
 * browser always sees HTTPS and the front door this is built for is never plain
 * HTTP — but a page served over plain HTTP on loopback would be handed a cookie
 * it then refuses to send back, and fail to log in with no visible reason. Make
 * it conditional on the deployment if a plain-HTTP browser ever has to work.
 */
function sessionCookie(value: string, maxAgeSeconds: number): string {
  return serializeCookie(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAgeSeconds,
  });
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
  "authority.decline": defineCommand(DeclineAuthorityCommandSchema, declineAuthority, (db, id) =>
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
  "conversation.send": defineDepsCommand(
    SendConversationMessageCommandSchema,
    (deps, context, command) => deps.conversation.sendMessage(context, command),
    (db, id) => getTurn(db, id),
  ),
  "conversation.create_thread": defineDepsCommand(
    CreateConversationThreadCommandSchema,
    (deps, context, command) => deps.conversation.createThread(context, command),
    (db, id) => getThread(db, id),
  ),
  "conversation.rename_thread": defineCommand(
    RenameConversationThreadCommandSchema,
    renameThread,
    (db, id) => getThread(db, id),
  ),
  "conversation.archive_thread": defineCommand(
    ArchiveConversationThreadCommandSchema,
    archiveThread,
    (db, id) => getThread(db, id),
  ),
  "conversation.start_fresh": defineCommand(
    StartFreshConversationCommandSchema,
    startFresh,
    (db, id) => getThread(db, id),
  ),
  "conversation.adopt_session": defineDepsCommand(
    AdoptRuntimeSessionCommandSchema,
    (deps, context, command) => deps.conversation.adoptSession(context, command),
    (db, id) => getThread(db, id),
  ),
  "conversation.cancel": defineDepsCommand(
    CancelConversationTurnCommandSchema,
    (deps, context, command) => deps.conversation.cancelTurn(context, command),
    (db, id) => getTurnByJobId(db, id),
  ),
  "remote.open_session": defineDepsCommand(
    OpenRemoteDesktopCommandSchema,
    (deps, context, command) =>
      openRemoteDesktop(deps.kernel, context, command, deps.config.remoteDesktop),
    // Never a replay: the only thing worth replaying is the token, and it is
    // stored nowhere. A reused key is a 409 and the page asks with a new one.
    () => undefined,
  ),
  "identity.set_default_model": defineCommand(
    SetIdentityDefaultModelCommandSchema,
    setDefaultModel,
    (db, id) => defaultModelFor(db, id),
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

export function readGraph(
  db: NoctisDatabase,
  limit: number,
  includeSensitive = false,
): {
  nodes: unknown[];
  edges: unknown[];
  total: number;
  truncated: boolean;
} {
  // The brain is the agents' shared notes, read by agents; the sphere is the
  // owner's second brain. Sensitive notes need the passcode.
  const visible = `e.type <> 'agent'${includeSensitive ? "" : ` AND ${VISIBLE_ENTITY}`}`;
  const total = (
    db.prepare(`SELECT COUNT(*) AS count FROM vault_entities e WHERE ${visible}`).get() as {
      count: number;
    }
  ).count;

  const nodes = db
    .prepare(
      `SELECT e.id, e.key, e.name, e.type, e.item_id AS itemId, i.path,
              l.x, l.y, l.z
         FROM vault_entities e
         LEFT JOIN vault_items i ON i.id = e.item_id
         LEFT JOIN vault_layout l ON l.entity_id = e.id
        WHERE ${visible}
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
  principal: string,
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

  if (segments.length === 2 && segments[0] === "remote" && segments[1] === "hosts") {
    return { status: 200, body: { hosts: listRemoteHosts(deps.config.remoteDesktop) } };
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

  // Sensitive notes are read only by a credential that holds a passcode unlock.
  const unlocked = (): boolean => isUnlocked(deps.kernel.db, deps.kernel.clock.now(), principal);

  // What the agents did. The page passes its own midnight, so "today" is the
  // owner's day, not the core's; without one it is the last 24 hours.
  if (segments.length === 1 && segments[0] === "digest") {
    const to = url.searchParams.get("to") ?? new Date(deps.kernel.clock.now()).toISOString();
    const from =
      url.searchParams.get("from") ?? new Date(Date.parse(to) - 24 * 3_600_000).toISOString();

    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return { status: 400, body: errorBody("invalid_request", "from and to must be ISO times") };
    }

    return {
      status: 200,
      body: readDigest(deps.kernel.db, new Date(from).toISOString(), new Date(to).toISOString()),
    };
  }

  if (segments.length === 1 && segments[0] === "passcode") {
    return {
      status: 200,
      body: passcodeStatus(deps.kernel.db, deps.kernel.clock.now(), principal),
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
        items:
          deps.vaultRoot === undefined
            ? []
            : listVaultItems(deps.kernel.db, { includeSensitive: unlocked() }).slice(0, limit),
      },
    };
  }

  if (isGraph) {
    return { status: 200, body: readGraph(deps.kernel.db, limit, unlocked()) };
  }

  if (segments.length === 2 && segments[0] === "vault" && segments[1] === "recall") {
    const query = url.searchParams.get("query") ?? "";

    if (query.trim() === "") {
      return { status: 400, body: errorBody("invalid_request", "query is required") };
    }

    // A read, so nothing is recorded. `vault.recall` is the command that audits.
    return {
      status: 200,
      body: recallFor(deps.kernel.db, query, {
        root: deps.vaultRoot,
        limit,
        includeSensitive: unlocked(),
      }),
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

  if (segments.length === 1 && segments[0] === "turns") {
    // Across every thread, so Missions shows the work without having to know
    // which conversations it came from first.
    return { status: 200, body: { turns: listRecentTurns(deps.kernel.db, limit) } };
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

  if (segments.length === 1 && segments[0] === "threads") {
    const identityId = ConversationalIdentityIdSchema.safeParse(url.searchParams.get("identityId"));
    const objectiveId = url.searchParams.get("objectiveId");

    if (
      !identityId.success ||
      (objectiveId !== null && !UuidSchema.safeParse(objectiveId).success)
    ) {
      return {
        status: 400,
        body: errorBody("invalid_request", "identityId is required; objectiveId must be a UUID"),
      };
    }

    // A read creates nothing: the thread exists once a prompt has used it.
    const thread = findThread(deps.kernel.db, identityId.data, objectiveId ?? undefined);

    return thread === undefined
      ? { status: 404, body: errorBody("not_found", "thread not found") }
      : { status: 200, body: thread };
  }

  if (segments.length === 1 && segments[0] === "conversations") {
    const identityId = ConversationalIdentityIdSchema.safeParse(url.searchParams.get("identityId"));

    return identityId.success
      ? {
          status: 200,
          body: {
            conversations: listConversations(
              deps.kernel.db,
              identityId.data,
              url.searchParams.get("archived") === "1",
            ),
          },
        }
      : { status: 400, body: errorBody("invalid_request", "identityId is required") };
  }

  if (segments.length === 1 && segments[0] === "models") {
    // ADR-0026: the catalogue is what connected nodes offer right now; the
    // defaults are what Settings chose. Both are data, neither names a job.
    const vesper = defaultModelFor(deps.kernel.db, "vesper");
    const jester = defaultModelFor(deps.kernel.db, "jester");

    return {
      status: 200,
      body: {
        catalogue: catalogue(deps.kernel.db, (nodeId) => deps.dispatcher.isConnected(nodeId)),
        defaults: {
          ...(vesper === undefined ? {} : { vesper }),
          ...(jester === undefined ? {} : { jester }),
        },
        // The roots a turn may be pinned to (Slice 1 left the page unable to
        // name one). Offline hosts are listed, so "that machine is asleep" is
        // something the owner reads rather than a folder that silently is not
        // there.
        roots: listRuntimeRoots(
          deps.kernel.db,
          (nodeId) => deps.dispatcher.isConnected(nodeId),
          deps.kernel.clock.now(),
        ),
      },
    };
  }

  const [collection, id, sub] = segments;

  if (id === undefined || !UuidSchema.safeParse(id).success) {
    return { status: 404, body: errorBody("not_found", "No such resource") };
  }

  if (collection === "threads" && sub === undefined) {
    const thread = getThread(deps.kernel.db, id);

    return thread === undefined
      ? { status: 404, body: errorBody("not_found", "thread not found") }
      : { status: 200, body: thread };
  }

  if (collection === "threads" && sub === "children") {
    return { status: 200, body: { threads: listChildThreads(deps.kernel.db, id) } };
  }

  if (collection === "threads" && sub === "messages") {
    return { status: 200, body: { messages: listMessages(deps.kernel.db, id, limit) } };
  }

  if (collection === "threads" && sub === "turns") {
    return { status: 200, body: { turns: listTurns(deps.kernel.db, id, limit) } };
  }

  if (collection === "turns" && sub === undefined) {
    const turn = getTurn(deps.kernel.db, id);

    return turn === undefined
      ? { status: 404, body: errorBody("not_found", "turn not found") }
      : { status: 200, body: turn };
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
            ...(record.job.pinnedNodeId === undefined
              ? {}
              : { pinnedNodeId: record.job.pinnedNodeId }),
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
/**
 * Serves one attachment's bytes to the node that was given a job naming it.
 *
 * The credential is checked here rather than trusted from the socket, because
 * this is a different connection from the one the job arrived on and nothing
 * ties the two together. What it deliberately does *not* check is whether this
 * particular node holds a job naming this particular attachment: the core hands
 * attachment ids only to the node it pinned the turn to, ids are UUIDv7 rather
 * than guessable, and the alternative is a per-job grant table whose only
 * customer is this route.
 *
 * ponytail: any paired node may fetch any attachment. The ceiling is a second
 * node on the tailnet reading a file it was not sent — which is the same trust
 * boundary pairing already crosses, since a paired node is handed granted roots
 * on the same machine. Upgrade path, if a node is ever paired for someone else:
 * check `turn_attachments` against a job assigned to this node.
 */
function handleNodeAttachment(
  deps: ApiDeps,
  id: string,
  authorization: string | undefined,
): { status: number; body?: unknown; bytes?: Uint8Array; mediaType?: string } {
  const presented = parseNodeAuthorization(authorization);

  if (presented === undefined) {
    return { status: 401, body: errorBody("unauthorized", "A node credential is required") };
  }

  const generation = getCredentialGeneration(deps.kernel.db, presented.nodeId);

  if (
    generation === undefined ||
    !verifyCredential({
      coreToken: deps.config.token,
      nodeId: presented.nodeId,
      generation,
      presented: presented.credential,
    })
  ) {
    return { status: 401, body: errorBody("unauthorized", "A node credential is required") };
  }

  const record = UuidSchema.safeParse(id).success ? getAttachment(deps.kernel.db, id) : undefined;
  const bytes = record === undefined ? undefined : readAttachmentBytes(deps.kernel.db, id);

  if (record === undefined || bytes === undefined) {
    return { status: 404, body: errorBody("not_found", "No such attachment") };
  }

  return { status: 200, bytes, mediaType: record.mediaType };
}

/** The node presenting `authorization`, when its credential verifies. */
function verifiedNode(deps: ApiDeps, authorization: string | undefined): string | undefined {
  const presented = parseNodeAuthorization(authorization);

  if (presented === undefined) {
    return undefined;
  }

  const generation = getCredentialGeneration(deps.kernel.db, presented.nodeId);

  return generation !== undefined &&
    verifyCredential({
      coreToken: deps.config.token,
      nodeId: presented.nodeId,
      generation,
      presented: presented.credential,
    })
    ? presented.nodeId
    : undefined;
}

/**
 * Stores a file a turn produced, so a phone can open it without reaching the
 * node. Only for a job the node holds right now: an output belongs to a turn,
 * and a node with nothing running has nothing to hand over.
 */
function handleNodeOutput(
  deps: ApiDeps,
  context: CommandContext,
  headers: IncomingMessage["headers"],
  bytes: Uint8Array,
): { status: number; body: unknown } {
  const nodeId = verifiedNode(deps, headerValue(headers.authorization));

  if (nodeId === undefined) {
    return { status: 401, body: errorBody("unauthorized", "A node credential is required") };
  }

  const jobId = headerValue(headers[OUTPUT_JOB_HEADER]) ?? "";
  const job = UuidSchema.safeParse(jobId).success ? getJob(deps.kernel.db, jobId)?.job : undefined;

  if (job?.nodeId !== nodeId || (job.status !== "leased" && job.status !== "running")) {
    return { status: 403, body: errorBody("forbidden", "This node holds no such job") };
  }

  const outcome = uploadAttachment(
    deps.kernel,
    { ...context, actorType: "node", actorId: nodeId },
    {
      filename: headerValue(headers[ATTACHMENT_FILENAME_HEADER]) ?? "",
      mediaType: (headers["content-type"] ?? "").split(";")[0]?.trim() ?? "",
      bytes,
      origin: "runtime_output",
    },
  );

  if (!outcome.ok) {
    return outcome.conflict.kind === "unavailable"
      ? {
          status: 400,
          body: errorBody("invalid_attachment", "That output cannot be stored", {
            reason: outcome.conflict.reason,
          }),
        }
      : conflictResponse(outcome.conflict);
  }

  return { status: 200, body: outcome.value };
}

/** A whole number from a header the node set, or undefined. */
function headerCount(raw: string | string[] | undefined): number | undefined {
  const value = Number(headerValue(raw) ?? "x");

  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The bytes of a `file.read` job, from the node holding it. Handed to the
 * browser waiting for them and answered once that browser has them all; a
 * stream nobody asked for is refused unread.
 */
async function handleNodeFile(
  deps: ApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
): Promise<void> {
  const nodeId = verifiedNode(deps, headerValue(req.headers.authorization));

  if (nodeId === undefined) {
    req.resume();
    send(res, 401, errorBody("unauthorized", "A node credential is required"), correlationId);
    return;
  }

  const jobId = headerValue(req.headers[OUTPUT_JOB_HEADER]) ?? "";

  // A screen has no size or range: what it carries is the boundary ffmpeg chose.
  if (
    UuidSchema.safeParse(jobId).success &&
    getJob(deps.kernel.db, jobId)?.job.capability === "screen.view"
  ) {
    const contentType = headerValue(req.headers["content-type"]) ?? "";

    if (!/^multipart\/x-mixed-replace;\s?boundary=[\w.-]{1,70}$/.test(contentType)) {
      req.resume();
      send(res, 400, errorBody("invalid_request", "A screen must be MJPEG"), correlationId);
      return;
    }

    finishNodeStream(
      res,
      await deps.screen.accept(nodeId, jobId, { contentType, body: req }),
      req,
      correlationId,
    );
    return;
  }

  const sizeBytes = headerCount(req.headers[FILE_SIZE_HEADER]);
  const offset = headerCount(req.headers[FILE_OFFSET_HEADER]);
  const length = headerCount(req.headers[FILE_LENGTH_HEADER]);

  if (
    !UuidSchema.safeParse(jobId).success ||
    sizeBytes === undefined ||
    offset === undefined ||
    length === undefined ||
    offset + length > sizeBytes
  ) {
    req.resume();
    send(
      res,
      400,
      errorBody("invalid_request", "A file stream must name its job and range"),
      correlationId,
    );
    return;
  }

  finishNodeStream(
    res,
    await deps.files.accept(nodeId, jobId, { sizeBytes, offset, length, body: req }),
    req,
    correlationId,
  );
}

function finishNodeStream(
  res: ServerResponse,
  accepted: boolean,
  req: IncomingMessage,
  correlationId: string,
): void {
  if (!accepted) {
    req.resume();
    send(res, 403, errorBody("forbidden", "Nobody is waiting for that stream"), correlationId);
    return;
  }

  if (!res.destroyed) {
    send(res, 200, { status: "sent" }, correlationId);
  }
}

/**
 * `GET /screen/live?node=&fps=&width=`: a PC's desktop as MJPEG, for an
 * `<img>`. With `probe=1` it asks the same question and hangs up once frames
 * flow, which is how a page whose image failed finds out why: an image's
 * error event carries no status.
 */
async function handleScreen(
  deps: ApiDeps,
  url: URL,
  res: ServerResponse,
  correlationId: string,
  stillAuthorized: () => boolean,
): Promise<void> {
  const nodeId = url.searchParams.get("node") ?? "";
  // ponytail: 15 fps at 1280 by default, about 1-2 MB/s of MJPEG.
  const request = ScreenViewPayloadSchema.safeParse({
    fps: Number(url.searchParams.get("fps") ?? 15),
    width: Number(url.searchParams.get("width") ?? 1280),
  });

  if (!UuidSchema.safeParse(nodeId).success || !request.success) {
    send(
      res,
      400,
      errorBody("invalid_request", "Name a PC, fps 15 or 30, and width 960, 1280 or 1920"),
      correlationId,
    );
    return;
  }

  let gone = false;
  const connecting = new AbortController();
  res.once("close", () => {
    gone = true;
    connecting.abort();
  });

  let stream;

  try {
    stream = await deps.screen.open(
      { correlationId, actorType: "user", actorId: "local" },
      { nodeId, ...request.data },
      connecting.signal,
    );
  } catch (error) {
    if (!(error instanceof ScreenUnavailable)) {
      throw error;
    }

    if (!gone) {
      send(res, error.status, errorBody(error.code, error.message), correlationId);
    }
    return;
  }

  // Dropping the node's upload is what tells it nobody is watching.
  if (gone || url.searchParams.get("probe") === "1") {
    stream.body.destroy();

    if (!gone) {
      send(res, 200, { status: "live" }, correlationId);
    }

    return;
  }

  screenUploads.add(stream.body);
  stream.body.once("close", () => screenUploads.delete(stream.body));
  res.writeHead(200, {
    "content-type": stream.contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-correlation-id": correlationId,
  });
  // A mirror outlives the check that opened it: the grant can lapse and the
  // session can be logged out while frames are still flowing.
  const recheck = setInterval(() => {
    if (screenGranted(deps.kernel, nodeId) && stillAuthorized()) return;

    stream.stop();
    stream.body.destroy();
  }, SCREEN_RECHECK_MS);

  recheck.unref();
  res.once("close", () => stream.body.destroy());
  stream.body.once("close", () => {
    clearInterval(recheck);
    res.end();
  });
  stream.body.once("error", () => res.end());
  stream.body.pipe(res);
}

/** Where `/files/*` points, or undefined when the query does not name a place. */
function fileLocation(url: URL): FileLocation | undefined {
  const nodeId = url.searchParams.get("node") ?? "";
  const rootGrantId = url.searchParams.get("root") ?? "";
  const path = FileRelativePathSchema.safeParse(url.searchParams.get("path") ?? "");

  return UuidSchema.safeParse(nodeId).success &&
    rootGrantId.length > 0 &&
    rootGrantId.length <= 128 &&
    path.success
    ? { nodeId, rootGrantId, relativePath: path.data }
    : undefined;
}

function sendUnavailable(res: ServerResponse, error: unknown, correlationId: string): void {
  if (!(error instanceof FileUnavailable)) {
    throw error;
  }

  send(
    res,
    error.status,
    errorBody(error.status === 404 ? "not_found" : "unavailable", error.message),
    correlationId,
  );
}

/**
 * `GET /files/list` and `GET /files/content` (v1 S4): a folder on a PC, or one
 * file from it with `Range` honoured so a video seeks. A file is served as
 * what its extension says it is, never as a page: anything that could run is
 * text, and the sandbox policy makes even a mistaken type inert.
 */
async function handleFiles(
  deps: ApiDeps,
  action: "list" | "content",
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  correlationId: string,
): Promise<void> {
  const at = fileLocation(url);

  if (at === undefined || (action === "content" && at.relativePath === "")) {
    send(
      res,
      400,
      errorBody("invalid_request", "Name a node, a shared folder and a path inside it"),
      correlationId,
    );
    return;
  }

  const context: CommandContext = { correlationId, actorType: "user", actorId: "local" };

  if (action === "list") {
    try {
      send(res, 200, await deps.files.list(context, at), correlationId);
    } catch (error) {
      sendUnavailable(res, error, correlationId);
    }

    return;
  }

  const range = parseRange(headerValue(req.headers.range));
  let file;

  try {
    file = await deps.files.open(context, {
      ...at,
      offset: range?.offset ?? 0,
      ...(range?.length === undefined ? {} : { length: range.length }),
    });
  } catch (error) {
    sendUnavailable(res, error, correlationId);
    return;
  }

  if (range !== undefined && range.offset >= file.sizeBytes) {
    file.body.resume();
    res.writeHead(416, {
      "content-range": `bytes */${String(file.sizeBytes)}`,
      "x-correlation-id": correlationId,
    });
    res.end();
    return;
  }

  const name = at.relativePath.split("/").at(-1) ?? "file";

  res.writeHead(range === undefined ? 200 : 206, {
    "content-type": fileMediaType(name),
    "content-length": file.length,
    "accept-ranges": "bytes",
    ...(range === undefined
      ? {}
      : {
          "content-range": `bytes ${String(file.offset)}-${String(file.offset + file.length - 1)}/${String(file.sizeBytes)}`,
        }),
    "content-disposition": `${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    // A file on a PC can change under the same path; nothing keeps a stale copy.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "x-correlation-id": correlationId,
  });

  // A browser that stops listening (a video seeking elsewhere) ends the
  // node's upload too, and the node reports the job as cut short.
  res.once("close", () => file.body.destroy());
  file.body.pipe(res);
}

/**
 * `GET /sessions?node=&root=`: the agent sessions a shared folder has, asked
 * of the node that holds it, for the owner to pick one up and continue it.
 */
async function handleSessions(
  deps: ApiDeps,
  url: URL,
  res: ServerResponse,
  correlationId: string,
): Promise<void> {
  const nodeId = url.searchParams.get("node") ?? "";
  const rootGrantId = url.searchParams.get("root") ?? "";

  if (
    !UuidSchema.safeParse(nodeId).success ||
    rootGrantId.length === 0 ||
    rootGrantId.length > 128
  ) {
    send(res, 400, errorBody("invalid_request", "Name a node and a shared folder"), correlationId);
    return;
  }

  try {
    send(
      res,
      200,
      await deps.files.sessions(
        { correlationId, actorType: "user", actorId: "local" },
        { nodeId, rootGrantId },
      ),
      correlationId,
    );
  } catch (error) {
    sendUnavailable(res, error, correlationId);
  }
}

/**
 * `GET /threads/:id/history`: what was said in the session a thread adopted,
 * before Noctis picked it up, asked of the PC that keeps it. Read from the
 * adopted session, never the fork, which also holds Noctis's own turns.
 */
async function handleThreadHistory(
  deps: ApiDeps,
  threadId: string,
  res: ServerResponse,
  correlationId: string,
): Promise<void> {
  const thread = UuidSchema.safeParse(threadId).success
    ? getThread(deps.kernel.db, threadId)
    : undefined;

  if (
    thread?.adoptedSessionRef === undefined ||
    thread.nodeId === undefined ||
    thread.rootGrantId === undefined ||
    thread.providerId === undefined
  ) {
    send(res, 404, errorBody("not_found", "That thread adopted no session"), correlationId);
    return;
  }

  try {
    send(
      res,
      200,
      await deps.files.history(
        { correlationId, actorType: "user", actorId: "local" },
        {
          nodeId: thread.nodeId,
          rootGrantId: thread.rootGrantId,
          providerId: thread.providerId,
          sessionRef: thread.adoptedSessionRef,
        },
      ),
      correlationId,
    );
  } catch (error) {
    sendUnavailable(res, error, correlationId);
  }
}

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
 * A browser registering or forgetting its push endpoint.
 *
 * A subscription belongs to a *session*, because `push_subscriptions.session_id`
 * references `sessions(id)` with `ON DELETE CASCADE` — that cascade is the only
 * thing that ever reaps a dead phone. A bearer-authenticated caller has no
 * session to hang one off, so it is refused rather than given an invented one
 * that would outlive every session and never be cleaned up.
 *
 * Unsubscribing takes either credential: the endpoint is the browser's own
 * unguessable URL, and a phone whose session has just been replaced must still
 * be able to turn its own notifications off.
 */
const PasscodeBodySchema = z.object({
  passcode: z.string().max(64),
  timeoutMinutes: z.number().int().optional(),
});

const PASSCODE_REFUSALS: Record<string, number> = {
  bad_passcode: 400,
  bad_timeout: 400,
  already_configured: 409,
  not_configured: 409,
  wrong_passcode: 401,
  locked_out: 429,
};

/** `/passcode/setup`, `/passcode/unlock` and `/passcode/lock`: transport state, like a session. */
function handlePasscode(
  deps: ApiDeps,
  action: string | undefined,
  principal: string,
  body: unknown,
): { status: number; body: unknown } {
  const db = deps.kernel.db;
  const now = deps.kernel.clock.now();
  let result: PasscodeResult;

  if (action === "lock") {
    lockPasscode(db, principal);
    result = { ok: true };
  } else if (action === "setup" || action === "unlock") {
    const parsed = PasscodeBodySchema.safeParse(body);

    if (!parsed.success) {
      return { status: 400, body: errorBody("invalid_request", "Body must be {passcode}") };
    }

    result =
      action === "setup"
        ? setupPasscode(db, now, principal, parsed.data.passcode, parsed.data.timeoutMinutes ?? 5)
        : unlockPasscode(db, now, principal, parsed.data.passcode);
  } else {
    return { status: 404, body: errorBody("not_found", "No such resource") };
  }

  if (!result.ok) {
    const { reason, ...details } = result as { reason: string } & Record<string, unknown>;
    delete details.ok;

    return {
      status: PASSCODE_REFUSALS[reason] ?? 400,
      body: errorBody(
        reason,
        "The passcode was not accepted",
        Object.keys(details).length === 0 ? undefined : details,
      ),
    };
  }

  return { status: 200, body: passcodeStatus(db, now, principal) };
}

function handlePush(
  deps: ApiDeps,
  action: "subscribe" | "unsubscribe",
  authorized: AuthorizeResult | undefined,
  body: unknown,
): { status: number; body: unknown; issues?: readonly string[] } {
  if (action === "unsubscribe") {
    const parsed = UnsubscribeBodySchema.safeParse(body);

    if (!parsed.success) {
      return { status: 400, body: errorBody("invalid_request", "Body must be {endpoint}") };
    }

    deps.notifier.unsubscribe(parsed.data.endpoint);

    // Unconditionally 200: an endpoint that was already gone is the outcome the
    // caller asked for, and saying "no such subscription" would confirm which
    // endpoints this core holds.
    return { status: 200, body: { status: "unsubscribed" } };
  }

  if (authorized?.kind !== "session") {
    return {
      status: 400,
      body: errorBody(
        "session_required",
        "A push subscription belongs to a browser session. Log in for a session cookie first.",
      ),
    };
  }

  const parsed = PushSubscriptionSchema.safeParse(body);

  if (!parsed.success) {
    return {
      status: 400,
      body: errorBody(
        "invalid_request",
        "Body must be a PushSubscription: {endpoint, keys: {p256dh, auth}}",
      ),
      // Which fields, never their contents. A refused subscription used to log
      // only its status, so the one question worth asking — what about this
      // browser's subscription is wrong — could be answered only by a debugger
      // attached to the phone. The paths are field names the schema already
      // declares; the endpoint and the key material stay out of the log.
      issues: parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"),
    };
  }

  deps.notifier.subscribe(authorized.id, parsed.data);

  return { status: 200, body: { status: "subscribed" } };
}

/**
 * Single entry point for the REST realm. Order matters: origin, then credential,
 * then routing. A caller that fails either check learns nothing about which
 * paths exist. Two paths sit between the two on purpose and no others:
 * `/node/pair`, which is how a node earns a credential, and `/session/login`,
 * which is how a browser exchanges the token for one.
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

    // The built page, when the core is the front door rather than Vite. Static
    // is the last resort by path — `isApiPath` claims every route above and
    // below this line — but it has to run before the credential gate, because
    // the login screen has to load before there is a session to check. Assets
    // carry no user data and the tailnet is the boundary; see `static.ts`.
    if (deps.config.webRoot !== undefined && req.method === "GET" && !isApiPath(url.pathname)) {
      await serveStatic(
        deps.config.webRoot,
        url.pathname,
        res,
        pageSecurityPolicy(
          (deps.config.remoteDesktop?.targets ?? []).map(
            (target) => new URL(target.gatewayUrl).origin,
          ),
        ),
      );
      return;
    }

    // The node realm, and the only route in it that is not a WebSocket frame.
    // It runs before the client credential gate because a node presents its own
    // derived credential (`Bearer <nodeId>.<hex>`), which that gate would reject
    // as a bad core token — and it verifies that credential itself rather than
    // borrowing anyone else's answer.
    if (req.method === "GET" && url.pathname.startsWith(NODE_ATTACHMENT_PREFIX)) {
      const result = handleNodeAttachment(
        deps,
        url.pathname.slice(NODE_ATTACHMENT_PREFIX.length),
        headerValue(req.headers.authorization),
      );

      if (result.bytes === undefined) {
        logger.log("warn", "node attachment refused", { status: result.status });
        send(res, result.status, result.body, correlationId);
        return;
      }

      res.writeHead(200, {
        "content-type": result.mediaType,
        "content-length": result.bytes.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-correlation-id": correlationId,
      });
      res.end(result.bytes);
      return;
    }

    if (req.method === "POST" && url.pathname === NODE_OUTPUT_PATH) {
      const raw = await readBody(req, MAX_ATTACHMENT_BYTES);
      const result =
        raw === "too_large"
          ? {
              status: 413,
              body: errorBody("payload_too_large", "That output is larger than may be stored"),
            }
          : handleNodeOutput(
              deps,
              { correlationId, actorType: "node", actorId: "node" },
              req.headers,
              raw,
            );

      if (result.status !== 200) {
        logger.log("warn", "node output refused", { status: result.status });
      }

      send(res, result.status, result.body, correlationId);
      return;
    }

    // Node realm, like outputs: the node's own credential, checked inside.
    if (req.method === "POST" && url.pathname === NODE_FILE_PATH) {
      await handleNodeFile(deps, req, res, correlationId);
      return;
    }

    const isPair = req.method === "POST" && url.pathname === PAIR_PATH;
    // `/session/login` runs before the credential check, because presenting the
    // token in the body is how a browser obtains one. It is a POST with no
    // session, so the CSRF rule cannot apply to it either.
    const isLogin = req.method === "POST" && url.pathname === LOGIN_PATH;
    const isLogout = req.method === "POST" && url.pathname === LOGOUT_PATH;

    // Kept rather than discarded: `/push/subscribe` needs the session id, and
    // the only place it exists is the result of the check that just ran.
    let authorized: AuthorizeResult | undefined;

    if (!isLogin && !isPair) {
      const decision = authorize({
        method: req.method ?? "GET",
        authorization: headerValue(req.headers.authorization),
        cookie: headerValue(req.headers.cookie),
        csrfHeader: headerValue(req.headers["x-noctis-csrf"]),
        token: deps.config.token,
        session: (cookie) => verifySession(sessionDeps(deps), cookie),
      });

      if (decision.kind === "denied") {
        logger.log("warn", "rejected request", { reason: decision.reason });
        send(
          res,
          decision.reason === "csrf" ? 403 : 401,
          decision.reason === "csrf"
            ? errorBody("csrf_required", "A matching X-Noctis-CSRF header is required")
            : errorBody("unauthorized", "A valid bearer token or session is required"),
          correlationId,
        );
        return;
      }

      authorized = decision;
    }

    // The public half of the VAPID pair, which a browser needs before it can
    // subscribe. 404 when no keys are configured: a core without push says so
    // once, here, rather than accepting subscriptions it can never deliver to.
    if (req.method === "GET" && url.pathname === PUSH_KEY_PATH) {
      const publicKey = deps.notifier.publicKey();

      send(
        res,
        publicKey === undefined ? 404 : 200,
        publicKey === undefined
          ? errorBody("push_unavailable", "This core is not configured for web push")
          : { publicKey },
        correlationId,
      );
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
          // Not "connected clients", which is what this was called while it
          // was one: the core subscribes to its own broker twice now — the
          // notifier in `server.ts` and the conversation service — so it reads
          // 2 with nobody connected at all. Named for what it counts rather
          // than corrected by subtracting a constant that the next permanent
          // subscriber would silently invalidate.
          eventSubscribers: deps.kernel.broker.listenerCount,
          connectedNodes: deps.dispatcher.connectedCount,
          uptimeMs: deps.kernel.clock.now() - deps.startedAt,
        },
        correlationId,
      );
      return;
    }

    // Resuming a session the browser still holds. The cookie outlives the page
    // by thirty days; the CSRF value dies with the JS heap on every reload, tab
    // eviction, Home Screen cold start and notification tap — so without this
    // the owner meets the token prompt again with a valid session in hand.
    //
    // Safe as a GET: `SameSite=Strict` keeps the cookie off every cross-site
    // request, so a foreign page cannot make this call carry a credential at
    // all, and the core emits no CORS headers, so it could not read the body if
    // it did. Session-only, because a bearer caller has no session to re-mint.
    if (req.method === "GET" && url.pathname === SESSION_PATH) {
      if (authorized?.kind !== "session") {
        send(
          res,
          403,
          errorBody(
            "session_required",
            "Only a browser session can be resumed. A bearer token needs no csrf value.",
          ),
          correlationId,
        );
        return;
      }

      send(res, 200, { csrf: refreshCsrf(sessionDeps(deps), authorized.id) }, correlationId);
      return;
    }

    // Session-authenticated, so it sits after the credential gate. It must also
    // sit before the generic GET branch below: that branch answers with a
    // single JSON body and would otherwise swallow this path.
    if (req.method === "GET" && url.pathname === "/events/live") {
      const cursor = Number(url.searchParams.get("afterSequence") ?? "0");

      if (!Number.isInteger(cursor) || cursor < 0) {
        send(
          res,
          400,
          errorBody("invalid_request", "afterSequence must be a whole number"),
          correlationId,
        );
        return;
      }

      const close = openEventStream(
        {
          broker: deps.kernel.broker,
          readEvents: (after, limit) => readEventsAfter(deps.kernel.db, after, limit),
          latestSequence: () => latestSequence(deps.kernel.db),
          frames: deps.live,
          // Re-read on every heartbeat, not captured: the row this looks up is
          // what a logout deletes and what expiry retires, and the whole point
          // is to notice that on a connection that is already open.
          stillAuthorized:
            authorized?.kind === "session"
              ? () =>
                  verifySession(sessionDeps(deps), headerValue(req.headers.cookie)) !== undefined
              : () => true,
          heartbeatMs: SSE_HEARTBEAT_MS,
          setInterval,
          clearInterval,
        },
        res,
        cursor,
      );

      req.on("close", close);
      req.on("error", close);
      return;
    }

    // The one POST that is not `application/json`, so it sits above the check
    // that insists every other one is. Raw bytes with the file's own content
    // type and the name in a header: a multipart parser would be a dependency
    // and a second place for a filename to be smuggled through, for a form
    // Noctis never renders.
    if (req.method === "POST" && url.pathname === ATTACHMENT_UPLOAD_PATH) {
      const raw = await readBody(req, MAX_ATTACHMENT_BYTES);

      if (raw === "too_large") {
        send(
          res,
          413,
          errorBody("payload_too_large", "That file is larger than an attachment may be"),
          correlationId,
        );
        return;
      }

      const context: CommandContext = { correlationId, actorType: "user", actorId: "local" };
      const outcome = uploadAttachment(deps.kernel, context, {
        filename: headerValue(req.headers[ATTACHMENT_FILENAME_HEADER]) ?? "",
        // Split on `;` so `text/plain; charset=utf-8` is judged by its type.
        mediaType: (req.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "",
        bytes: raw,
      });

      if (!outcome.ok) {
        // A rejected name, type or size is the caller's mistake, not a core
        // that is temporarily unavailable — and `unavailable` is the only
        // `DomainConflict` kind that carries a reason string, which is the one
        // thing the page has to show. Mapped here rather than by widening
        // `DomainConflict`, which every exhaustive switch in the core would
        // then have to grow a case for.
        const refusal =
          outcome.conflict.kind === "unavailable" && outcome.conflict.entity === "attachment"
            ? {
                status: 400,
                body: errorBody("invalid_attachment", "That file cannot be attached", {
                  reason: outcome.conflict.reason,
                }),
              }
            : conflictResponse(outcome.conflict);

        // The filename is the owner's and goes in no log line; the reason does.
        logger.log("warn", "attachment refused", { status: refusal.status });
        send(res, refusal.status, refusal.body, correlationId);
        return;
      }

      logger.log("info", "attachment stored", {
        attachmentId: outcome.value.id,
        mediaType: outcome.value.mediaType,
        sizeBytes: outcome.value.sizeBytes,
      });
      send(res, 200, outcome.value, correlationId);
      return;
    }

    // An output's bytes for the page. The same headers the node realm sends,
    // plus `nosniff`, so a stored file is only ever the type it was stored as.
    if (
      req.method === "GET" &&
      segments.length === 3 &&
      segments[0] === "attachments" &&
      segments[2] === "content"
    ) {
      const id = segments[1] ?? "";
      const record = UuidSchema.safeParse(id).success
        ? getAttachment(deps.kernel.db, id)
        : undefined;
      const bytes = record === undefined ? undefined : readAttachmentBytes(deps.kernel.db, id);

      if (record === undefined || bytes === undefined) {
        send(res, 404, errorBody("not_found", "No such attachment"), correlationId);
        return;
      }

      res.writeHead(200, {
        "content-type": record.mediaType,
        "content-length": bytes.length,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
        // Opened directly, a stored file is inert: no script, no same-origin access.
        "content-security-policy": "sandbox; default-src 'none'",
        "x-correlation-id": correlationId,
      });
      res.end(bytes);
      return;
    }

    if (req.method === "GET" && url.pathname === "/sessions") {
      await handleSessions(deps, url, res, correlationId);
      return;
    }

    if (
      req.method === "GET" &&
      segments.length === 3 &&
      segments[0] === "threads" &&
      segments[2] === "history"
    ) {
      await handleThreadHistory(deps, segments[1] ?? "", res, correlationId);
      return;
    }

    if (
      req.method === "GET" &&
      segments.length === 2 &&
      segments[0] === "files" &&
      (segments[1] === "list" || segments[1] === "content")
    ) {
      await handleFiles(deps, segments[1], req, res, url, correlationId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/screen/live") {
      await handleScreen(deps, url, res, correlationId, () =>
        authorized?.kind === "session"
          ? verifySession(sessionDeps(deps), headerValue(req.headers.cookie)) !== undefined
          : true,
      );
      return;
    }

    // An unlock belongs to the credential that made it. Every request past the
    // gate above has one.
    const principal = authorized?.kind === "session" ? `session:${authorized.id}` : "bearer";

    if (req.method === "GET") {
      const result = handleRead(deps, segments, url, principal);
      send(res, result.status, result.body, correlationId);
      return;
    }

    const isCommand = req.method === "POST" && segments[0] === "commands" && segments.length === 2;
    const isSession = isLogin || isLogout;
    const passcodeAction =
      req.method === "POST" && segments.length === 2 && segments[0] === "passcode"
        ? segments[1]
        : undefined;
    const pushAction =
      req.method === "POST" && url.pathname === PUSH_SUBSCRIBE_PATH
        ? "subscribe"
        : req.method === "POST" && url.pathname === PUSH_UNSUBSCRIBE_PATH
          ? "unsubscribe"
          : undefined;

    if (passcodeAction !== undefined) {
      const raw = await readBody(req, MAX_BODY_BYTES);
      let body: unknown;

      try {
        body = raw === "too_large" ? undefined : (JSON.parse(raw.toString("utf8")) as unknown);
      } catch {
        body = undefined;
      }

      const result = handlePasscode(deps, passcodeAction, principal, body);

      // Never the passcode, only what happened to it.
      logger.log(result.status === 200 ? "info" : "warn", "passcode request handled", {
        action: passcodeAction,
        status: result.status,
      });
      send(res, result.status, result.body, correlationId);
      return;
    }

    if (!isCommand && !isPair && !isSession && pushAction === undefined) {
      send(res, 404, errorBody("not_found", "No such resource"), correlationId);
      return;
    }

    const name = segments[1] ?? "";
    const route =
      isPair || isSession || pushAction !== undefined
        ? undefined
        : Object.hasOwn(COMMANDS, name)
          ? COMMANDS[name]
          : undefined;

    if (!isPair && !isSession && pushAction === undefined && route === undefined) {
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

    if (pushAction !== undefined) {
      const result = handlePush(deps, pushAction, authorized, body);

      // The endpoint is the browser's own URL and goes in no log line.
      logger.log("info", "push subscription handled", {
        action: pushAction,
        status: result.status,
        ...(result.issues === undefined ? {} : { rejectedFields: result.issues }),
      });
      send(res, result.status, result.body, correlationId);
      return;
    }

    if (isLogin) {
      const parsed = LoginBodySchema.safeParse(body);

      if (!parsed.success) {
        send(res, 400, errorBody("invalid_request", "Body must be {token}"), correlationId);
        return;
      }

      // The same constant-time comparison the bearer realm uses. A failed login
      // says only that it failed.
      if (!isAuthorized(`Bearer ${parsed.data.token}`, deps.config.token)) {
        logger.log("warn", "rejected session login");
        send(res, 401, errorBody("unauthorized", "The token is not valid"), correlationId);
        return;
      }

      const created = createSession(sessionDeps(deps), deps.config.sessionTtlHours);

      res.setHeader(
        "set-cookie",
        sessionCookie(created.cookieValue, deps.config.sessionTtlHours * 3600),
      );

      logger.log("info", "session established");
      send(res, 200, { csrf: created.csrf }, correlationId);
      return;
    }

    if (isLogout) {
      const revoked = revokeSession(sessionDeps(deps), headerValue(req.headers.cookie));

      res.setHeader("set-cookie", sessionCookie("", 0));

      send(res, 200, { status: revoked ? "revoked" : "no_session" }, correlationId);
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
      // The commands whose effect reaches beyond the database. All run after
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
      } else if (name === "node.grant_capability") {
        const granted = GrantNodeCapabilityCommandSchema.safeParse(body);

        if (granted.success) {
          deps.dispatcher.sendGrants(granted.data.nodeId);
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
