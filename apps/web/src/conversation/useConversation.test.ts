import type { OrchestrationEvent, ServerFrame } from "@noctis/contracts";
import { describe, expect, it, vi } from "vitest";

import type { CoreResponse, CoreTransport, SubscribeOptions } from "../transport/CoreTransport.js";
import { createConversation, type ConversationState } from "./useConversation.js";
import { sendPanelChoice } from "../pages/ThreadPanels.js";

const THREAD_ID = "0199a000-0000-7000-8000-0000000000f1";
const OBJECTIVE_ID = "0199a000-0000-7000-8000-0000000000e1";
const TURN_ID = "0199a000-0000-7000-8000-0000000000d1";
const JOB_ID = "0199a000-0000-7000-8000-0000000000c1";
const USER_MESSAGE_ID = "0199a000-0000-7000-8000-0000000000b1";
const REPLY_MESSAGE_ID = "0199a000-0000-7000-8000-0000000000b2";
const APPROVAL_ID = "0199a000-0000-7000-8000-0000000000a1";
const AT = "2026-09-13T10:00:00.000Z";
const MODEL = { providerId: "codex", model: "fake-model", label: "Fake" } as const;

const thread = {
  id: THREAD_ID,
  identityId: "vesper",
  revision: 0,
  createdAt: AT,
  updatedAt: AT,
};

const userMessage = {
  id: USER_MESSAGE_ID,
  threadId: THREAD_ID,
  role: "user",
  body: "ASK: hello",
  createdAt: AT,
};

const reply = {
  id: REPLY_MESSAGE_ID,
  threadId: THREAD_ID,
  role: "identity",
  body: "Hello ASK: hello",
  createdAt: AT,
};

const runningTurn = {
  id: TURN_ID,
  threadId: THREAD_ID,
  identityId: "vesper",
  userMessageId: USER_MESSAGE_ID,
  jobId: JOB_ID,
  model: MODEL,
  status: "running",
  items: [],
  startedAt: AT,
};

const approval = {
  id: APPROVAL_ID,
  actorId: "vesper",
  operationClass: "local_reversible_edit",
  capability: "runtime.command",
  target: { type: "command", id: "echo hi" },
  consequenceSummary: "run echo hi",
  reversibility: "reversible",
  outcome: "require_confirmation",
  policyId: "default",
  reasonCodes: ["free_chat"],
  requestedAt: AT,
  decidedAt: AT,
  nodeJobId: JOB_ID,
  askId: "0199a000-0000-7000-8000-0000000000a5",
};

let sequence = 0;

function event(
  type: OrchestrationEvent["type"],
  streamType: OrchestrationEvent["streamType"],
  streamId: string,
  payload: unknown,
): OrchestrationEvent {
  sequence += 1;

  return {
    id: `0199a000-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`,
    sequence,
    streamType,
    streamId,
    type,
    actorType: "identity",
    actorId: "vesper",
    payloadVersion: 1,
    payload,
    correlationId: "0199a000-0000-7000-8000-0000000000fe",
    occurredAt: AT,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface Scripted {
  transport: CoreTransport;
  calls: Call[];
  /** Replaces what a GET path answers from now on. */
  answer: (path: string, response: CoreResponse) => void;
  /** The subscriber's callbacks, once `subscribe` was called. */
  live: () => SubscribeOptions;
}

/** A core answered from a table, recording every request. */
function scripted(initial: Record<string, CoreResponse>): Scripted {
  const routes = new Map(Object.entries(initial));
  const calls: Call[] = [];
  let options: SubscribeOptions | undefined;

  return {
    calls,
    answer: (path, response) => {
      routes.set(path, response);
    },
    live: () => {
      if (options === undefined) {
        throw new Error("nothing subscribed yet");
      }

      return options;
    },
    transport: {
      request: (method, path, body) => {
        calls.push({ method, path, body });

        const key = `${method} ${path}`;
        const found = routes.get(key) ?? routes.get(path);

        return Promise.resolve(
          found ?? { status: 404, body: { error: { code: "not_found", message: key } } },
        );
      },
      subscribe: (received) => {
        options = received;

        return Promise.resolve({ close: () => undefined });
      },
    },
  };
}

function core(overrides: Record<string, CoreResponse> = {}): Scripted {
  return scripted({
    "GET /events?after=0&limit=1": { status: 200, body: { events: [], latestSequence: 41 } },
    "GET /models": {
      status: 200,
      body: { catalogue: [MODEL], defaults: { vesper: MODEL } },
    },
    "GET /threads?identityId=vesper": { status: 200, body: thread },
    [`GET /threads/${THREAD_ID}/messages`]: { status: 200, body: { messages: [userMessage] } },
    [`GET /threads/${THREAD_ID}/turns`]: { status: 200, body: { turns: [runningTurn] } },
    "GET /approvals": { status: 200, body: { approvals: [] } },
    ...overrides,
  });
}

describe("createConversation", () => {
  it.each([true, false])(
    "does not duplicate a reply committed just before cancellation (in the read: %s)",
    async (committedInRead) => {
      const scripted = core({
        "POST /commands/conversation.cancel": {
          status: 200,
          body: { ...runningTurn, status: "cancelled" },
        },
      });
      const store = createConversation(scripted.transport, "vesper", undefined);
      store.start();
      await vi.waitFor(() => expect(store.getState().turns).toHaveLength(1));
      scripted.live().onFrame?.({
        kind: "runtime_delta",
        envelopeVersion: 1,
        threadId: THREAD_ID,
        jobId: JOB_ID,
        itemId: "partial",
        text: "Reply",
      });
      scripted.answer(`GET /threads/${THREAD_ID}/turns`, {
        status: 200,
        body: {
          turns: [
            {
              ...runningTurn,
              status: "cancelled",
              items: committedInRead
                ? [{ itemId: "partial", kind: "agent_message", status: "completed", text: "Reply" }]
                : [],
            },
          ],
        },
      });
      await store.cancel(JOB_ID);
      if (!committedInRead) {
        scripted
          .live()
          .onEvent(
            event("identity.message_added.v1", "identity", THREAD_ID, { itemId: "partial" }),
          );
        await vi.waitFor(() => expect(store.getState().partialReplies.size).toBe(0));
      }
      expect(store.getState().streaming.size).toBe(0);
      expect(store.getState().partialReplies.size).toBe(0);
      store.close();
    },
  );

  it("stops accepting deltas for a cancelled job while keeping the partial reply", async () => {
    const scripted = core({
      "POST /commands/conversation.cancel": {
        status: 200,
        body: { ...runningTurn, status: "cancelled" },
      },
    });
    const store = createConversation(scripted.transport, "vesper", undefined);
    store.start();
    await vi.waitFor(() => expect(store.getState().turns).toHaveLength(1));
    const delta: ServerFrame = {
      kind: "runtime_delta",
      envelopeVersion: 1,
      threadId: THREAD_ID,
      jobId: JOB_ID,
      itemId: "partial",
      text: "Kept",
    };
    scripted.live().onFrame?.(delta);
    scripted.answer(`GET /threads/${THREAD_ID}/turns`, {
      status: 200,
      body: { turns: [{ ...runningTurn, status: "cancelled" }] },
    });
    await store.cancel(JOB_ID);
    scripted.live().onFrame?.({ ...delta, text: " late" });
    expect(store.getState().turns[0]?.status).toBe("cancelled");
    expect(store.getState().streaming.size).toBe(0);
    expect(store.getState().partialReplies.get(`${JOB_ID}:partial`)).toBe("Kept");
    scripted.live().onFrame?.({ ...delta, jobId: "next-job", text: "Next" });
    expect(store.getState().streaming.get("partial")).toBe("Next");
    expect(store.getState().partialReplies.get(`${JOB_ID}:partial`)).toBe("Kept");
    expect(
      scripted.calls.find((call) => call.path === "/commands/conversation.cancel")?.body,
    ).toMatchObject({ jobId: JOB_ID });
    store.close();
  });

  it("pins a delayed default free-chat choice to its original thread after another client starts fresh", async () => {
    const scripted = core({
      "POST /commands/conversation.start_fresh": {
        status: 200,
        body: { ...thread, kind: "named" },
      },
    });
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let choiceBody: { threadId?: string } | undefined;
    let currentFreeThread = THREAD_ID;
    const messages = new Map<string, string[]>();
    const transport: CoreTransport = {
      ...scripted.transport,
      request: async (method, path, body) => {
        if (path === "/commands/conversation.send") {
          choiceBody = body as { threadId?: string };
          await held;
          const routedThread = choiceBody.threadId ?? currentFreeThread;
          messages.set(routedThread, ["Use Alpha"]);
          return {
            status: 200,
            body: { ...runningTurn, threadId: routedThread, status: "queued" },
          };
        }
        return scripted.transport.request(method, path, body);
      },
    };
    const original = createConversation(transport, "vesper", undefined);
    const otherClient = createConversation(scripted.transport, "vesper", undefined);
    original.start();
    await vi.waitFor(() => expect(original.getState().thread?.id).toBe(THREAD_ID));
    const captured = { ...original.getState(), ...original } as ConversationState;
    const pending = sendPanelChoice(captured, "Use Alpha", { threadId: THREAD_ID });
    await vi.waitFor(() => expect(choiceBody).toBeDefined());
    currentFreeThread = "0199a000-0000-7000-8000-0000000000f2";
    scripted.answer("GET /threads?identityId=vesper", {
      status: 200,
      body: { ...thread, id: currentFreeThread },
    });
    scripted.answer(`GET /threads/${currentFreeThread}/messages`, {
      status: 200,
      body: { messages: [] },
    });
    scripted.answer(`GET /threads/${currentFreeThread}/turns`, {
      status: 200,
      body: { turns: [] },
    });
    await otherClient.startFresh();
    expect(otherClient.getState().thread?.id).toBe(currentFreeThread);
    release();
    await pending;
    expect(choiceBody).toMatchObject({ threadId: THREAD_ID });
    expect(messages.get(THREAD_ID)).toEqual(["Use Alpha"]);
    expect(messages.get(currentFreeThread)).toBeUndefined();
    original.close();
    otherClient.close();
  });
  it("honors an explicit send thread even when opened on another named thread", async () => {
    const scripted = core({
      "POST /commands/conversation.send": { status: 200, body: runningTurn },
    });
    const store = createConversation(scripted.transport, "vesper", undefined, "opened-thread");
    await store.send("Use Alpha", { threadId: THREAD_ID });
    expect(
      scripted.calls.find((call) => call.path === "/commands/conversation.send")?.body,
    ).toMatchObject({ threadId: THREAD_ID });
    store.close();
  });
  it("keeps a panel's thread and model when retrying without an offline folder pin", async () => {
    const scripted = core({
      "POST /commands/conversation.send": {
        status: 409,
        body: { error: { details: { reason: "node_offline" } } },
      },
    });
    const store = createConversation(scripted.transport, "vesper", undefined);
    store.start();
    await vi.waitFor(() => expect(store.getState().thread?.id).toBe(THREAD_ID));
    await store.send("Use Alpha", {
      threadId: THREAD_ID,
      model: MODEL,
      rootGrantId: "offline-folder",
    });
    scripted.answer("POST /commands/conversation.send", { status: 200, body: runningTurn });
    await store.retryElsewhere();
    const sends = scripted.calls.filter((call) => call.path === "/commands/conversation.send");
    expect(sends).toHaveLength(2);
    expect(sends[0]?.body).toMatchObject({
      threadId: THREAD_ID,
      model: MODEL,
      rootGrantId: "offline-folder",
    });
    expect(sends[1]?.body).toMatchObject({ threadId: THREAD_ID, model: MODEL });
    expect(sends[1]?.body).not.toHaveProperty("rootGrantId");
    store.close();
  });
  it("bumps panelsRevision only for the current thread or its Objective", async () => {
    const scripted = core({
      "GET /threads?identityId=vesper": {
        status: 200,
        body: { ...thread, objectiveId: OBJECTIVE_ID },
      },
    });
    const store = createConversation(scripted.transport, "vesper", undefined);
    store.start();
    await vi.waitFor(() => expect(store.getState().thread).toBeDefined());
    const emit = (payload: unknown) =>
      scripted.live().onEvent(event("surface.intent_upserted.v1", "surface", THREAD_ID, payload));
    expect(store.getState().panelsRevision).toBe(0);
    emit({ threadId: THREAD_ID });
    expect(store.getState().panelsRevision).toBe(1);
    emit({ objectiveId: OBJECTIVE_ID });
    expect(store.getState().panelsRevision).toBe(2);
    emit({ threadId: TURN_ID });
    expect(store.getState().presencePanelsRevision).toBe(0);
    emit({ presence: true });
    expect(store.getState().panelsRevision).toBe(2);
    expect(store.getState().presencePanelsRevision).toBe(1);
    store.close();
  });

  it("reads the thread, its messages, its turns, and the model catalogue, then subscribes after the ledger's head", async () => {
    const scripted = core();
    const store = createConversation(scripted.transport, "vesper", undefined);

    store.start();

    await vi.waitFor(() => expect(store.getState().turns).toHaveLength(1));

    const state = store.getState();

    expect(state.thread?.id).toBe(THREAD_ID);
    expect(state.messages.map((message) => message.body)).toEqual(["ASK: hello"]);
    expect(state.models).toEqual([MODEL]);
    expect(state.defaultModel).toEqual(MODEL);
    expect(scripted.live().afterSequence).toBe(41);

    store.close();
  });

  it("treats a 404 thread as a conversation that has not started", async () => {
    const scripted = core({
      "GET /threads?identityId=vesper": {
        status: 404,
        body: { error: { code: "not_found", message: "thread not found" } },
      },
    });
    const store = createConversation(scripted.transport, "vesper", undefined);

    store.start();

    await vi.waitFor(() => expect(store.getState().models).toHaveLength(1));

    expect(store.getState().thread).toBeUndefined();
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().error).toBeUndefined();
    expect(scripted.calls.some((call) => call.path.includes("/messages"))).toBe(false);

    store.close();
  });

  it("streams deltas into the in-progress text and lets the committed message replace it", async () => {
    const scripted = core();
    const store = createConversation(scripted.transport, "vesper", undefined);

    store.start();
    await vi.waitFor(() => expect(store.getState().turns).toHaveLength(1));

    const delta = (text: string): ServerFrame => ({
      kind: "runtime_delta",
      envelopeVersion: 1,
      threadId: THREAD_ID,
      jobId: JOB_ID,
      itemId: "m1",
      text,
    });

    scripted.live().onFrame?.(delta("Hel"));
    expect(store.getState().streaming.get("m1")).toBe("Hel");

    scripted.live().onFrame?.(delta("lo"));
    expect(store.getState().streaming.get("m1")).toBe("Hello");
    // Still streaming: nothing committed has replaced it yet.
    expect(store.getState().messages).toHaveLength(1);

    const item = { itemId: "m1", kind: "agent_message", status: "completed", text: "Hello" };

    scripted.answer(`GET /threads/${THREAD_ID}/messages`, {
      status: 200,
      body: { messages: [userMessage, reply] },
    });
    scripted.live().onEvent(
      event("identity.turn_item.v1", "identity", THREAD_ID, {
        turnId: TURN_ID,
        jobId: JOB_ID,
        sequence: 1,
        item,
      }),
    );
    scripted.live().onEvent(
      event("identity.message_added.v1", "identity", THREAD_ID, {
        messageId: REPLY_MESSAGE_ID,
        role: "identity",
        turnId: TURN_ID,
        itemId: "m1",
      }),
    );

    await vi.waitFor(() => expect(store.getState().messages).toHaveLength(2));

    expect(store.getState().streaming.has("m1")).toBe(false);
    expect(store.getState().turns[0]?.items).toEqual([item]);

    store.close();
  });

  it("ignores a delta for a thread it is not showing", async () => {
    const scripted = core();
    const store = createConversation(scripted.transport, "vesper", undefined);

    store.start();
    await vi.waitFor(() => expect(store.getState().turns).toHaveLength(1));

    scripted.live().onFrame?.({
      kind: "runtime_delta",
      envelopeVersion: 1,
      threadId: OBJECTIVE_ID,
      jobId: OBJECTIVE_ID,
      itemId: "m1",
      text: "not mine",
    });

    expect(store.getState().streaming.size).toBe(0);

    store.close();
  });

  it("turns a runtime ask into a pending approval, and a decline removes it", async () => {
    const scripted = core({
      [`GET /approvals/${APPROVAL_ID}`]: { status: 200, body: approval },
      "POST /commands/authority.decline": { status: 200, body: approval },
    });
    const store = createConversation(scripted.transport, "vesper", undefined);

    store.start();
    await vi.waitFor(() => expect(store.getState().turns).toHaveLength(1));

    scripted.live().onEvent(
      event("authority.decision_recorded.v1", "authority", APPROVAL_ID, {
        requestId: APPROVAL_ID,
        outcome: "require_confirmation",
        nodeJobId: JOB_ID,
      }),
    );

    await vi.waitFor(() => expect(store.getState().pendingApprovals).toHaveLength(1));
    expect(store.getState().pendingApprovals[0]?.consequenceSummary).toBe("run echo hi");

    await store.decline(APPROVAL_ID, "not now");

    const declined = scripted.calls.find((call) => call.path === "/commands/authority.decline");

    expect(declined?.body).toMatchObject({ requestId: APPROVAL_ID, reason: "not now" });

    scripted.live().onEvent(
      event("authority.declined.v1", "authority", APPROVAL_ID, {
        requestId: APPROVAL_ID,
        reason: "not now",
      }),
    );

    expect(store.getState().pendingApprovals).toHaveLength(0);

    store.close();
  });

  it("does not surface an approval that belongs to somebody else's job", async () => {
    const scripted = core();
    const store = createConversation(scripted.transport, "vesper", undefined);

    store.start();
    await vi.waitFor(() => expect(store.getState().turns).toHaveLength(1));

    scripted.live().onEvent(
      event("authority.decision_recorded.v1", "authority", APPROVAL_ID, {
        requestId: APPROVAL_ID,
        outcome: "require_confirmation",
        nodeJobId: OBJECTIVE_ID,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(store.getState().pendingApprovals).toHaveLength(0);
    expect(scripted.calls.some((call) => call.path === `/approvals/${APPROVAL_ID}`)).toBe(false);

    store.close();
  });

  it("sends under the Objective with the chosen model, then reads the thread the turn created", async () => {
    const scripted = core({
      [`GET /threads?identityId=vesper&objectiveId=${OBJECTIVE_ID}`]: {
        status: 404,
        body: { error: { code: "not_found", message: "thread not found" } },
      },
      "POST /commands/conversation.send": {
        status: 200,
        body: { ...runningTurn, objectiveId: OBJECTIVE_ID, status: "queued" },
      },
    });
    const store = createConversation(scripted.transport, "vesper", OBJECTIVE_ID);

    store.start();
    await vi.waitFor(() => expect(store.getState().models).toHaveLength(1));
    expect(store.getState().thread).toBeUndefined();

    // The core creates the thread on first use; from now on it answers.
    scripted.answer(`GET /threads?identityId=vesper&objectiveId=${OBJECTIVE_ID}`, {
      status: 200,
      body: { ...thread, objectiveId: OBJECTIVE_ID },
    });

    await store.send("ASK: hello", { model: { providerId: "claude", model: "sonnet" } });

    const sent = scripted.calls.find((call) => call.path === "/commands/conversation.send");

    expect(sent?.body).toMatchObject({
      identityId: "vesper",
      text: "ASK: hello",
      objectiveId: OBJECTIVE_ID,
      model: { providerId: "claude", model: "sonnet" },
    });
    expect((sent?.body as { idempotencyKey: string }).idempotencyKey).toMatch(/^web-/);
    expect(store.getState().thread?.id).toBe(THREAD_ID);
    expect(store.getState().turns).toHaveLength(1);

    store.close();
  });

  it("reports a refused send instead of pretending the message went", async () => {
    const scripted = core({
      "POST /commands/conversation.send": {
        status: 409,
        body: { error: { code: "conflict", message: "no_default_model" } },
      },
    });
    const store = createConversation(scripted.transport, "vesper", undefined);

    store.start();
    await vi.waitFor(() => expect(store.getState().turns).toHaveLength(1));

    await store.send("hello");

    expect(store.getState().error).toContain("no_default_model");

    store.close();
  });

  it("starts free chat afresh and shows it empty until the next message", async () => {
    const scripted = core({
      "POST /commands/conversation.start_fresh": {
        status: 200,
        body: { ...thread, kind: "named" },
      },
    });
    const store = createConversation(scripted.transport, "vesper", undefined);

    store.start();
    await vi.waitFor(() => expect(store.getState().turns).toHaveLength(1));

    // The old free thread is a conversation on the list now, so free chat is not started.
    scripted.answer("GET /threads?identityId=vesper", {
      status: 404,
      body: { error: { code: "not_found", message: "thread not found" } },
    });
    await store.startFresh();

    const asked = scripted.calls.find((call) => call.path === "/commands/conversation.start_fresh");

    expect(asked?.body).toMatchObject({ identityId: "vesper" });
    expect(store.getState().thread).toBeUndefined();
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().turns).toEqual([]);

    store.close();
  });

  it("starts a new chat on arrival once the current one has loaded and is idle", async () => {
    const scripted = core({
      [`GET /threads/${THREAD_ID}/turns`]: {
        status: 200,
        body: { turns: [{ ...runningTurn, status: "completed", completedAt: AT }] },
      },
      "POST /commands/conversation.start_fresh": {
        status: 200,
        body: { ...thread, kind: "named" },
      },
    });
    const store = createConversation(scripted.transport, "vesper", undefined);
    // Presence's effect runs before App's, so it asks before the store starts.
    const arrived = store.startFreshIfIdle();

    store.start();
    await arrived;

    const paths = scripted.calls.map((call) => `${call.method} ${call.path}`);

    expect(paths.indexOf("POST /commands/conversation.start_fresh")).toBeGreaterThan(
      paths.indexOf(`GET /threads/${THREAD_ID}/turns`),
    );

    store.close();
  });

  it("never moves a chat the owner started on this visit before the old one loaded", async () => {
    const scripted = core({
      [`GET /threads/${THREAD_ID}/turns`]: {
        status: 200,
        body: { turns: [{ ...runningTurn, status: "completed", completedAt: AT }] },
      },
      "POST /commands/conversation.send": { status: 200, body: runningTurn },
      "POST /commands/conversation.start_fresh": {
        status: 200,
        body: { ...thread, kind: "named" },
      },
    });
    const store = createConversation(scripted.transport, "vesper", undefined);
    const arrived = store.startFreshIfIdle();

    await store.send("typed straight away");
    store.start();
    await arrived;

    expect(scripted.calls.some((call) => call.path.endsWith("start_fresh"))).toBe(false);

    store.close();
  });

  it("says nothing when the chat was already started over before it could be", async () => {
    const scripted = core({
      [`GET /threads/${THREAD_ID}/turns`]: { status: 200, body: { turns: [] } },
      "POST /commands/conversation.start_fresh": {
        status: 404,
        body: { error: { code: "not_found", message: "conversation not found" } },
      },
    });
    const store = createConversation(scripted.transport, "vesper", undefined);

    store.start();
    await store.startFreshIfIdle();

    expect(scripted.calls.some((call) => call.path.endsWith("start_fresh"))).toBe(true);
    expect(store.getState().error).toBeUndefined();

    store.close();
  });

  it("keeps the current chat on arrival while a reply is still running", async () => {
    const scripted = core();
    const store = createConversation(scripted.transport, "vesper", undefined);

    store.start();
    await store.startFreshIfIdle();

    expect(scripted.calls.some((call) => call.path.endsWith("start_fresh"))).toBe(false);

    store.close();
  });

  it("keeps a chat nothing was said in, rather than listing an empty conversation", async () => {
    const scripted = core({
      [`GET /threads/${THREAD_ID}/messages`]: { status: 200, body: { messages: [] } },
      [`GET /threads/${THREAD_ID}/turns`]: { status: 200, body: { turns: [] } },
    });
    const store = createConversation(scripted.transport, "vesper", undefined);

    store.start();
    await store.startFreshIfIdle();

    expect(scripted.calls.some((call) => call.path.endsWith("start_fresh"))).toBe(false);

    store.close();
  });

  it("never starts the identity's chat over from a conversation opened by id", async () => {
    const scripted = core({
      [`GET /threads/${THREAD_ID}`]: { status: 200, body: { ...thread, kind: "named" } },
      [`GET /threads/${THREAD_ID}/turns`]: { status: 200, body: { turns: [] } },
    });
    const store = createConversation(scripted.transport, "vesper", undefined, THREAD_ID);

    store.start();
    await store.startFreshIfIdle();

    expect(scripted.calls.some((call) => call.path.endsWith("start_fresh"))).toBe(false);

    store.close();
  });

  it("lists the threads agents delegated from this one, and finds a new one when it starts", async () => {
    const scripted = core();
    const store = createConversation(scripted.transport, "vesper", undefined);

    store.start();
    await vi.waitFor(() => expect(store.getState().turns).toHaveLength(1));
    expect(store.getState().children).toEqual([]);

    scripted.answer(`GET /threads/${THREAD_ID}/children`, {
      status: 200,
      body: { threads: [childThread] },
    });
    scripted.live().onEvent(
      event("identity.turn_started.v1", "identity", CHILD_ID, {
        turnId: TURN_ID,
        jobId: JOB_ID,
      }),
    );

    await vi.waitFor(() => expect(store.getState().children.map((t) => t.id)).toEqual([CHILD_ID]));
    expect(store.getState().error).toBeUndefined();

    store.close();
  });

  it("opened by thread id, it reads that thread and continues it", async () => {
    const scripted = core({
      [`GET /threads/${CHILD_ID}`]: { status: 200, body: childThread },
      [`GET /threads/${CHILD_ID}/messages`]: { status: 200, body: { messages: [] } },
      [`GET /threads/${CHILD_ID}/turns`]: { status: 200, body: { turns: [] } },
      "POST /commands/conversation.send": {
        status: 200,
        body: { ...runningTurn, threadId: CHILD_ID },
      },
    });
    const store = createConversation(scripted.transport, "vesper", OBJECTIVE_ID, CHILD_ID);

    store.start();
    await vi.waitFor(() => expect(store.getState().thread?.id).toBe(CHILD_ID));
    expect(store.getState().thread?.parentThreadId).toBe(THREAD_ID);

    await store.send("make it darker");

    const sent = scripted.calls.find((call) => call.path === "/commands/conversation.send");

    expect(sent?.body).toMatchObject({ identityId: "vesper", threadId: CHILD_ID });
    expect(sent?.body).not.toHaveProperty("objectiveId");

    store.close();
  });

  it("addresses an output's bytes only through a transport that can", () => {
    const withUrl = createConversation(
      { ...core().transport, contentUrl: (path) => `https://core.example${path}` },
      "vesper",
      undefined,
    );
    const without = createConversation(core().transport, "vesper", undefined);

    expect(withUrl.getState().outputUrl?.(CHILD_ID)).toBe(
      `https://core.example/attachments/${CHILD_ID}/content`,
    );
    expect(without.getState().outputUrl).toBeUndefined();
  });
});

const CHILD_ID = "0199a000-0000-7000-8000-0000000000f2";
const childThread = { ...thread, id: CHILD_ID, parentThreadId: THREAD_ID, parentTurnId: TURN_ID };
