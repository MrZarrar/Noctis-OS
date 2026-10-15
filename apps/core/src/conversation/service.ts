import type {
  AdoptRuntimeSessionCommand,
  CancelConversationTurnCommand,
  CreateConversationThreadCommand,
  ConversationThread,
  ConversationalIdentityId,
  EventName,
  ModelRef,
  OrchestrationEvent,
  RuntimeAsk,
  RuntimeDelegation,
  RuntimeDelegationResult,
  RuntimeDelta,
  RuntimeItem,
  RuntimeOutput,
  RuntimeProviderId,
  RuntimeTargets,
  RuntimeTurnPayload,
  RuntimeWarmPayload,
  SendConversationMessageCommand,
  StreamType,
  WarmConversationCommand,
} from "@noctis/contracts";
import {
  ConversationalIdentityIdSchema,
  ENVELOPE_VERSION,
  ModelRefSchema,
  RuntimeItemSchema,
  RuntimeTurnEvidenceSchema,
  RuntimeTurnPayloadSchema,
} from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { chooseProvider, conflict, ok } from "@noctis/domain";

import { attachmentRefs, linkTurnAttachments } from "../attachments/service.js";
import { declineAuthority, requestAuthority } from "../authority/service.js";
import type { NoctisDatabase } from "../db/connection.js";
import type { EventDraft } from "../db/events.js";
import type { Mutation } from "../db/transactions.js";
import type { LiveBroker } from "../events/live.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import type { Dispatcher } from "../nodes/dispatch.js";
import type { NodeJobRecord } from "../nodes/jobs.js";
import { cancelJob, enqueueJobInTransaction, getJob } from "../nodes/jobs.js";
import {
  listNodes,
  listRuntimeCandidates,
  listRuntimeRoots,
  sharedFolder,
} from "../nodes/registry.js";
import { listTasks } from "../productivity/tasks.js";
import type { RuntimeFrameHub } from "../nodes/runtime-frames.js";
import { getObjective } from "../objectives/service.js";
import type { VaultRoot } from "../vault/root.js";
import type { PendingAsk } from "./asks.js";
import { answerFromEvent, closePendingAsks, handleAsk } from "./asks.js";
import { catalogue, defaultModelFor } from "./models.js";
import { applyProposal } from "./proposals.js";
import { promptWithRecall, recallForPrompt } from "./recall-context.js";
import { createChildThread, createNamedThread, getThread, threadFor } from "./threads.js";

export type TurnStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** One user message in, one reply out, and everything the runtime did between. */
export interface Turn {
  id: string;
  threadId: string;
  identityId: ConversationalIdentityId;
  objectiveId?: string;
  userMessageId: string;
  jobId?: string;
  nodeId?: string;
  model: ModelRef;
  status: TurnStatus;
  items: RuntimeItem[];
  replyMessageId?: string;
  failureReason?: string;
  startedAt: string;
  completedAt?: string;
}

export interface Message {
  id: string;
  threadId: string;
  role: "user" | "identity" | "system";
  body: string;
  createdAt: string;
  protocolId?: string;
}

type TurnRow = {
  id: string;
  thread_id: string;
  identity_id: string;
  objective_id: string | null;
  user_message_id: string;
  node_job_id: string | null;
  node_id: string | null;
  model_json: string;
  status: string;
  items_json: string;
  reply_message_id: string | null;
  failure_reason: string | null;
  started_at: string;
  completed_at: string | null;
};

type MessageRow = {
  id: string;
  thread_id: string;
  role: string;
  protocol_id: string | null;
  created_at: string;
  body: string | null;
};

const TURN_SELECT = `SELECT t.id, t.thread_id, th.identity_id, th.objective_id, t.user_message_id,
                            t.node_job_id, t.node_id, t.model_json, t.status, t.items_json,
                            t.reply_message_id, t.failure_reason, t.started_at, t.completed_at
                       FROM identity_turns t
                       JOIN identity_threads th ON th.id = t.thread_id`;

const ItemsSchema = RuntimeItemSchema.array();

function toTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    threadId: row.thread_id,
    identityId: ConversationalIdentityIdSchema.parse(row.identity_id),
    ...(row.objective_id === null ? {} : { objectiveId: row.objective_id }),
    userMessageId: row.user_message_id,
    ...(row.node_job_id === null ? {} : { jobId: row.node_job_id }),
    ...(row.node_id === null ? {} : { nodeId: row.node_id }),
    model: ModelRefSchema.parse(JSON.parse(row.model_json)),
    status: row.status as TurnStatus,
    items: ItemsSchema.parse(JSON.parse(row.items_json)),
    ...(row.reply_message_id === null ? {} : { replyMessageId: row.reply_message_id }),
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

export function getTurn(db: NoctisDatabase, id: string): Turn | undefined {
  const row = db.prepare(`${TURN_SELECT} WHERE t.id = ?`).get(id) as TurnRow | undefined;

  return row === undefined ? undefined : toTurn(row);
}

export function getTurnByJobId(db: NoctisDatabase, jobId: string): Turn | undefined {
  const row = db.prepare(`${TURN_SELECT} WHERE t.node_job_id = ?`).get(jobId) as
    TurnRow | undefined;

  return row === undefined ? undefined : toTurn(row);
}

export function listTurns(db: NoctisDatabase, threadId: string, limit: number): Turn[] {
  const rows = db
    .prepare(`${TURN_SELECT} WHERE t.thread_id = ? ORDER BY t.started_at, t.id LIMIT ?`)
    .all(threadId, limit) as TurnRow[];

  return rows.map(toTurn);
}

/**
 * Every thread's turns, newest first: what Missions shows.
 *
 * Ordered by `started_at` rather than by id, because two turns started in the
 * same millisecond on different threads are still two turns, and the id breaks
 * the tie the same way it does within a thread.
 */
export function listRecentTurns(db: NoctisDatabase, limit: number): Turn[] {
  const rows = db
    .prepare(`${TURN_SELECT} ORDER BY t.started_at DESC, t.id DESC LIMIT ?`)
    .all(limit) as TurnRow[];

  return rows.map(toTurn);
}

/** Bodies join from `identity_message_content`; a pre-0006 row with no body reads as empty. */
export function listMessages(db: NoctisDatabase, threadId: string, limit: number): Message[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.thread_id, m.role, m.protocol_id, m.created_at, c.body
         FROM identity_messages m
         LEFT JOIN identity_message_content c ON c.message_id = m.id
        WHERE m.thread_id = ?
        ORDER BY m.created_at, m.id
        LIMIT ?`,
    )
    .all(threadId, limit) as MessageRow[];

  return rows.map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    role: row.role as Message["role"],
    body: row.body ?? "",
    createdAt: row.created_at,
    ...(row.protocol_id === null ? {} : { protocolId: row.protocol_id }),
  }));
}

function insertMessage(
  tx: NoctisDatabase,
  kernel: Kernel,
  threadId: string,
  role: Message["role"],
  body: string,
  now: string,
): string {
  const id = kernel.ids.nextId();

  // `content_ref` points at the content row today; residency can move later.
  tx.prepare(
    `INSERT INTO identity_messages (id, thread_id, role, content_ref, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, threadId, role, id, now);
  tx.prepare(
    `INSERT INTO identity_message_content (message_id, body, created_at) VALUES (?, ?, ?)`,
  ).run(id, body, now);

  return id;
}

type SessionRow = { node_id: string; session_ref: string };

/** The most recently used session for this thread and provider, on any node. */
function latestSession(
  db: NoctisDatabase,
  threadId: string,
  providerId: string,
): { nodeId: string; sessionRef: string } | undefined {
  const row = db
    .prepare(
      `SELECT node_id, session_ref FROM identity_sessions
        WHERE thread_id = ? AND provider_id = ? ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(threadId, providerId) as SessionRow | undefined;

  return row === undefined ? undefined : { nodeId: row.node_id, sessionRef: row.session_ref };
}

function sessionOn(
  db: NoctisDatabase,
  threadId: string,
  providerId: string,
  nodeId: string,
): { sessionRef: string; forkPending: boolean } | undefined {
  const row = db
    .prepare(
      `SELECT session_ref, fork_pending FROM identity_sessions
        WHERE thread_id = ? AND provider_id = ? AND node_id = ?`,
    )
    .get(threadId, providerId, nodeId) as { session_ref: string; fork_pending: number } | undefined;

  return row === undefined
    ? undefined
    : { sessionRef: row.session_ref, forkPending: row.fork_pending === 1 };
}

/** The model the thread's latest turn ran on. */
function lastModel(db: NoctisDatabase, threadId: string): ModelRef | undefined {
  const row = db
    .prepare(
      `SELECT model_json FROM identity_turns WHERE thread_id = ?
        ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(threadId) as { model_json: string } | undefined;

  return row === undefined ? undefined : ModelRefSchema.parse(JSON.parse(row.model_json));
}

function messageBody(db: NoctisDatabase, messageId: string): string | undefined {
  const row = db
    .prepare("SELECT body FROM identity_message_content WHERE message_id = ?")
    .get(messageId) as { body: string } | undefined;

  return row?.body;
}

/** A node named by id or by host name, the way an agent would name a machine. */
function findNode(db: NoctisDatabase, name: string): { id: string; hostId: string } | undefined {
  return db
    .prepare(
      `SELECT id, host_id AS hostId FROM nodes
        WHERE status != 'revoked' AND (id = ? OR host_id = ?) ORDER BY id LIMIT 1`,
    )
    .get(name, name) as { id: string; hostId: string } | undefined;
}

/** What a turn needs besides its thread. */
type ProviderDecision = ReturnType<typeof chooseProvider>;

/** Where a turn on a thread would run, as `routeTurn` decides it. */
interface TurnRoute {
  model: ModelRef;
  objectiveActive: boolean;
  decision: ProviderDecision;
  selected: ProviderDecision["selected"];
  reasonCodes: ProviderDecision["reasonCodes"];
  primaryRootGrantId: string | undefined;
}

interface TurnRequest {
  text: string;
  /** Absent means the identity's default model. */
  model: ModelRef | undefined;
  rootGrantId?: string;
  attachmentIds: readonly string[];
  /** Run on this node or not at all. */
  nodeId?: string;
}

/** A delegation the core is still working on: waiting for the owner, or for the child turn. */
interface OpenDelegation {
  nodeId: string;
  /** The parent turn's job. The answer goes back on it. */
  jobId: string;
  parentTurn: Turn;
  delegation: RuntimeDelegation;
  /** Where the child runs. Absent means wherever the parent runs. */
  target?: { id: string; hostId: string };
  approvalId?: string;
  childTurnId?: string;
}

export interface ConversationServiceDeps {
  tasksEnabled?: boolean;
  kernel: Kernel;
  dispatcher: Dispatcher;
  live: LiveBroker;
  runtimeFrames: RuntimeFrameHub;
  /**
   * The Vault, for the two things a turn does with it: the recall that informs
   * the prompt, and the Agent Brain a `preference` proposal appends to.
   * Absent when no Vault is configured, which is the default.
   */
  vaultRoot?: VaultRoot;
  /** Where the Vault write switch is read from. See `vault/writes.ts`. */
  vaultEnv?: Readonly<Record<string, string | undefined>>;
}

export interface ConversationService {
  sendMessage(context: CommandContext, command: SendConversationMessageCommand): Result<Turn>;
  /** Readies an agent before the owner sends: loads its model. Nothing is said, no turn is made. */
  warm(
    context: CommandContext,
    command: WarmConversationCommand,
  ): Result<{ threadId: string; jobId: string; awakeUntil: string }>;
  /** When the thread's agent goes back to sleep, or undefined while asleep. */
  awakeUntil(threadId: string): string | undefined;
  adoptSession(
    context: CommandContext,
    command: AdoptRuntimeSessionCommand,
  ): Result<ConversationThread>;
  createThread(
    context: CommandContext,
    command: CreateConversationThreadCommand,
  ): Result<ConversationThread>;
  cancelTurn(context: CommandContext, command: CancelConversationTurnCommand): Result<Turn>;
  onStreamItem(nodeId: string, jobId: string, sequence: number, item: RuntimeItem): void;
  onDelta(nodeId: string, jobId: string, delta: RuntimeDelta): void;
  onAsk(nodeId: string, jobId: string, ask: RuntimeAsk): void;
  onDelegate(nodeId: string, jobId: string, delegation: RuntimeDelegation): void;
  close(): void;
}

interface Final {
  status: "completed" | "failed" | "cancelled";
  stoppedReason?: string;
  failureReason?: string;
  sessionRef?: string;
}

function finalFromEvidence(evidence: unknown): Final {
  const parsed = RuntimeTurnEvidenceSchema.safeParse(evidence);

  if (!parsed.success) {
    return { status: "failed", failureReason: "evidence_unreadable" };
  }

  const { stoppedReason, sessionRef } = parsed.data;
  const status =
    stoppedReason === "completed"
      ? "completed"
      : stoppedReason === "cancelled"
        ? "cancelled"
        : "failed";

  return {
    status,
    stoppedReason,
    ...(sessionRef === undefined ? {} : { sessionRef }),
    ...(status === "failed" ? { failureReason: `runtime_${stoppedReason}` } : {}),
  };
}

/**
 * A prompt becomes a turn: a user message, a provider decision, and a
 * `runtime.turn` job pinned to the node that offers the model. Items the node
 * streams back become events and messages; deltas go to `LiveBroker` and
 * nowhere else; asks become authority requests whose answers travel back.
 *
 * Every write is one `runCommand`; nothing here nests one. The service
 * subscribes to the frame hub and the event broker on creation and lets go on
 * `close`.
 */
export function createConversationService(deps: ConversationServiceDeps): ConversationService {
  const { kernel, dispatcher, live } = deps;
  /** jobId -> threadId, so a delta costs no read. Filled on send, lazily otherwise. */
  const threadByJob = new Map<string, string>();
  const pendingAsks = new Map<string, PendingAsk>();
  /** Keyed by delegation id. */
  const delegations = new Map<string, OpenDelegation>();

  function nowIso(): string {
    return new Date(kernel.clock.now()).toISOString();
  }

  /**
   * The model a thread that belongs to one agent runs on, when nobody chose:
   * its own last model for that agent, else the identity's default if it is
   * that agent, else the first model any connected node offers for it.
   */
  function modelFor(
    tx: NoctisDatabase,
    threadId: string,
    identityId: ConversationalIdentityId,
    providerId: RuntimeProviderId,
  ): ModelRef | undefined {
    const previous = lastModel(tx, threadId);
    const fallback = defaultModelFor(tx, identityId);

    return previous?.providerId === providerId
      ? previous
      : fallback?.providerId === providerId
        ? fallback
        : catalogue(tx, (id) => dispatcher.isConnected(id)).find(
            (candidate) => candidate.providerId === providerId,
          );
  }

  function identityContext(turn: Turn): CommandContext {
    return { correlationId: kernel.ids.nextId(), actorType: "identity", actorId: turn.identityId };
  }

  function draft(
    context: CommandContext,
    streamType: StreamType,
    streamId: string,
    type: EventName,
    payload: unknown,
    occurredAt: string,
  ): EventDraft {
    return {
      id: kernel.ids.nextId(),
      streamType,
      streamId,
      type,
      actorType: context.actorType,
      actorId: context.actorId,
      payloadVersion: 1,
      payload,
      correlationId: context.correlationId,
      occurredAt,
    };
  }

  /**
   * A prompt on a thread becomes a user message, a provider decision and, when
   * something can run it, a `runtime.turn` job. Runs inside the caller's
   * command, so a refusal rolls back whatever the caller wrote before it.
   */
  /**
   * Which model, PC and folder a turn on this thread would run with, or why it
   * cannot run. Shared by a turn and a wake, so waking readies exactly what the
   * next message will use. Writes nothing.
   */
  function routeTurn(
    tx: NoctisDatabase,
    thread: ConversationThread,
    request: Pick<TurnRequest, "model" | "rootGrantId" | "nodeId">,
    now: number,
  ): Result<TurnRoute> {
    const { identityId, objectiveId } = thread;
    const model =
      identityId === "jester"
        ? (request.model ?? modelFor(tx, thread.id, identityId, "hermes"))
        : (request.model ?? defaultModelFor(tx, identityId));

    if (model === undefined) {
      return conflict({ kind: "unavailable", entity: "model", reason: "no_default_model" });
    }

    // ADR-0030: Jester is Hermes. Its turns never run on another agent, even
    // a local one, because Jester's soul and limits live on Hermes's home.
    if (identityId === "jester" && model.providerId !== "hermes") {
      return conflict({ kind: "unavailable", entity: "model", reason: "jester_runs_on_hermes" });
    }

    const objective = objectiveId === undefined ? undefined : getObjective(tx, objectiveId);

    // Carried to the node so it can choose auto-allow behaviour honestly;
    // the evaluator still makes the actual decision on each ask.
    const objectiveActive = objective?.status === "active";

    const requiredRoots = request.rootGrantId === undefined ? [] : [request.rootGrantId];
    const candidates = listRuntimeCandidates(
      tx,
      (nodeId) => dispatcher.isConnected(nodeId),
      requiredRoots,
      now,
    ).filter((candidate) => request.nodeId === undefined || candidate.nodeId === request.nodeId);
    // S1 rule (plan 1.6, behaviour 1): Jester's work never leaves this
    // machine, so a Jester turn may only land on a local-auth runtime.
    // Vesper's may go anywhere granted. Per-root local-only comes with the
    // roots that carry it.
    const localOnly = identityId === "jester";
    const affinity = latestSession(tx, thread.id, model.providerId);
    const decision = chooseProvider(model, candidates, {
      ...(affinity === undefined ? {} : { preferredNodeId: affinity.nodeId }),
      localOnly,
    });

    // Task 2.6: a host that is merely asleep is a different answer from a
    // host that could never run this. Refusing before anything is written
    // means the owner can wake the machine and send the same prompt again,
    // rather than finding a failed turn in the thread they have to read
    // past — and the page can offer the same prompt somewhere else, which
    // it can only do if the send did not already happen.
    if (
      decision.selected === undefined &&
      decision.candidates.some(
        (candidate) =>
          candidate.reasonCodes.length === 1 && candidate.reasonCodes[0] === "not_connected",
      )
    ) {
      return conflict({ kind: "unavailable", entity: "node", reason: "node_offline" });
    }

    let selected = decision.selected;
    let reasonCodes = decision.reasonCodes;
    let primaryRootGrantId = request.rootGrantId;

    if (selected !== undefined && primaryRootGrantId === undefined) {
      const chosenNodeId = selected.nodeId;
      const chosen = candidates.find(
        (candidate) =>
          candidate.nodeId === chosenNodeId && candidate.probe.providerId === model.providerId,
      );

      primaryRootGrantId = chosen?.roots.find((root) => root.mode === "write")?.grantId;

      if (primaryRootGrantId === undefined) {
        // 0.5: a turn may edit files, so a node with nowhere to write is
        // not a node that can run it.
        selected = undefined;
        reasonCodes = [...reasonCodes, "no_writable_root"];
      }
    }

    return ok({ model, objectiveActive, decision, selected, reasonCodes, primaryRootGrantId });
  }

  function openTurn(
    tx: NoctisDatabase,
    context: CommandContext,
    thread: ConversationThread,
    request: TurnRequest,
    turnId: string,
    now: number,
  ): Result<Mutation<Turn>> {
    const at = new Date(now).toISOString();
    const { identityId, objectiveId } = thread;
    const routed = routeTurn(tx, thread, request, now);

    if (!routed.ok) {
      return conflict(routed.conflict);
    }

    const { model, objectiveActive, decision } = routed.value;
    const { selected, reasonCodes, primaryRootGrantId } = routed.value;
    // Resolved before anything is written. An id that names no attachment
    // is a client bug, and sending the turn without the file the prompt
    // refers to would produce an answer about a file the model never saw.
    const { attachmentIds } = request;
    const attachments = attachmentRefs(tx, attachmentIds);

    if (attachments.length !== attachmentIds.length) {
      const missing = attachmentIds.find(
        (id) => !attachments.some((attachment) => attachment.id === id),
      );

      return conflict({ kind: "not_found", entity: "attachment", id: missing ?? "unknown" });
    }

    const userMessageId = insertMessage(tx, kernel, thread.id, "user", request.text, at);

    const events: EventDraft[] = [
      draft(
        context,
        "identity",
        thread.id,
        "identity.message_added.v1",
        { messageId: userMessageId, role: "user", turnId },
        at,
      ),
    ];
    let job: NodeJobRecord | undefined;

    if (selected !== undefined && primaryRootGrantId !== undefined) {
      const session = sessionOn(tx, thread.id, model.providerId, selected.nodeId);
      const scheduledRun =
        context.actorType === "identity" && context.actorId === identityId
          ? (tx
              .prepare(
                "SELECT task_id FROM task_runs WHERE status='running' AND node_id=? AND json_extract(data_json,'$.threadId')=? LIMIT 1",
              )
              .get(selected.nodeId, thread.id) as { task_id: string } | undefined)
          : undefined;
      const payload: RuntimeTurnPayload = {
        threadId: thread.id,
        identityId,
        model: selected.model,
        userMessageId,
        prompt: promptWithRecall(request.text, recallForPrompt(tx, request.text, deps)),
        primaryRootGrantId,
        ...(session === undefined ? {} : { sessionRef: session.sessionRef }),
        ...(session?.forkPending === true ? { forkSession: true } : {}),
        ...(objectiveId === undefined ? {} : { objectiveId }),
        objectiveActive,
        ...(scheduledRun === undefined ? {} : { scheduledTaskId: scheduledRun.task_id }),
        ...(attachments.length === 0 ? {} : { attachments }),
        targets: runtimeTargets(tx, (id) => dispatcher.isConnected(id), selected.nodeId, now),
      };
      const enqueued = enqueueJobInTransaction(tx, kernel, context, {
        capability: "runtime.turn",
        payload,
        idempotencyKey: `turn:${turnId}`,
        pinnedNodeId: selected.nodeId,
      });

      if (!enqueued.ok) {
        return conflict(enqueued.conflict);
      }

      job = enqueued.value.value;
      events.push(...enqueued.value.events);
    }

    const chosenModel = selected?.model ?? model;
    const failureReason =
      job === undefined ? `no_eligible_provider:${reasonCodes.join(",")}` : undefined;

    tx.prepare(
      `INSERT INTO identity_turns
         (id, thread_id, user_message_id, node_job_id, node_id, provider_id, model_json,
          status, items_json, failure_reason, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
    ).run(
      turnId,
      thread.id,
      userMessageId,
      job?.job.id ?? null,
      job === undefined ? null : (selected?.nodeId ?? null),
      model.providerId,
      JSON.stringify(chosenModel),
      job === undefined ? "failed" : "queued",
      failureReason ?? null,
      at,
      job === undefined ? at : null,
    );

    // After the turn row, because of the foreign key. Recorded even when no
    // node could be found: the turn failed *with* these files attached, and
    // a retry that re-sent them would otherwise look like a different ask.
    linkTurnAttachments(tx, turnId, attachmentIds);

    tx.prepare(
      `INSERT INTO provider_decisions
         (id, turn_id, requested_model_json, selected_node_id, selected_model,
          candidates_json, reason_codes_json, cost_class, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      kernel.ids.nextId(),
      turnId,
      JSON.stringify(model),
      job === undefined ? null : (selected?.nodeId ?? null),
      job === undefined ? null : chosenModel.model,
      JSON.stringify(decision.candidates),
      JSON.stringify(reasonCodes),
      job === undefined ? "none" : decision.costClass,
      at,
    );

    events.push(
      draft(
        context,
        "provider",
        turnId,
        "provider.decision_recorded.v1",
        {
          turnId,
          model,
          ...(job === undefined || selected === undefined ? {} : { selected }),
          candidates: decision.candidates,
          reasonCodes,
          costClass: job === undefined ? "none" : decision.costClass,
        },
        at,
      ),
    );

    if (job !== undefined && selected !== undefined) {
      events.push(
        draft(
          context,
          "identity",
          thread.id,
          "identity.turn_started.v1",
          {
            turnId,
            jobId: job.job.id,
            nodeId: selected.nodeId,
            model: selected.model,
            ...(objectiveId === undefined ? {} : { objectiveId }),
            objectiveActive,
          },
          at,
        ),
      );
    } else {
      // Returned as `ok`: the user sees an honest failed turn in the thread
      // — "nothing can run this model right now" — rather than a 5xx that
      // loses their message. `unavailable` is reserved for "no model at all".
      events.push(
        draft(
          context,
          "identity",
          thread.id,
          "identity.turn_completed.v1",
          { turnId, threadId: thread.id, status: "failed", failureReason, model },
          at,
        ),
      );
    }

    const turn = getTurn(tx, turnId);

    if (turn === undefined) {
      throw new Error(`Turn ${turnId} vanished mid-transaction`);
    }

    return ok({ value: turn, events });
  }

  /** Post-commit, like http.ts does for node.job_enqueue: a job frame must never describe a row a rollback erased. */
  /**
   * How long a woken agent stays ready: LM Studio unloads a model after ten
   * idle minutes ("--ttl 600" in the node's lmstudio.ts), so the page shows it
   * asleep again then.
   */
  const AWAKE_MS = 10 * 60_000;
  /** Thread -> when its agent goes back to sleep. Memory only: a restart forgets it. */
  const awake = new Map<string, number>();
  /** A warm job -> its thread, so a failed wake clears the thread's awake time. */
  const warmJobs = new Map<string, string>();

  function warm(
    context: CommandContext,
    command: WarmConversationCommand,
  ): Result<{ threadId: string; jobId: string; awakeUntil: string }> {
    const now = kernel.clock.now();
    const at = new Date(now).toISOString();

    const outcome = runCommand<{ threadId: string; jobId: string; awakeUntil: string }>(
      kernel,
      { scope: "conversation.warm", key: command.idempotencyKey, resultId: kernel.ids.nextId() },
      (tx) => {
        const resolved = resolveThread(tx, command, at);

        if (!resolved.ok) {
          return conflict(resolved.conflict);
        }

        const { thread, model, rootGrantId } = resolved.value;
        const routed = routeTurn(
          tx,
          thread,
          {
            model,
            ...(rootGrantId === undefined ? {} : { rootGrantId }),
            ...(thread.nodeId === undefined ? {} : { nodeId: thread.nodeId }),
          },
          now,
        );

        if (!routed.ok) {
          return conflict(routed.conflict);
        }

        const { selected, primaryRootGrantId, reasonCodes, objectiveActive } = routed.value;

        if (selected === undefined || primaryRootGrantId === undefined) {
          return conflict({
            kind: "unavailable",
            entity: "node",
            reason: `no_eligible_provider:${reasonCodes.join(",")}`,
          });
        }

        const session = sessionOn(tx, thread.id, selected.model.providerId, selected.nodeId);
        const payload: RuntimeWarmPayload = {
          threadId: thread.id,
          identityId: thread.identityId,
          model: selected.model,
          primaryRootGrantId,
          ...(session === undefined ? {} : { sessionRef: session.sessionRef }),
          ...(session?.forkPending === true ? { forkSession: true } : {}),
          ...(thread.objectiveId === undefined ? {} : { objectiveId: thread.objectiveId }),
          objectiveActive,
        };
        const enqueued = enqueueJobInTransaction(tx, kernel, context, {
          capability: "runtime.warm",
          payload,
          idempotencyKey: `warm:${command.idempotencyKey}`,
          pinnedNodeId: selected.nodeId,
        });

        if (!enqueued.ok) {
          return conflict(enqueued.conflict);
        }

        return ok({
          value: {
            threadId: thread.id,
            jobId: enqueued.value.value.job.id,
            awakeUntil: new Date(now + AWAKE_MS).toISOString(),
          },
          events: enqueued.value.events,
        });
      },
    );

    if (outcome.ok) {
      awake.set(outcome.value.threadId, now + AWAKE_MS);
      warmJobs.set(outcome.value.jobId, outcome.value.threadId);
      dispatcher.pass();
    }

    return outcome;
  }

  /** When this thread's agent goes back to sleep, if it is awake now. */
  function awakeUntil(threadId: string): string | undefined {
    const until = awake.get(threadId);

    return until === undefined || until <= kernel.clock.now()
      ? undefined
      : new Date(until).toISOString();
  }

  /** A wake that failed, or found nothing to ready, leaves the agent asleep. */
  function settleWarm(jobId: string, warmed: boolean): void {
    const threadId = warmJobs.get(jobId);

    warmJobs.delete(jobId);

    if (threadId !== undefined && !warmed) {
      awake.delete(threadId);
    }
  }

  function dispatchOpened(outcome: Result<Turn>): void {
    if (outcome.ok && outcome.value.jobId !== undefined) {
      threadByJob.set(outcome.value.jobId, outcome.value.threadId);
      dispatcher.pass();
    }
  }

  /**
   * The thread a message or a wake is for, and the model and folder it asks
   * for. Shared, so a wake readies the thread the next message will land on.
   */
  function resolveThread(
    tx: NoctisDatabase,
    command: Pick<
      SendConversationMessageCommand,
      "identityId" | "threadId" | "objectiveId" | "model" | "rootGrantId"
    >,
    at: string,
  ): Result<{
    thread: ConversationThread;
    model: ModelRef | undefined;
    rootGrantId: string | undefined;
  }> {
    let thread: ConversationThread;

    if (command.threadId !== undefined) {
      const named = getThread(tx, command.threadId);

      // The other identity's thread is not one this identity may write to.
      if (named === undefined || named.identityId !== command.identityId) {
        return conflict({ kind: "not_found", entity: "thread", id: command.threadId });
      }

      thread = named;
    } else {
      if (
        command.objectiveId !== undefined &&
        getObjective(tx, command.objectiveId) === undefined
      ) {
        return conflict({ kind: "not_found", entity: "objective", id: command.objectiveId });
      }

      thread = threadFor(tx, kernel, command.identityId, command.objectiveId, at);
    }

    // A pinned thread holds one agent's session in one folder on one PC;
    // anything else would start that agent somewhere its session is not.
    const pinned = thread.providerId;

    if (
      pinned !== undefined &&
      command.model !== undefined &&
      command.model.providerId !== pinned
    ) {
      return conflict({
        kind: "unavailable",
        entity: "thread",
        reason: `thread_runs_on_${pinned}`,
      });
    }

    if (
      thread.rootGrantId !== undefined &&
      command.rootGrantId !== undefined &&
      command.rootGrantId !== thread.rootGrantId
    ) {
      return conflict({
        kind: "unavailable",
        entity: "thread",
        reason: `thread_runs_in_${thread.rootGrantId}`,
      });
    }

    const model =
      command.model ??
      (pinned !== undefined
        ? modelFor(tx, thread.id, thread.identityId, pinned)
        : // A delegated thread belongs to the runtime that was asked, not to
          // the identity's default, so the owner's follow-up stays on it.
          thread.parentThreadId === undefined
          ? undefined
          : lastModel(tx, thread.id));
    const rootGrantId = command.rootGrantId ?? thread.rootGrantId;

    return ok({ thread, model, rootGrantId });
  }

  function sendMessage(
    context: CommandContext,
    command: SendConversationMessageCommand,
  ): Result<Turn> {
    const now = kernel.clock.now();
    const at = new Date(now).toISOString();
    const turnId = kernel.ids.nextId();

    const outcome = runCommand<Turn>(
      kernel,
      { scope: "conversation.send", key: command.idempotencyKey, resultId: turnId },
      (tx) => {
        const resolved = resolveThread(tx, command, at);

        if (!resolved.ok) {
          return conflict(resolved.conflict);
        }

        const { thread, model, rootGrantId } = resolved.value;

        return openTurn(
          tx,
          context,
          thread,
          {
            text: command.text,
            model,
            ...(rootGrantId === undefined ? {} : { rootGrantId }),
            ...(thread.nodeId === undefined ? {} : { nodeId: thread.nodeId }),
            attachmentIds: command.attachmentIds ?? [],
          },
          turnId,
          now,
        );
      },
    );

    dispatchOpened(outcome);

    return outcome;
  }

  /** A new conversation beside the identity's free one. */
  function createThread(
    context: CommandContext,
    command: CreateConversationThreadCommand,
  ): Result<ConversationThread> {
    const threadId = kernel.ids.nextId();

    return runCommand<ConversationThread>(
      kernel,
      { scope: "conversation.create_thread", key: command.idempotencyKey, resultId: threadId },
      (tx) =>
        ok({
          value: createNamedThread(
            tx,
            kernel,
            {
              identityId: command.identityId,
              ...(command.title === undefined ? {} : { title: command.title }),
            },
            nowIso(),
          ),
          events: [],
        }),
    );
  }

  /**
   * A session an agent already keeps on a PC becomes a thread pinned to that
   * PC, folder and agent. Its first turn forks the session (`fork_pending`),
   * so VS Code, which may still have it open, is never written under.
   */
  function adoptSession(
    context: CommandContext,
    command: AdoptRuntimeSessionCommand,
  ): Result<ConversationThread> {
    const now = nowIso();
    const threadId = kernel.ids.nextId();

    return runCommand<ConversationThread>(
      kernel,
      { scope: "conversation.adopt_session", key: command.idempotencyKey, resultId: threadId },
      (tx) => {
        const shared = sharedFolder(tx, command.nodeId, command.rootGrantId, kernel.clock.now());

        if (shared === undefined || !shared.providers.includes(command.providerId)) {
          return conflict({
            kind: "not_found",
            entity: "shared_folder",
            id: `${command.rootGrantId}:${command.providerId}`,
          });
        }

        const thread = createNamedThread(
          tx,
          kernel,
          {
            identityId: command.identityId,
            title: command.title,
            nodeId: command.nodeId,
            rootGrantId: command.rootGrantId,
            providerId: command.providerId,
            adoptedSessionRef: command.sessionRef,
          },
          now,
        );

        tx.prepare(
          `INSERT INTO identity_sessions
             (id, thread_id, provider_id, node_id, session_ref, fork_pending, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(
          kernel.ids.nextId(),
          thread.id,
          command.providerId,
          command.nodeId,
          command.sessionRef,
          now,
          now,
        );

        return ok({ value: thread, events: [] });
      },
    );
  }

  function cancelTurn(
    context: CommandContext,
    command: CancelConversationTurnCommand,
  ): Result<Turn> {
    const cancelled = cancelJob(kernel, context, {
      idempotencyKey: command.idempotencyKey,
      jobId: command.jobId,
    });

    if (!cancelled.ok && cancelled.conflict.kind !== "idempotent_replay") {
      return conflict(cancelled.conflict);
    }

    // The job's status change has already reached the broker subscription
    // below, so the turn read here is the cancelled one.
    const turn = getTurnByJobId(kernel.db, command.jobId);

    if (turn === undefined) {
      return conflict({ kind: "not_found", entity: "turn", id: command.jobId });
    }

    if (cancelled.ok && cancelled.value.job.nodeId !== undefined) {
      dispatcher.sendCancel(cancelled.value.job.nodeId, command.jobId);
    }

    return ok(turn);
  }

  function onStreamItem(nodeId: string, jobId: string, sequence: number, item: RuntimeItem): void {
    if (item.kind === "proposal") {
      item = { itemId: item.itemId, kind: item.kind, status: item.status, proposal: item.proposal };
    }
    const turn = getTurnByJobId(kernel.db, jobId);

    if (turn === undefined) {
      // A job that is not a turn's. The socket already checked the node holds it.
      return;
    }

    const context = identityContext(turn);
    const at = nowIso();
    const recorded = runCommand<Turn>(
      kernel,
      { scope: "conversation.item", key: `${jobId}:${String(sequence)}`, resultId: turn.id },
      (tx) => {
        const current = getTurn(tx, turn.id);

        if (current === undefined) {
          return conflict({ kind: "not_found", entity: "turn", id: turn.id });
        }

        // Upsert by item id: the later frame about an item is its later state.
        const items = current.items.some((existing) => existing.itemId === item.itemId)
          ? current.items.map((existing) => (existing.itemId === item.itemId ? item : existing))
          : [...current.items, item];
        const status: TurnStatus = current.status === "queued" ? "running" : current.status;
        const events: EventDraft[] = [
          draft(
            context,
            "identity",
            current.threadId,
            "identity.turn_item.v1",
            { turnId: current.id, jobId, sequence, item },
            at,
          ),
        ];
        let replyMessageId = current.replyMessageId;

        if (item.kind === "agent_message" && item.status === "completed" && item.text !== "") {
          replyMessageId = insertMessage(tx, kernel, current.threadId, "identity", item.text, at);
          events.push(
            draft(
              context,
              "identity",
              current.threadId,
              "identity.message_added.v1",
              {
                messageId: replyMessageId,
                role: "identity",
                turnId: current.id,
                itemId: item.itemId,
              },
              at,
            ),
          );
        }

        tx.prepare(
          `UPDATE identity_turns SET items_json = ?, status = ?, reply_message_id = ? WHERE id = ?`,
        ).run(JSON.stringify(items), status, replyMessageId ?? null, current.id);

        const updated = getTurn(tx, current.id);

        if (updated === undefined) {
          throw new Error(`Turn ${current.id} vanished mid-transaction`);
        }

        return ok({ value: updated, events });
      },
    );

    if (!recorded.ok) {
      if (recorded.conflict.kind !== "idempotent_replay") {
        kernel.logger.log("warn", "could not record a turn item", {
          jobId,
          sequence,
          conflict: recorded.conflict.kind,
        });
      }

      return;
    }

    if (item.kind === "proposal" && item.status === "completed") {
      // A second, sequential command after the item committed — never nested.
      const appliedRecordId = applyProposal(
        kernel,
        context,
        recorded.value,
        item.proposal,
        `proposal:${jobId}:${item.itemId}`,
        {
          ...(deps.vaultRoot === undefined ? {} : { vaultRoot: deps.vaultRoot }),
          ...(deps.vaultEnv === undefined ? {} : { vaultEnv: deps.vaultEnv }),
          taskExecution: {
            conversation: { sendMessage, cancelTurn },
            dispatcher,
            enabled: deps.tasksEnabled === true,
          },
        },
      );
      if (appliedRecordId !== undefined) {
        const appliedItem = { ...item, appliedRecordId };
        const receipt = runCommand<Turn>(
          kernel,
          {
            scope: "conversation.proposal_result",
            key: `${jobId}:${String(sequence)}`,
            resultId: turn.id,
          },
          (tx) => {
            const current = getTurn(tx, turn.id);
            if (current === undefined)
              return conflict({ kind: "not_found", entity: "turn", id: turn.id });
            const items = current.items.map((existing) =>
              existing.itemId === item.itemId ? appliedItem : existing,
            );
            tx.prepare("UPDATE identity_turns SET items_json=? WHERE id=?").run(
              JSON.stringify(items),
              current.id,
            );
            return ok({
              value: { ...current, items },
              events: [
                draft(
                  context,
                  "identity",
                  current.threadId,
                  "identity.turn_item.v1",
                  { turnId: current.id, jobId, sequence, item: appliedItem },
                  nowIso(),
                ),
              ],
            });
          },
        );
        if (!receipt.ok && receipt.conflict.kind !== "idempotent_replay")
          kernel.logger.log("warn", "could not record proposal receipt", {
            turnId: turn.id,
            conflict: receipt.conflict.kind,
          });
      }
    }
  }

  function onDelta(_nodeId: string, jobId: string, delta: RuntimeDelta): void {
    let threadId = threadByJob.get(jobId);

    if (threadId === undefined) {
      const turn = getTurnByJobId(kernel.db, jobId);

      if (turn === undefined) {
        return;
      }

      threadId = turn.threadId;
      threadByJob.set(jobId, threadId);
    }

    // Nothing written. ADR-0022: a delta is the one ephemeral frame.
    live.publish({
      kind: "runtime_delta",
      envelopeVersion: ENVELOPE_VERSION,
      threadId,
      jobId,
      itemId: delta.itemId,
      text: delta.text,
    });
  }

  function onAsk(nodeId: string, jobId: string, ask: RuntimeAsk): void {
    const turn = getTurnByJobId(kernel.db, jobId);

    if (turn === undefined) {
      kernel.logger.log("warn", "an ask arrived for a job that is not a turn", { jobId });
      return;
    }

    handleAsk(kernel, dispatcher, pendingAsks, turn, nodeId, jobId, ask);
  }

  function answerDelegation(
    open: OpenDelegation,
    result: Omit<RuntimeDelegationResult, "delegationId" | "outputs"> & {
      outputs?: RuntimeOutput[];
    },
  ): void {
    delegations.delete(open.delegation.delegationId);
    dispatcher.sendDelegated(open.nodeId, open.jobId, {
      delegationId: open.delegation.delegationId,
      outputs: [],
      ...result,
    });
  }

  function refuseDelegation(open: OpenDelegation, reason: string): void {
    answerDelegation(open, { outcome: "refused", reason: reason.slice(0, 500) });
  }

  /**
   * An agent asked for another agent. The thread it names must be one its own
   * thread started; the machine it names must exist; then the authority service
   * decides, like any other step, and the child turn opens once it says yes.
   */
  function onDelegate(nodeId: string, jobId: string, delegation: RuntimeDelegation): void {
    const parentTurn = getTurnByJobId(kernel.db, jobId);

    if (parentTurn === undefined) {
      dispatcher.sendDelegated(nodeId, jobId, {
        delegationId: delegation.delegationId,
        outcome: "refused",
        outputs: [],
        reason: "only a conversation turn can delegate",
      });
      return;
    }

    if (delegations.has(delegation.delegationId)) {
      return;
    }

    const open: OpenDelegation = { nodeId, jobId, delegation, parentTurn };

    if (delegation.threadId !== undefined) {
      const child = getThread(kernel.db, delegation.threadId);

      if (child?.parentThreadId !== parentTurn.threadId) {
        refuseDelegation(open, `thread ${delegation.threadId} was not delegated from this thread`);
        return;
      }
    }

    if (delegation.node !== undefined) {
      const target = findNode(kernel.db, delegation.node);

      if (target === undefined) {
        refuseDelegation(open, `no node is named ${delegation.node}`);
        return;
      }

      open.target = target;
    }

    delegations.set(delegation.delegationId, open);

    const decision = requestAuthority(kernel, identityContext(parentTurn), {
      idempotencyKey: `delegate:${delegation.delegationId}`,
      ...(parentTurn.objectiveId === undefined ? {} : { objectiveId: parentTurn.objectiveId }),
      actorId: parentTurn.identityId,
      // The child works inside granted roots under its own gates, the same
      // bounds a local edit has; anything consequential it does asks on its own.
      operationClass: "local_reversible_edit",
      capability: "runtime.delegate",
      target: {
        type: "runtime",
        id: delegation.runtime,
        ...(open.target === undefined ? {} : { hostId: open.target.hostId }),
      },
      consequenceSummary: `hand to ${delegation.runtime}: ${delegation.prompt.slice(0, 300)}`,
      reversibility: "reversible",
      nodeJobId: jobId,
    });

    if (!decision.ok) {
      refuseDelegation(
        open,
        `authority could not record the delegation: ${decision.conflict.kind}`,
      );
      return;
    }

    open.approvalId = decision.value.requestId;

    if (decision.value.outcome === "allow") {
      startDelegation(open);
    } else if (decision.value.outcome === "deny") {
      refuseDelegation(open, `denied: ${decision.value.reasonCodes.join(",")}`);
    }
    // Otherwise a person decides; `onEvents` picks up the confirm or decline.
  }

  /** Opens the child turn: a new thread linked to the parent, or the one named. */
  function startDelegation(open: OpenDelegation): void {
    const { delegation, parentTurn } = open;
    const now = kernel.clock.now();
    const at = new Date(now).toISOString();
    const turnId = kernel.ids.nextId();
    // Unless told otherwise the child runs where the parent runs, in the same
    // folder, so what one agent writes the other can read.
    const sameNode = open.target === undefined || open.target.id === parentTurn.nodeId;
    const parentPayload =
      parentTurn.jobId === undefined ? undefined : getJob(kernel.db, parentTurn.jobId)?.job.payload;
    const parentRoot = RuntimeTurnPayloadSchema.safeParse(parentPayload);
    const nodeId = open.target?.id ?? parentTurn.nodeId;

    const outcome = runCommand<Turn>(
      kernel,
      { scope: "conversation.delegate", key: delegation.delegationId, resultId: turnId },
      (tx) => {
        const parentThread = getThread(tx, parentTurn.threadId);

        if (parentThread === undefined) {
          return conflict({ kind: "not_found", entity: "thread", id: parentTurn.threadId });
        }

        const thread =
          delegation.threadId === undefined
            ? createChildThread(tx, kernel, parentThread, parentTurn.id, at)
            : getThread(tx, delegation.threadId);

        if (thread === undefined) {
          return conflict({ kind: "not_found", entity: "thread", id: delegation.threadId ?? "" });
        }

        const model = modelFor(tx, thread.id, parentTurn.identityId, delegation.runtime);

        if (model === undefined) {
          return conflict({
            kind: "unavailable",
            entity: "model",
            reason: `no connected node offers ${delegation.runtime}`,
          });
        }

        return openTurn(
          tx,
          identityContext(parentTurn),
          thread,
          {
            text: delegation.prompt,
            model,
            ...(sameNode && parentRoot.success
              ? { rootGrantId: parentRoot.data.primaryRootGrantId }
              : {}),
            attachmentIds: [],
            ...(nodeId === undefined ? {} : { nodeId }),
          },
          turnId,
          now,
        );
      },
    );

    if (!outcome.ok) {
      refuseDelegation(
        open,
        outcome.conflict.kind === "unavailable"
          ? outcome.conflict.reason
          : `the child turn could not open: ${outcome.conflict.kind}`,
      );
      return;
    }

    dispatchOpened(outcome);

    if (outcome.value.status === "failed") {
      answerDelegation(open, {
        outcome: "failed",
        threadId: outcome.value.threadId,
        reason: outcome.value.failureReason ?? "the child turn failed",
      });
      return;
    }

    open.childTurnId = outcome.value.id;
  }

  /** The child turn ended: its reply and whatever it produced go back to the parent. */
  function finishDelegation(open: OpenDelegation, turn: Turn): void {
    const reply =
      turn.replyMessageId === undefined ? undefined : messageBody(kernel.db, turn.replyMessageId);
    const outputs = turn.items
      .flatMap((item): RuntimeOutput[] =>
        item.kind === "output"
          ? [
              {
                mediaType: item.mediaType,
                ...(item.path === undefined ? {} : { path: item.path }),
                ...(item.attachmentId === undefined ? {} : { attachmentId: item.attachmentId }),
              },
            ]
          : [],
      )
      .slice(0, 50);

    answerDelegation(open, {
      outcome: turn.status === "completed" ? "completed" : "failed",
      threadId: turn.threadId,
      ...(reply === undefined ? {} : { reply }),
      outputs,
      ...(turn.status === "completed"
        ? {}
        : { reason: (turn.failureReason ?? turn.status).slice(0, 500) }),
    });
  }

  /**
   * The parent turn ended while a delegation still waited on the owner. Declined,
   * so nobody approves work whose answer has nowhere to go. A child already
   * running carries on in its own thread, where the owner can see it.
   */
  function closeDelegations(jobId: string): void {
    for (const open of [...delegations.values()]) {
      if (open.jobId !== jobId) {
        continue;
      }

      delegations.delete(open.delegation.delegationId);

      if (open.childTurnId === undefined && open.approvalId !== undefined) {
        declineAuthority(
          kernel,
          { correlationId: kernel.ids.nextId(), actorType: "system", actorId: "system" },
          {
            idempotencyKey: `turn-ended:${open.approvalId}`,
            requestId: open.approvalId,
            reason: "the turn ended before anyone answered",
          },
        );
      }
    }
  }

  function completeTurn(jobId: string, final: Final): void {
    const turn = getTurnByJobId(kernel.db, jobId);

    if (turn === undefined) {
      return;
    }

    const context = identityContext(turn);
    const at = nowIso();
    const outcome = runCommand<Turn>(
      kernel,
      // Whichever of result, cancel, or expiry lands first is the completion.
      { scope: "conversation.complete", key: `complete:${jobId}`, resultId: turn.id },
      (tx) => {
        if (final.sessionRef !== undefined && turn.nodeId !== undefined) {
          // One session per thread x provider x node: the next turn on this
          // thread resumes it instead of replaying the thread into a fresh process.
          tx.prepare(
            `INSERT INTO identity_sessions
               (id, thread_id, provider_id, node_id, session_ref, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (thread_id, provider_id, node_id) DO UPDATE SET
               session_ref = excluded.session_ref,
               fork_pending = 0,
               updated_at = excluded.updated_at`,
          ).run(
            kernel.ids.nextId(),
            turn.threadId,
            turn.model.providerId,
            turn.nodeId,
            final.sessionRef,
            at,
            at,
          );
        }

        tx.prepare(
          `UPDATE identity_turns SET status = ?, failure_reason = ?, completed_at = ? WHERE id = ?`,
        ).run(final.status, final.failureReason ?? null, at, turn.id);

        const updated = getTurn(tx, turn.id);

        if (updated === undefined) {
          throw new Error(`Turn ${turn.id} vanished mid-transaction`);
        }

        return ok({
          value: updated,
          events: [
            draft(
              context,
              "identity",
              turn.threadId,
              "identity.turn_completed.v1",
              {
                turnId: turn.id,
                jobId,
                threadId: turn.threadId,
                status: final.status,
                model: turn.model,
                ...(final.stoppedReason === undefined
                  ? {}
                  : { stoppedReason: final.stoppedReason }),
                ...(final.failureReason === undefined
                  ? {}
                  : { failureReason: final.failureReason }),
              },
              at,
            ),
          ],
        });
      },
    );

    if (!outcome.ok && outcome.conflict.kind !== "idempotent_replay") {
      kernel.logger.log("warn", "could not complete a turn", {
        jobId,
        conflict: outcome.conflict.kind,
      });
    }

    closePendingAsks(kernel, pendingAsks, jobId);
    closeDelegations(jobId);
    threadByJob.delete(jobId);
  }

  function onEvents(events: readonly OrchestrationEvent[]): void {
    for (const event of events) {
      // Payloads below are this process's own, written by typed code in
      // nodes/jobs.ts and authority/service.ts; read with the same shape.
      switch (event.type) {
        case "node.job_result.v1": {
          const payload = event.payload as {
            outcome: "succeeded" | "failed";
            capability: string;
            evidence?: unknown;
            failureReason?: string;
          };

          if (payload.capability === "runtime.warm") {
            settleWarm(
              event.streamId,
              payload.outcome === "succeeded" &&
                (payload.evidence as { warmed?: boolean } | undefined)?.warmed === true,
            );
            break;
          }

          if (payload.capability !== "runtime.turn") {
            break;
          }

          {
            // A turn on a local model leaves it loaded for the same ten minutes.
            const finished = getTurnByJobId(kernel.db, event.streamId);

            if (
              payload.outcome === "succeeded" &&
              finished !== undefined &&
              (finished.model.providerId === "hermes" || finished.model.providerId === "local")
            ) {
              awake.set(finished.threadId, kernel.clock.now() + AWAKE_MS);
            }
          }

          completeTurn(
            event.streamId,
            payload.outcome === "succeeded"
              ? finalFromEvidence(payload.evidence)
              : { status: "failed", failureReason: payload.failureReason ?? "job_failed" },
          );
          break;
        }
        case "node.job_status_changed.v1": {
          const { to } = event.payload as { to: string };

          if (warmJobs.has(event.streamId)) {
            if (to === "cancelled" || to === "expired" || to === "failed") {
              settleWarm(event.streamId, false);
            }

            break;
          }

          if (to === "cancelled") {
            completeTurn(event.streamId, { status: "cancelled" });
          } else if (to === "expired") {
            completeTurn(event.streamId, { status: "failed", failureReason: "lease_expired" });
          }

          break;
        }
        case "authority.confirmed.v1":
        case "authority.declined.v1": {
          answerFromEvent(dispatcher, pendingAsks, event);

          const open = [...delegations.values()].find(
            (candidate) =>
              candidate.approvalId === event.streamId && candidate.childTurnId === undefined,
          );

          if (open !== undefined) {
            if (event.type === "authority.confirmed.v1") {
              startDelegation(open);
            } else {
              refuseDelegation(
                open,
                `declined: ${(event.payload as { reason?: string }).reason ?? "by the owner"}`,
              );
            }
          }

          break;
        }
        case "identity.turn_completed.v1": {
          const { turnId } = event.payload as { turnId: string };
          const open = [...delegations.values()].find(
            (candidate) => candidate.childTurnId === turnId,
          );
          const turn = open === undefined ? undefined : getTurn(kernel.db, turnId);

          if (open !== undefined && turn !== undefined) {
            finishDelegation(open, turn);
          }

          break;
        }
        default:
          break;
      }
    }
  }

  const unsubscribeFrames = deps.runtimeFrames.subscribe({
    onStreamItem,
    onDelta,
    onAsk,
    onDelegate,
  });
  const unsubscribeEvents = kernel.broker.subscribe(onEvents);

  return {
    sendMessage,
    warm,
    awakeUntil,
    adoptSession,
    createThread,
    cancelTurn,
    onStreamItem,
    onDelta,
    onAsk,
    onDelegate,
    close() {
      unsubscribeFrames();
      unsubscribeEvents();
      pendingAsks.clear();
      delegations.clear();
      threadByJob.clear();
    },
  };
}

/** What the owner's words can name, so a model proposing a task never invents an id. */
function runtimeTargets(
  db: NoctisDatabase,
  isConnected: (nodeId: string) => boolean,
  currentNodeId: string,
  now: number,
): RuntimeTargets {
  return {
    pcs: listNodes(db, 32)
      .filter((node) => node.status !== "revoked" && node.status !== "pending")
      .map((node) => ({
        nodeId: node.id,
        hostId: node.hostId,
        current: node.id === currentNodeId,
        online: isConnected(node.id),
      })),
    folders: listRuntimeRoots(db, isConnected, now)
      .slice(0, 128)
      .map(({ grantId, nodeId, path }) => ({ grantId, nodeId, path })),
    tasks: listTasks(db, 200).map((task) => ({
      taskId: task.id,
      name: task.name,
      paused: task.paused,
    })),
  };
}
