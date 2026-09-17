import type {
  CancelConversationTurnCommand,
  ConversationalIdentityId,
  EventName,
  ModelRef,
  OrchestrationEvent,
  RuntimeAsk,
  RuntimeDelta,
  RuntimeItem,
  RuntimeTurnPayload,
  SendConversationMessageCommand,
  StreamType,
} from "@noctis/contracts";
import {
  ConversationalIdentityIdSchema,
  ENVELOPE_VERSION,
  ModelRefSchema,
  RuntimeItemSchema,
  RuntimeTurnEvidenceSchema,
} from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { chooseProvider, conflict, ok } from "@noctis/domain";

import { attachmentRefs, linkTurnAttachments } from "../attachments/service.js";
import type { NoctisDatabase } from "../db/connection.js";
import type { EventDraft } from "../db/events.js";
import type { LiveBroker } from "../events/live.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import type { Dispatcher } from "../nodes/dispatch.js";
import type { NodeJobRecord } from "../nodes/jobs.js";
import { cancelJob, enqueueJobInTransaction } from "../nodes/jobs.js";
import { listRuntimeCandidates } from "../nodes/registry.js";
import type { RuntimeFrameHub } from "../nodes/runtime-frames.js";
import { getObjective } from "../objectives/service.js";
import type { PendingAsk } from "./asks.js";
import { answerFromEvent, handleAsk } from "./asks.js";
import { defaultModelFor } from "./models.js";
import { applyProposal } from "./proposals.js";
import { threadFor } from "./threads.js";

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
): string | undefined {
  const row = db
    .prepare(
      `SELECT node_id, session_ref FROM identity_sessions
        WHERE thread_id = ? AND provider_id = ? AND node_id = ?`,
    )
    .get(threadId, providerId, nodeId) as SessionRow | undefined;

  return row?.session_ref;
}

export interface ConversationServiceDeps {
  kernel: Kernel;
  dispatcher: Dispatcher;
  live: LiveBroker;
  runtimeFrames: RuntimeFrameHub;
}

export interface ConversationService {
  sendMessage(context: CommandContext, command: SendConversationMessageCommand): Result<Turn>;
  cancelTurn(context: CommandContext, command: CancelConversationTurnCommand): Result<Turn>;
  onStreamItem(nodeId: string, jobId: string, sequence: number, item: RuntimeItem): void;
  onDelta(nodeId: string, jobId: string, delta: RuntimeDelta): void;
  onAsk(nodeId: string, jobId: string, ask: RuntimeAsk): void;
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

  function nowIso(): string {
    return new Date(kernel.clock.now()).toISOString();
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
        const { identityId } = command;
        const model = command.model ?? defaultModelFor(tx, identityId);

        if (model === undefined) {
          return conflict({ kind: "unavailable", entity: "model", reason: "no_default_model" });
        }

        const objective =
          command.objectiveId === undefined ? undefined : getObjective(tx, command.objectiveId);

        if (command.objectiveId !== undefined && objective === undefined) {
          return conflict({ kind: "not_found", entity: "objective", id: command.objectiveId });
        }

        // Carried to the node so it can choose auto-allow behaviour honestly;
        // the evaluator still makes the actual decision on each ask.
        const objectiveActive = objective?.status === "active";

        // Resolved before anything is written. An id that names no attachment
        // is a client bug, and sending the turn without the file the prompt
        // refers to would produce an answer about a file the model never saw.
        const attachmentIds = command.attachmentIds ?? [];
        const attachments = attachmentRefs(tx, attachmentIds);

        if (attachments.length !== attachmentIds.length) {
          const missing = attachmentIds.find(
            (id) => !attachments.some((attachment) => attachment.id === id),
          );

          return conflict({ kind: "not_found", entity: "attachment", id: missing ?? "unknown" });
        }

        const thread = threadFor(tx, kernel, identityId, command.objectiveId, at);
        const userMessageId = insertMessage(tx, kernel, thread.id, "user", command.text, at);

        const requiredRoots = command.rootGrantId === undefined ? [] : [command.rootGrantId];
        const candidates = listRuntimeCandidates(
          tx,
          (nodeId) => dispatcher.isConnected(nodeId),
          requiredRoots,
          now,
        );
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

        let selected = decision.selected;
        let reasonCodes = decision.reasonCodes;
        let primaryRootGrantId = command.rootGrantId;

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
          const sessionRef = sessionOn(tx, thread.id, model.providerId, selected.nodeId);
          const payload: RuntimeTurnPayload = {
            threadId: thread.id,
            identityId,
            model: selected.model,
            userMessageId,
            prompt: command.text,
            primaryRootGrantId,
            ...(sessionRef === undefined ? {} : { sessionRef }),
            ...(command.objectiveId === undefined ? {} : { objectiveId: command.objectiveId }),
            objectiveActive,
            ...(attachments.length === 0 ? {} : { attachments }),
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
                ...(command.objectiveId === undefined ? {} : { objectiveId: command.objectiveId }),
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
      },
    );

    if (outcome.ok && outcome.value.jobId !== undefined) {
      threadByJob.set(outcome.value.jobId, outcome.value.threadId);
      // Post-commit, like http.ts does for node.job_enqueue: a job frame must
      // never describe a row a rollback erased.
      dispatcher.pass();
    }

    return outcome;
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
      applyProposal(
        kernel,
        context,
        recorded.value,
        item.proposal,
        `proposal:${jobId}:${String(sequence)}`,
      );
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

          if (payload.capability !== "runtime.turn") {
            break;
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

          if (to === "cancelled") {
            completeTurn(event.streamId, { status: "cancelled" });
          } else if (to === "expired") {
            completeTurn(event.streamId, { status: "failed", failureReason: "lease_expired" });
          }

          break;
        }
        case "authority.confirmed.v1":
        case "authority.declined.v1":
          answerFromEvent(dispatcher, pendingAsks, event);
          break;
        default:
          break;
      }
    }
  }

  const unsubscribeFrames = deps.runtimeFrames.subscribe({ onStreamItem, onDelta, onAsk });
  const unsubscribeEvents = kernel.broker.subscribe(onEvents);

  return {
    sendMessage,
    cancelTurn,
    onStreamItem,
    onDelta,
    onAsk,
    close() {
      unsubscribeFrames();
      unsubscribeEvents();
      pendingAsks.clear();
      threadByJob.clear();
    },
  };
}
