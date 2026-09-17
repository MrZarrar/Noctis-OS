import type { OrchestrationEvent, ServerFrame } from "@noctis/contracts";
import { describe, expect, it, vi } from "vitest";

import type { CoreResponse, CoreTransport, SubscribeOptions } from "../transport/CoreTransport.js";
import { createConversation } from "./useConversation.js";

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
});
