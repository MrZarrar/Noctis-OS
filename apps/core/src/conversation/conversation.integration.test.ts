import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeServerFrame, RuntimeAsk, ServerFrame } from "@noctis/contracts";
import {
  ENVELOPE_VERSION,
  NODE_ENVELOPE_VERSION,
  NodeJobAssignmentSchema,
  RuntimeTurnPayloadSchema,
} from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { CoreConfig } from "../config/server.js";
import { createLogger } from "../logging.js";
import type { RunningCore } from "../server.js";
import { startCore } from "../server.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const START = Date.parse("2026-09-01T12:00:00.000Z");
const NO_AUTOMATIC_SWEEP_MS = 3_600_000;

const MODEL = { providerId: "codex", model: "gpt-5.6-sol" };
const CODEX_PROBE = { providerId: "codex", available: true, authMode: "chatgpt", models: [MODEL] };

interface TestCore {
  core: RunningCore;
  base: string;
  socketUrl: string;
}

const started: Array<{ core: RunningCore; directory: string }> = [];
const openSockets: WebSocket[] = [];

async function startTestCore(): Promise<TestCore> {
  const directory = mkdtempSync(join(tmpdir(), "noctis-conversation-"));
  const config: CoreConfig = {
    bindAddress: "127.0.0.1",
    port: 0,
    token: TOKEN,
    databasePath: join(directory, "core.db"),
    allowedOrigins: [],
    logLevel: "error",
  };
  let now = START;
  const core = await startCore({
    config,
    clock: {
      now: () => {
        // Strictly increasing so ids and created_at never tie.
        now += 1;
        return now;
      },
    },
    logger: createLogger({ sink: () => undefined, level: "error" }),
    dispatchIntervalMs: NO_AUTOMATIC_SWEEP_MS,
  });

  started.push({ core, directory });

  return {
    core,
    base: `http://127.0.0.1:${String(core.port)}`,
    socketUrl: `ws://127.0.0.1:${String(core.port)}`,
  };
}

afterEach(async () => {
  while (openSockets.length > 0) {
    openSockets.pop()?.terminate();
  }

  while (started.length > 0) {
    const entry = started.pop();

    if (entry !== undefined) {
      await entry.core.close();
      rmSync(entry.directory, { recursive: true, force: true });
    }
  }
});

function authorized(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
}

type Body = Record<string, unknown>;

async function command(
  core: TestCore,
  name: string,
  body: unknown,
): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${core.base}/commands/${name}`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(body),
  });

  return { status: response.status, body: (await response.json()) as Body };
}

async function read(core: TestCore, path: string): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${core.base}${path}`, { headers: authorized() });

  return { status: response.status, body: (await response.json()) as Body };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function eventTypes(core: TestCore): Promise<string[]> {
  const events = await read(core, "/events?limit=500");

  return (events.body.events as Array<{ type: string }>).map((event) => event.type);
}

interface FakeNode {
  nodeId: string;
  frames: NodeServerFrame[];
  jobs: () => Array<Extract<NodeServerFrame, { kind: "job" }>>;
  answers: () => Array<Extract<NodeServerFrame, { kind: "answer" }>>;
  frame: (body: Record<string, unknown>) => void;
}

/** Pairs, grants `runtime.turn` on `directory`, connects, and says hello with Codex. */
async function connectFake(core: TestCore, directory: string): Promise<FakeNode> {
  const issued = await command(core, "node.issue_pairing_code", {
    idempotencyKey: `code-${directory}`,
    hostId: "workstation",
  });
  const pairResponse = await fetch(`${core.base}/node/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: issued.body.code,
      hostId: "workstation",
      fingerprint: "fingerprint-a",
      agentVersion: "0.0.0-test",
    }),
  });
  const paired = (await pairResponse.json()) as { nodeId: string; credential: string };

  const granted = await command(core, "node.grant_capability", {
    idempotencyKey: `grant-${paired.nodeId}`,
    nodeId: paired.nodeId,
    capability: "runtime.turn",
    constraints: {
      providers: ["codex"],
      roots: [{ grantId: "d", path: directory, mode: "write" }],
    },
  });
  expect(granted.status).toBe(200);

  const socket = new WebSocket(`${core.socketUrl}/ws/nodes`, {
    headers: { authorization: `Bearer ${paired.nodeId}.${paired.credential}` },
  });
  openSockets.push(socket);

  const frames: NodeServerFrame[] = [];
  socket.on("message", (data: Buffer) => {
    frames.push(JSON.parse(data.toString("utf8")) as NodeServerFrame);
  });
  socket.on("error", () => undefined);

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.send(
    JSON.stringify({
      kind: "hello",
      envelopeVersion: NODE_ENVELOPE_VERSION,
      agentVersion: "0.0.0-test",
      capabilities: ["runtime.turn"],
      providers: [CODEX_PROBE],
    }),
  );

  const fake: FakeNode = {
    nodeId: paired.nodeId,
    frames,
    jobs: () => frames.filter((frame) => frame.kind === "job"),
    answers: () => frames.filter((frame) => frame.kind === "answer"),
    frame: (body) =>
      socket.send(JSON.stringify({ envelopeVersion: NODE_ENVELOPE_VERSION, ...body })),
  };

  await waitFor(() => frames.some((frame) => frame.kind === "welcome"), "welcome frame");

  return fake;
}

async function openClient(core: TestCore): Promise<{ frames: ServerFrame[] }> {
  const socket = new WebSocket(`${core.socketUrl}/ws/clients`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  openSockets.push(socket);

  const frames: ServerFrame[] = [];
  socket.on("message", (data: Buffer) => {
    frames.push(JSON.parse(data.toString("utf8")) as ServerFrame);
  });
  socket.on("error", () => undefined);

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.send(
    JSON.stringify({ kind: "subscribe", envelopeVersion: ENVELOPE_VERSION, afterSequence: 0 }),
  );

  return { frames };
}

async function setDefault(core: TestCore, identityId = "vesper"): Promise<void> {
  const set = await command(core, "identity.set_default_model", {
    idempotencyKey: `default-${identityId}`,
    identityId,
    model: MODEL,
  });
  expect(set.status).toBe(200);
}

async function send(
  core: TestCore,
  key: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Body }> {
  return command(core, "conversation.send", {
    idempotencyKey: key,
    identityId: "vesper",
    text: `prompt ${key}`,
    ...extra,
  });
}

/** The latest job the fake received, with its payload parsed as a turn. */
function lastTurnJob(node: FakeNode) {
  const job = node.jobs().at(-1);

  if (job === undefined) {
    throw new Error("no job frame");
  }

  const assignment = NodeJobAssignmentSchema.parse(JSON.parse(job.assignment));

  return { assignment, payload: RuntimeTurnPayloadSchema.parse(assignment.payload) };
}

async function activeObjective(core: TestCore, suffix: string): Promise<string> {
  const created = await command(core, "objective.create", {
    idempotencyKey: `create-${suffix}`,
    title: "Ship the kernel",
    intent: "Prove the loop",
    status: "draft",
    identityId: "vesper",
    protocolIds: [],
  });
  const id = created.body.id as string;
  const activated = await command(core, "objective.change_status", {
    idempotencyKey: `activate-${suffix}`,
    objectiveId: id,
    expectedRevision: 0,
    status: "active",
  });
  expect(activated.status).toBe(200);

  return id;
}

const ASK: RuntimeAsk = {
  askId: "0199a000-0000-7000-8000-0000000000a5",
  itemId: "item-1",
  kind: "command",
  summary: "run the tests",
  operationClass: "local_reversible_edit",
  reversibility: "reversible",
  capability: "shell.exec",
  target: { type: "capability", id: "shell.exec" },
};

describe("conversation service", () => {
  it("a free-chat prompt uses the free thread; an Objective prompt uses that Objective's thread, created once", async () => {
    const core = await startTestCore();
    const objectiveId = await activeObjective(core, "threads");

    const free = await send(core, "free", { model: MODEL });
    const first = await send(core, "obj-1", { model: MODEL, objectiveId });
    const second = await send(core, "obj-2", { model: MODEL, objectiveId });

    expect(free.status).toBe(200);
    expect(first.status).toBe(200);
    expect(first.body.threadId).toBe(second.body.threadId);
    expect(first.body.threadId).not.toBe(free.body.threadId);

    const identities = await read(core, "/identities");
    const vesper = (identities.body.threads as Array<Body>).find((t) => t.identityId === "vesper");
    expect(vesper?.id).toBe(free.body.threadId);
    expect(vesper?.objectiveId).toBeUndefined();

    const byObjective = await read(core, `/threads?identityId=vesper&objectiveId=${objectiveId}`);
    expect(byObjective.status).toBe(200);
    expect(byObjective.body.id).toBe(first.body.threadId);
    expect(byObjective.body.objectiveId).toBe(objectiveId);

    const rows = core.core.kernel.db
      .prepare("SELECT COUNT(*) AS n FROM identity_threads WHERE objective_id = ?")
      .get(objectiveId) as { n: number };
    expect(rows.n).toBe(1);

    const missing = await read(core, "/threads?identityId=jester");
    expect(missing.status).toBe(404);
  });

  it("no default model and no override is refused as unavailable", async () => {
    const core = await startTestCore();
    const refused = await send(core, "no-model");

    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatchObject({
      code: "unavailable",
      details: { reason: "no_default_model" },
    });
  });

  it("a prompt with a default model becomes a job on the node that offers it", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);

    await setDefault(core);
    const sent = await send(core, "turn-1");
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: "queued", model: MODEL, nodeId: node.nodeId });

    await waitFor(() => node.jobs().length === 1, "a job frame");
    const { assignment, payload } = lastTurnJob(node);
    expect(assignment.capability).toBe("runtime.turn");
    expect(payload).toMatchObject({
      model: MODEL,
      identityId: "vesper",
      threadId: sent.body.threadId,
      prompt: "prompt turn-1",
      primaryRootGrantId: "d",
      objectiveActive: false,
    });
    expect(payload.sessionRef).toBeUndefined();

    const turns = await read(core, `/threads/${sent.body.threadId as string}/turns`);
    expect(turns.status).toBe(200);
    expect((turns.body.turns as Array<Body>)[0]).toMatchObject({
      id: sent.body.id,
      status: "queued",
    });

    const one = await read(core, `/turns/${sent.body.id as string}`);
    expect(one.status).toBe(200);
    expect(one.body.jobId).toBe(assignment.jobId);

    const decision = core.core.kernel.db
      .prepare(
        "SELECT selected_node_id, selected_model, cost_class FROM provider_decisions WHERE turn_id = ?",
      )
      .get(sent.body.id as string) as Body;
    expect(decision).toEqual({
      selected_node_id: node.nodeId,
      selected_model: MODEL.model,
      cost_class: "subscription",
    });

    const types = await eventTypes(core);
    expect(types).toContain("identity.turn_started.v1");
    expect(types).toContain("provider.decision_recorded.v1");
    expect(types).toContain("identity.message_added.v1");

    rmSync(directory, { recursive: true, force: true });
  });

  it("a delta reaches the client socket as runtime_delta and writes no event", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);
    const client = await openClient(core);

    await setDefault(core);
    const sent = await send(core, "turn-delta");
    await waitFor(() => node.jobs().length === 1, "a job frame");
    const { assignment } = lastTurnJob(node);
    const before = (await eventTypes(core)).length;

    node.frame({ kind: "delta", jobId: assignment.jobId, delta: { itemId: "m1", text: "hel" } });

    await waitFor(() => client.frames.some((f) => f.kind === "runtime_delta"), "a delta frame");
    expect(client.frames.find((f) => f.kind === "runtime_delta")).toEqual({
      kind: "runtime_delta",
      envelopeVersion: ENVELOPE_VERSION,
      threadId: sent.body.threadId,
      jobId: assignment.jobId,
      itemId: "m1",
      text: "hel",
    });

    // Exactly one more event — leased -> running — and it is not a delta.
    const after = await eventTypes(core);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toBe("node.job_status_changed.v1");

    rmSync(directory, { recursive: true, force: true });
  });

  it("a completed agent_message becomes an identity message and a turn_item event", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);

    await setDefault(core);
    const sent = await send(core, "turn-item");
    await waitFor(() => node.jobs().length === 1, "a job frame");
    const { assignment } = lastTurnJob(node);

    node.frame({
      kind: "stream",
      jobId: assignment.jobId,
      sequence: 0,
      item: { itemId: "m1", kind: "agent_message", status: "completed", text: "Hello back" },
    });

    let messages: Array<Body> = [];
    await waitFor(() => {
      void read(core, `/threads/${sent.body.threadId as string}/messages`).then((response) => {
        messages = response.body.messages as Array<Body>;
      });
      return messages.length === 2;
    }, "the identity reply");

    expect(messages[0]).toMatchObject({ role: "user", body: "prompt turn-item" });
    expect(messages[1]).toMatchObject({ role: "identity", body: "Hello back" });

    const turn = await read(core, `/turns/${sent.body.id as string}`);
    expect(turn.body).toMatchObject({ status: "running", replyMessageId: messages[1]?.id });
    expect(turn.body.items).toEqual([
      { itemId: "m1", kind: "agent_message", status: "completed", text: "Hello back" },
    ]);

    const types = await eventTypes(core);
    expect(types).toContain("identity.turn_item.v1");
    expect(types.filter((type) => type === "identity.message_added.v1")).toHaveLength(2);

    rmSync(directory, { recursive: true, force: true });
  });

  it("an ask under an active Objective is allowed automatically; a free-chat ask waits for the human", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);
    const objectiveId = await activeObjective(core, "asks");

    await setDefault(core);

    // Under the active Objective: allowed and audited, no human involved.
    await send(core, "turn-obj", { objectiveId });
    await waitFor(() => node.jobs().length === 1, "the Objective turn");
    const objectiveJob = lastTurnJob(node).assignment.jobId;
    expect(lastTurnJob(node).payload.objectiveActive).toBe(true);

    node.frame({ kind: "ask", jobId: objectiveJob, ask: ASK });
    await waitFor(() => node.answers().length === 1, "an automatic allow");
    expect(node.answers()[0]?.answer).toMatchObject({ askId: ASK.askId, decision: "allow" });

    const approvals = await read(core, "/approvals");
    const auto = (approvals.body.approvals as Array<Body>).find((a) => a.askId === ASK.askId);
    expect(auto).toMatchObject({ outcome: "allow", nodeJobId: objectiveJob });

    // Free chat: the same ask is a question for the human.
    await send(core, "turn-free");
    await waitFor(() => node.jobs().length === 2, "the free-chat turn");
    const freeJob = lastTurnJob(node).assignment.jobId;
    const askB = { ...ASK, askId: "0199a000-0000-7000-8000-0000000000b5" };
    const askC = { ...ASK, askId: "0199a000-0000-7000-8000-0000000000c5" };

    node.frame({ kind: "ask", jobId: freeJob, ask: askB });
    node.frame({ kind: "ask", jobId: freeJob, ask: askC });

    let pending: Array<Body> = [];
    await waitFor(() => {
      void read(core, "/approvals").then((response) => {
        pending = (response.body.approvals as Array<Body>).filter(
          (a) => a.askId === askB.askId || a.askId === askC.askId,
        );
      });
      return pending.length === 2;
    }, "two pending approvals");
    expect(pending.every((a) => a.outcome === "require_confirmation")).toBe(true);
    expect(node.answers()).toHaveLength(1);

    const b = pending.find((a) => a.askId === askB.askId) as Body;
    const c = pending.find((a) => a.askId === askC.askId) as Body;

    const confirmed = await command(core, "authority.confirm", {
      idempotencyKey: "confirm-b",
      requestId: b.id,
    });
    expect(confirmed.status).toBe(200);
    await waitFor(() => node.answers().length === 2, "the confirmed allow");
    expect(node.answers()[1]?.answer).toEqual({
      askId: askB.askId,
      decision: "allow",
      approvalId: b.id,
    });

    const declined = await command(core, "authority.decline", {
      idempotencyKey: "decline-c",
      requestId: c.id,
      reason: "not today",
    });
    expect(declined.status).toBe(200);
    await waitFor(() => node.answers().length === 3, "the declined deny");
    expect(node.answers()[2]?.answer).toEqual({
      askId: askC.askId,
      decision: "deny",
      approvalId: c.id,
      reason: "not today",
    });

    rmSync(directory, { recursive: true, force: true });
  });

  it("a result completes the turn, stores the session, and the next turn resumes it on the same node", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);

    await setDefault(core);
    const first = await send(core, "turn-a");
    await waitFor(() => node.jobs().length === 1, "the first job");
    const firstJob = lastTurnJob(node).assignment.jobId;

    node.frame({
      kind: "result",
      jobId: firstJob,
      outcome: "succeeded",
      evidence: { model: MODEL, sessionRef: "sess-1", itemCount: 1, stoppedReason: "completed" },
    });

    let turn: Body = {};
    await waitFor(() => {
      void read(core, `/turns/${first.body.id as string}`).then((response) => {
        turn = response.body;
      });
      return turn.status === "completed";
    }, "the turn to complete");
    expect(turn.completedAt).toBeDefined();

    const session = core.core.kernel.db
      .prepare("SELECT node_id, session_ref FROM identity_sessions WHERE thread_id = ?")
      .get(first.body.threadId as string) as Body;
    expect(session).toEqual({ node_id: node.nodeId, session_ref: "sess-1" });

    const types = await eventTypes(core);
    expect(types).toContain("identity.turn_completed.v1");

    const second = await send(core, "turn-b");
    expect(second.body.threadId).toBe(first.body.threadId);
    await waitFor(() => node.jobs().length === 2, "the second job");
    const resumed = lastTurnJob(node);
    expect(resumed.payload.sessionRef).toBe("sess-1");
    expect(resumed.assignment.nodeId).toBe(node.nodeId);

    const job = await read(core, `/jobs/${resumed.assignment.jobId}`);
    expect(job.body.job).toMatchObject({ pinnedNodeId: node.nodeId });

    rmSync(directory, { recursive: true, force: true });
  });

  it("GET /models lists what connected nodes offer and each identity's default", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));

    const empty = await read(core, "/models");
    expect(empty.body).toEqual({ catalogue: [], defaults: {} });

    await connectFake(core, directory);
    await setDefault(core);

    const models = await read(core, "/models");
    expect(models.status).toBe(200);
    expect(models.body).toEqual({ catalogue: [MODEL], defaults: { vesper: MODEL } });

    rmSync(directory, { recursive: true, force: true });
  });

  it("a prompt nobody can run is an honest failed turn, not an error", async () => {
    const core = await startTestCore();

    const sent = await send(core, "nobody", { model: { providerId: "claude", model: "opus" } });

    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("failed");
    expect(sent.body.failureReason as string).toMatch(/^no_eligible_provider:/);
    expect(sent.body.jobId).toBeUndefined();

    const types = await eventTypes(core);
    expect(types).toContain("provider.decision_recorded.v1");
    expect(types).toContain("identity.turn_completed.v1");
    expect(types).not.toContain("identity.turn_started.v1");
  });
});
