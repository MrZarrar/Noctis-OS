import type {
  ApprovalRecord,
  ConversationThread,
  ConversationalIdentityId,
  ModelRef,
  OrchestrationEvent,
  RuntimeItem,
  ServerFrame,
} from "@noctis/contracts";
import {
  ApprovalRecordSchema,
  AttachmentRecordSchema,
  ConversationThreadSchema,
  ConversationalIdentityIdSchema,
  ModelRefSchema,
  RuntimeItemSchema,
} from "@noctis/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";

import type { CoreTransport, Subscription } from "../transport/CoreTransport.js";

/**
 * The core's answers, parsed rather than asserted — the same rule every page
 * follows: a 200 says a body arrived, not that it came from the core. These
 * mirror `Turn` and `Message` in apps/core/src/conversation/service.ts.
 */
export const MessageSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    role: z.enum(["user", "identity", "system"]),
    body: z.string(),
    createdAt: z.string().min(1),
    protocolId: z.string().min(1).optional(),
  })
  .strict();

export const TurnStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);

export const TurnSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    identityId: ConversationalIdentityIdSchema,
    objectiveId: z.string().min(1).optional(),
    userMessageId: z.string().min(1),
    jobId: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    model: ModelRefSchema,
    status: TurnStatusSchema,
    items: z.array(RuntimeItemSchema),
    replyMessageId: z.string().min(1).optional(),
    failureReason: z.string().min(1).optional(),
    startedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),
  })
  .strict();

export type Message = z.infer<typeof MessageSchema>;
export type Turn = z.infer<typeof TurnSchema>;

const MessagesSchema = z.object({ messages: z.array(MessageSchema) }).strict();
const TurnsSchema = z.object({ turns: z.array(TurnSchema) }).strict();
const ApprovalsSchema = z.object({ approvals: z.array(ApprovalRecordSchema) }).strict();
const LedgerHeadSchema = z
  .object({ events: z.array(z.unknown()), latestSequence: z.int().nonnegative() })
  .strict();
const ModelsSchema = z
  .object({
    catalogue: z.array(ModelRefSchema),
    defaults: z
      .object({ vesper: ModelRefSchema.optional(), jester: ModelRefSchema.optional() })
      .strict(),
  })
  .strict();

/* Event payloads are this repo's own (conversation/service.ts, authority/service.ts). */
const MessageAddedPayloadSchema = z.object({ itemId: z.string().min(1).optional() });
const TurnItemPayloadSchema = z.object({ turnId: z.string().min(1), item: RuntimeItemSchema });
const DecisionPayloadSchema = z.object({
  requestId: z.string().min(1),
  outcome: z.string().min(1),
  nodeJobId: z.string().min(1).optional(),
});

const PENDING_OUTCOMES: ReadonlySet<string> = new Set([
  "require_confirmation",
  "require_typed_confirmation",
]);

let keySequence = 0;

function nextKey(scope: string): string {
  keySequence += 1;

  return `web-${scope}-${String(keySequence)}-${String(Date.now())}`;
}

export interface ConversationSnapshot {
  thread: ConversationThread | undefined;
  messages: readonly Message[];
  turns: readonly Turn[];
  /** Streamed text by item id, until the committed message replaces it. */
  streaming: ReadonlyMap<string, string>;
  pendingApprovals: readonly ApprovalRecord[];
  models: readonly ModelRef[];
  defaultModel: ModelRef | undefined;
  /** Whether this transport can upload a file at all. See `CoreTransport.upload`. */
  canAttach: boolean;
  error: string | undefined;
}

export interface ConversationActions {
  /**
   * `files` are uploaded first and sent as `attachmentIds`. A failed upload
   * refuses the whole send: a prompt that names a screenshot and arrives
   * without it gets an answer about a file the model never saw.
   */
  send: (text: string, model?: ModelRef, files?: readonly File[]) => Promise<void>;
  cancel: (jobId: string) => Promise<void>;
  confirm: (requestId: string, typedConfirmation?: string) => Promise<void>;
  decline: (requestId: string, reason?: string) => Promise<void>;
}

export type ConversationState = ConversationSnapshot & ConversationActions;

export interface ConversationStore extends ConversationActions {
  getState: () => ConversationSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Reads the thread and opens the live subscription. Idempotent across a close. */
  start: () => void;
  close: () => void;
}

const EMPTY: ConversationSnapshot = {
  thread: undefined,
  messages: [],
  turns: [],
  streaming: new Map(),
  pendingApprovals: [],
  models: [],
  defaultModel: undefined,
  canAttach: false,
  error: undefined,
};

function isPendingFor(approval: ApprovalRecord, jobIds: ReadonlySet<string>): boolean {
  return (
    approval.nodeJobId !== undefined &&
    jobIds.has(approval.nodeJobId) &&
    PENDING_OUTCOMES.has(approval.outcome) &&
    approval.confirmedAt === undefined &&
    approval.declinedAt === undefined
  );
}

/**
 * One identity's conversation on one thread: the free-chat thread when
 * `objectiveId` is absent, the Objective's thread when it is set (0.12).
 *
 * Framework-free on purpose. `useConversation` is a thin `useSyncExternalStore`
 * over it, so the whole behaviour — deltas, items, approvals, refetches — is
 * testable with a scripted transport and no DOM.
 *
 * Deltas are the one thing here that is not re-read from the core: they are
 * ephemeral (ADR-0022) and exist only until the `agent_message` they were
 * streaming commits, at which point the message read replaces them.
 */
export function createConversation(
  transport: CoreTransport,
  identityId: ConversationalIdentityId,
  objectiveId: string | undefined,
): ConversationStore {
  let state: ConversationSnapshot = { ...EMPTY, canAttach: transport.upload !== undefined };
  let generation = 0;
  let subscription: Subscription | undefined;
  const listeners = new Set<() => void>();

  function set(patch: Partial<ConversationSnapshot>): void {
    state = { ...state, ...patch };

    for (const listener of listeners) {
      listener();
    }
  }

  function fail(message: string): void {
    set({ error: message });
  }

  function jobIds(): ReadonlySet<string> {
    return new Set(state.turns.flatMap((turn) => (turn.jobId === undefined ? [] : [turn.jobId])));
  }

  function threadPath(): string {
    const query = new URLSearchParams({ identityId });

    if (objectiveId !== undefined) {
      query.set("objectiveId", objectiveId);
    }

    return `/threads?${query.toString()}`;
  }

  async function read<T>(
    path: string,
    schema: z.ZodType<T>,
    label: string,
  ): Promise<T | undefined> {
    const response = await transport.request("GET", path);

    if (response.status !== 200) {
      fail(`Could not read ${label} (${String(response.status)})`);
      return undefined;
    }

    const parsed = schema.safeParse(response.body);

    if (!parsed.success) {
      fail(`The core returned ${label} that does not match its contract`);
      return undefined;
    }

    return parsed.data;
  }

  async function loadMessages(threadId: string): Promise<void> {
    const page = await read(`/threads/${threadId}/messages`, MessagesSchema, "messages");

    if (page !== undefined) {
      set({ messages: page.messages });
    }
  }

  async function loadTurns(threadId: string): Promise<void> {
    const page = await read(`/threads/${threadId}/turns`, TurnsSchema, "turns");

    if (page !== undefined) {
      set({ turns: page.turns });
    }
  }

  /** Asks left unanswered before this page loaded. */
  async function loadPendingApprovals(): Promise<void> {
    const page = await read("/approvals", ApprovalsSchema, "approvals");

    if (page !== undefined) {
      const known = jobIds();

      set({ pendingApprovals: page.approvals.filter((approval) => isPendingFor(approval, known)) });
    }
  }

  async function loadModels(): Promise<void> {
    const models = await read("/models", ModelsSchema, "the model catalogue");

    if (models !== undefined) {
      set({ models: models.catalogue, defaultModel: models.defaults[identityId] });
    }
  }

  /** The thread and everything on it. A 404 is "not started", not a failure. */
  async function loadThread(): Promise<void> {
    const response = await transport.request("GET", threadPath());

    if (response.status === 404) {
      set({ thread: undefined, messages: [], turns: [], pendingApprovals: [] });
      return;
    }

    if (response.status !== 200) {
      fail(`Could not read the thread (${String(response.status)})`);
      return;
    }

    const thread = ConversationThreadSchema.safeParse(response.body);

    if (!thread.success) {
      fail("The core returned a thread that does not match its contract");
      return;
    }

    set({ thread: thread.data });
    await Promise.all([loadMessages(thread.data.id), loadTurns(thread.data.id)]);
    await loadPendingApprovals();
  }

  function clearStreaming(itemId: string): void {
    if (!state.streaming.has(itemId)) {
      return;
    }

    const streaming = new Map(state.streaming);

    streaming.delete(itemId);
    set({ streaming });
  }

  function upsertTurn(turn: Turn): void {
    set({
      turns: state.turns.some((existing) => existing.id === turn.id)
        ? state.turns.map((existing) => (existing.id === turn.id ? turn : existing))
        : [...state.turns, turn],
    });
  }

  function applyItem(turnId: string, item: RuntimeItem): void {
    const turn = state.turns.find((candidate) => candidate.id === turnId);

    if (turn === undefined) {
      return;
    }

    const items = turn.items.some((existing) => existing.itemId === item.itemId)
      ? turn.items.map((existing) => (existing.itemId === item.itemId ? item : existing))
      : [...turn.items, item];
    const status = turn.status === "queued" ? "running" : turn.status;

    upsertTurn({ ...turn, items, status });

    if (item.kind === "agent_message" && item.status === "completed") {
      clearStreaming(item.itemId);
    }
  }

  async function onDecision(event: OrchestrationEvent): Promise<void> {
    const payload = DecisionPayloadSchema.safeParse(event.payload);

    if (
      !payload.success ||
      payload.data.nodeJobId === undefined ||
      !PENDING_OUTCOMES.has(payload.data.outcome)
    ) {
      return;
    }

    if (!jobIds().has(payload.data.nodeJobId)) {
      // The ask may have beaten our read of the turn that started the job.
      if (state.thread === undefined) {
        return;
      }

      await loadTurns(state.thread.id);

      if (!jobIds().has(payload.data.nodeJobId)) {
        return;
      }
    }

    const approval = await read(
      `/approvals/${payload.data.requestId}`,
      ApprovalRecordSchema,
      "an approval",
    );

    if (
      approval !== undefined &&
      isPendingFor(approval, jobIds()) &&
      !state.pendingApprovals.some((existing) => existing.id === approval.id)
    ) {
      set({ pendingApprovals: [...state.pendingApprovals, approval] });
    }
  }

  function onEvent(event: OrchestrationEvent): void {
    const threadId = state.thread?.id;

    switch (event.type) {
      case "identity.message_added.v1": {
        if (event.streamId !== threadId) {
          return;
        }

        const payload = MessageAddedPayloadSchema.safeParse(event.payload);

        if (payload.success && payload.data.itemId !== undefined) {
          clearStreaming(payload.data.itemId);
        }

        void loadMessages(event.streamId);
        return;
      }
      case "identity.turn_item.v1": {
        const payload = TurnItemPayloadSchema.safeParse(event.payload);

        if (event.streamId === threadId && payload.success) {
          applyItem(payload.data.turnId, payload.data.item);
        }

        return;
      }
      case "identity.turn_started.v1":
      case "identity.turn_completed.v1":
        if (event.streamId === threadId) {
          void loadTurns(event.streamId);
        }

        return;
      case "authority.decision_recorded.v1":
        void onDecision(event);
        return;
      case "authority.confirmed.v1":
      case "authority.declined.v1":
        if (state.pendingApprovals.some((approval) => approval.id === event.streamId)) {
          set({
            pendingApprovals: state.pendingApprovals.filter(
              (approval) => approval.id !== event.streamId,
            ),
          });
        }

        return;
      default:
        return;
    }
  }

  function onFrame(frame: ServerFrame): void {
    if (frame.kind !== "runtime_delta") {
      return;
    }

    // Either test says "this thread": the send has returned the turn (so the
    // job is known) before the node can stream anything for it.
    if (frame.threadId !== state.thread?.id && !jobIds().has(frame.jobId)) {
      return;
    }

    const streaming = new Map(state.streaming);

    streaming.set(frame.itemId, (streaming.get(frame.itemId) ?? "") + frame.text);
    set({ streaming });
  }

  async function open(current: number): Promise<void> {
    const head = await read("/events?after=0&limit=1", LedgerHeadSchema, "the event ledger");

    if (current !== generation) {
      return;
    }

    // Subscribe before the reads, so anything committed between the two is
    // delivered as an event and refetched rather than missed.
    const opened = await transport.subscribe({
      afterSequence: head?.latestSequence ?? 0,
      onEvent,
      onFrame,
      onError: (failure) => {
        fail(failure instanceof Error ? failure.message : "the live subscription failed");
      },
    });

    if (current !== generation) {
      opened.close();
      return;
    }

    subscription = opened;
    await Promise.all([loadModels(), loadThread()]);
  }

  /**
   * Uploads every attached file, or refuses the send.
   *
   * Sequential rather than parallel: eight files at 10 MB each over a phone's
   * uplink is not something to start all at once, and the first failure should
   * stop the rest rather than race them.
   */
  async function uploadAll(files: readonly File[]): Promise<string[] | undefined> {
    if (files.length === 0) {
      return [];
    }

    if (transport.upload === undefined) {
      fail("This client cannot attach files");
      return undefined;
    }

    const ids: string[] = [];

    for (const file of files) {
      const response = await transport.upload(file);
      const parsed = AttachmentRecordSchema.safeParse(response.body);

      if (response.status !== 200 || !parsed.success) {
        const detail = (response.body as { error?: { message?: string } } | undefined)?.error
          ?.message;

        fail(
          `${file.name} could not be attached (${String(response.status)})${detail === undefined ? "" : `: ${detail}`}`,
        );
        return undefined;
      }

      ids.push(parsed.data.id);
    }

    set({ error: undefined });

    return ids;
  }

  async function command(name: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await transport.request("POST", `/commands/${name}`, {
      idempotencyKey: nextKey(name),
      ...body,
    });

    if (response.status !== 200) {
      const detail = (response.body as { error?: { message?: string } } | undefined)?.error
        ?.message;

      fail(
        `${name} was refused (${String(response.status)})${detail === undefined ? "" : `: ${detail}`}`,
      );
      return undefined;
    }

    set({ error: undefined });

    return response.body;
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      generation += 1;
      void open(generation).catch((failure: unknown) => {
        fail(failure instanceof Error ? failure.message : "could not open the conversation");
      });
    },
    close: () => {
      generation += 1;
      subscription?.close();
      subscription = undefined;
    },
    send: async (text, model, files) => {
      const attachmentIds = await uploadAll(files ?? []);

      if (attachmentIds === undefined) {
        return;
      }

      const body = await command("conversation.send", {
        identityId,
        text,
        ...(objectiveId === undefined ? {} : { objectiveId }),
        ...(model === undefined ? {} : { model }),
        ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
      });

      if (body === undefined) {
        return;
      }

      const turn = TurnSchema.safeParse(body);

      if (!turn.success) {
        fail("The core returned a turn that does not match its contract");
        return;
      }

      if (state.thread?.id === turn.data.threadId) {
        // Known thread: the job id is what lets the first delta through.
        upsertTurn(turn.data);
        await loadMessages(turn.data.threadId);
        return;
      }

      // First prompt on this thread: the core created it inside the send.
      await loadThread();
    },
    cancel: async (jobId) => {
      if ((await command("conversation.cancel", { jobId })) !== undefined && state.thread) {
        await loadTurns(state.thread.id);
      }
    },
    confirm: async (requestId, typedConfirmation) => {
      await command("authority.confirm", {
        requestId,
        ...(typedConfirmation === undefined ? {} : { typedConfirmation }),
      });
    },
    decline: async (requestId, reason) => {
      await command("authority.decline", {
        requestId,
        ...(reason === undefined ? {} : { reason }),
      });
    },
  };
}

const noSubscribe = (): (() => void) => () => undefined;
const emptySnapshot = (): ConversationSnapshot => EMPTY;
const noTransport = (): Promise<void> => Promise.resolve();

/**
 * One conversation, held above the pages that show it: App owns it so Presence
 * (which sends) and Chat (which shows) never run two copies of the same thread.
 */
export function useConversation(
  transport: CoreTransport | undefined,
  identityId: ConversationalIdentityId,
  objectiveId: string | undefined,
): ConversationState {
  const store = useMemo(
    () =>
      transport === undefined ? undefined : createConversation(transport, identityId, objectiveId),
    [transport, identityId, objectiveId],
  );

  useEffect(() => {
    if (store === undefined) {
      return;
    }

    store.start();

    return () => {
      store.close();
    };
  }, [store]);

  const snapshot = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.getState ?? emptySnapshot,
  );

  return {
    ...snapshot,
    send: store?.send ?? noTransport,
    cancel: store?.cancel ?? noTransport,
    confirm: store?.confirm ?? noTransport,
    decline: store?.decline ?? noTransport,
  };
}
