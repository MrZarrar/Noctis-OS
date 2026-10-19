import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  NodeServerFrame,
  RuntimeAsk,
  RuntimeProviderId,
  UsageLimits,
} from "@noctis/contracts";
import {
  NODE_ENVELOPE_VERSION,
  NodeJobAssignmentSchema,
  NodeServerFrameSchema,
} from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { CoreConfig } from "../config/server.js";
import { runCommand } from "../kernel.js";
import { createLogger } from "../logging.js";
import type { RunningCore } from "../server.js";
import { startCore } from "../server.js";
import { enqueueJobInTransaction, LEASE_MS, MAX_ATTEMPTS } from "./jobs.js";
import { grantCapability } from "./registry.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("GET /limits", () => {
  const providers = ["claude", "codex"] as const;
  const probe = (providerId: RuntimeProviderId) => ({
    providerId,
    available: true,
    authMode: providerId === "claude" ? "claude_ai" : "chatgpt",
    models: [],
  });
  const roots = [
    { grantId: "first", path: process.cwd(), mode: "read" },
    { grantId: "second", path: process.cwd(), mode: "read" },
  ];

  it("requires owner authentication even when serving a web root, and accepts a session", async () => {
    const core = await startTestCore({ webRoot: process.cwd() });
    expect((await fetch(`${core.base}/limits`)).status).toBe(401);
    expect(
      (await fetch(`${core.base}/limits`, { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    const login = await fetch(`${core.base}/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const response = await fetch(`${core.base}/limits`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      limits: [
        { providerId: "claude", problem: "No connected PC runs Claude" },
        { providerId: "codex", problem: "No connected PC runs Codex" },
      ],
    });
  });

  it("reports unavailable providers when probes lack a matching grant or a connection", async () => {
    const core = await startTestCore();
    const ungranted = await pairFake(core);
    await grant(core, ungranted.nodeId, "runtime.turn", {
      idempotencyKey: "ungranted-provider",
      constraints: { providers: ["codex"], roots },
    });
    const node = await openFake(core, ungranted, { providers: [probe("claude")] });
    const offline = await pairFake(core, { hostId: "offline", fingerprint: "offline" });
    await grant(core, offline.nodeId, "runtime.turn", {
      idempotencyKey: "offline-provider",
      constraints: { providers: ["codex"], roots },
    });
    const disconnected = await openFake(core, offline, { providers: [probe("codex")] });
    disconnected.close();
    await waitFor(() => !core.core.dispatcher.isConnected(offline.nodeId), "node disconnected");
    expect(await read(core, "/limits")).toEqual({
      status: 200,
      body: {
        limits: [
          { providerId: "claude", problem: "No connected PC runs Claude" },
          { providerId: "codex", problem: "No connected PC runs Codex" },
        ],
      },
    });
    expect(node.jobs()).toHaveLength(0);
  });

  it("asks the first eligible node and root for both providers in parallel", async () => {
    const core = await startTestCore();
    const nodes = [];
    for (const hostId of ["first-pc", "second-pc"]) {
      const paired = await pairFake(core, { hostId, fingerprint: hostId });
      await grant(core, paired.nodeId, "runtime.turn", {
        idempotencyKey: `limits-${hostId}`,
        constraints: { providers, roots },
      });
      nodes.push({
        ...paired,
        hostId,
        node: await openFake(core, paired, { providers: providers.map(probe) }),
      });
    }
    nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    const chosen = nodes[0]!;
    const pending = read(core, "/limits");
    await waitFor(() => chosen.node.jobs().length === 2, "both usage jobs before either answers");
    const answers: Record<(typeof providers)[number], UsageLimits> = {
      claude: {
        fiveHour: { usedPercent: 19, resetsAt: "2026-10-19T18:30:00.442Z" },
        weekly: { usedPercent: 68, resetsAt: "2026-10-22T10:00:00.442Z" },
      },
      codex: { weekly: { usedPercent: 101 } },
    };
    for (const frame of chosen.node.jobs()) {
      const assignment = NodeJobAssignmentSchema.parse(JSON.parse(frame.assignment));
      const { providerId } = assignment.payload as { providerId: (typeof providers)[number] };
      expect(assignment.capability).toBe("usage.limits");
      expect(assignment.payload).toEqual({ rootGrantId: "first", providerId });
      chosen.node.result(assignment.jobId, answers[providerId]);
    }
    expect(await pending).toEqual({
      status: 200,
      body: {
        limits: providers.map((providerId) => ({
          providerId,
          hostId: chosen.hostId,
          ...answers[providerId],
        })),
      },
    });
    expect(nodes[1]!.node.jobs()).toHaveLength(0);
  });

  it.each(providers)("keeps the other provider's answer when %s fails", async (failed) => {
    const core = await startTestCore();
    const paired = await pairFake(core);
    await grant(core, paired.nodeId, "runtime.turn", {
      idempotencyKey: "limits-grant",
      constraints: { providers, roots },
    });
    const node = await openFake(core, paired, { providers: providers.map(probe) });
    const pending = read(core, "/limits");
    await waitFor(() => node.jobs().length === 2, "both usage jobs");
    for (const frame of node.jobs()) {
      const assignment = NodeJobAssignmentSchema.parse(JSON.parse(frame.assignment));
      const { providerId } = assignment.payload as { providerId: RuntimeProviderId };
      node.frame({
        kind: "result",
        jobId: assignment.jobId,
        outcome: providerId === failed ? "failed" : "succeeded",
        ...(providerId === failed
          ? { evidence: null, failureReason: "Provider usage is unavailable" }
          : { evidence: { fiveHour: { usedPercent: 7 } } }),
      });
    }
    expect(await pending).toEqual({
      status: 200,
      body: {
        limits: providers.map((providerId) =>
          providerId === failed
            ? { providerId, problem: "Provider usage is unavailable" }
            : { providerId, hostId: "workstation", fiveHour: { usedPercent: 7 } },
        ),
      },
    });
  });

  it("asks the next PC running the provider when the first cannot answer", async () => {
    const core = await startTestCore();
    const nodes = [];
    for (const hostId of ["first-pc", "second-pc"]) {
      const paired = await pairFake(core, { hostId, fingerprint: hostId });
      await grant(core, paired.nodeId, "runtime.turn", {
        idempotencyKey: `fallback-${hostId}`,
        constraints: { providers: ["claude"], roots },
      });
      nodes.push({
        ...paired,
        hostId,
        node: await openFake(core, paired, { providers: [probe("claude")] }),
      });
    }
    nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    const [first, second] = nodes as [(typeof nodes)[number], (typeof nodes)[number]];
    const pending = read(core, "/limits");

    // A node on an older build refuses a job it has no adapter for.
    await waitFor(() => first.node.jobs().length === 1, "the first PC asked");
    const refused = NodeJobAssignmentSchema.parse(JSON.parse(first.node.jobs()[0]!.assignment));
    first.node.frame({
      kind: "result",
      jobId: refused.jobId,
      outcome: "failed",
      evidence: null,
      failureReason: "no adapter for usage.limits",
    });

    await waitFor(() => second.node.jobs().length === 1, "the second PC asked");
    const answered = NodeJobAssignmentSchema.parse(JSON.parse(second.node.jobs()[0]!.assignment));
    second.node.result(answered.jobId, { weekly: { usedPercent: 70 } });

    expect((await pending).body).toEqual({
      limits: [
        { providerId: "claude", hostId: second.hostId, weekly: { usedPercent: 70 } },
        { providerId: "codex", problem: "No connected PC runs Codex" },
      ],
    });
  });
});

describe("authenticated owner presence frames", () => {
  it("requires hello, uses the socket's identity and persists only state edges", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);
    const early = await openFake(core, paired, { hello: false });
    early.frame({ kind: "owner_presence", present: true });
    await waitFor(() => early.closed() !== undefined, "presence refused before hello");
    const node = await openFake(core, paired);
    const state = () =>
      core.core.kernel.db
        .prepare("SELECT present FROM node_owner_presence WHERE node_id=?")
        .get(paired.nodeId) as { present: number } | undefined;
    expect(state()?.present ?? 0).toBe(0);
    node.frame({ kind: "owner_presence", present: true });
    await waitFor(() => state()?.present === 1, "authenticated presence");
    node.frame({ kind: "owner_presence", present: true });
    node.frame({ kind: "owner_presence", present: false });
    await waitFor(() => state()?.present === 0, "locked owner");
    const events = core.core.kernel.db
      .prepare(
        "SELECT payload_json FROM orchestration_events WHERE type='node.owner_present.v1' ORDER BY sequence",
      )
      .all();
    expect(events).toEqual([
      { payload_json: JSON.stringify({ nodeId: paired.nodeId, present: true }) },
      { payload_json: JSON.stringify({ nodeId: paired.nodeId, present: false }) },
    ]);
  });
});
const START = Date.parse("2026-09-01T12:00:00.000Z");

/** Long enough that only an explicit `dispatcher.pass()` ever runs a sweep. */
const NO_AUTOMATIC_SWEEP_MS = 3_600_000;

interface TestCore {
  core: RunningCore;
  base: string;
  socketUrl: string;
  advance: (ms: number) => void;
}

const started: Array<{ core: RunningCore; directory: string }> = [];
const openSockets: WebSocket[] = [];

async function startTestCore(overrides: Partial<CoreConfig> = {}): Promise<TestCore> {
  const directory = mkdtempSync(join(tmpdir(), "noctis-nodes-"));
  const config: CoreConfig = {
    bindAddress: "127.0.0.1",
    port: 0,
    token: TOKEN,
    databasePath: join(directory, "core.db"),
    allowedOrigins: [],
    logLevel: "error",
    sessionTtlHours: 720,
    ...overrides,
  };

  // A movable clock, so lease expiry is a fact the test states rather than waits for.
  let now = START;

  const core = await startCore({
    config,
    clock: { now: () => now },
    logger: createLogger({ sink: () => undefined, level: "error" }),
    dispatchIntervalMs: NO_AUTOMATIC_SWEEP_MS,
  });

  started.push({ core, directory });

  return {
    core,
    base: `http://127.0.0.1:${String(core.port)}`,
    socketUrl: `ws://127.0.0.1:${String(core.port)}`,
    advance: (ms) => {
      now += ms;
    },
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

function authorized(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...extra };
}

async function command(
  core: TestCore,
  name: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${core.base}/commands/${name}`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(body),
  });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function read(
  core: TestCore,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${core.base}${path}`, { headers: authorized() });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

interface PairedFake {
  nodeId: string;
  credential: string;
}

async function issueCode(core: TestCore, hostId: string, key = `code-${hostId}`): Promise<string> {
  const issued = await command(core, "node.issue_pairing_code", {
    idempotencyKey: key,
    hostId,
  });

  expect(issued.status).toBe(200);

  return issued.body.code as string;
}

async function pairFake(
  core: TestCore,
  options: { hostId?: string; fingerprint?: string; code?: string } = {},
): Promise<PairedFake> {
  const hostId = options.hostId ?? "workstation";
  const code = options.code ?? (await issueCode(core, hostId));
  const response = await fetch(`${core.base}/node/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      hostId,
      fingerprint: options.fingerprint ?? "fingerprint-a",
      agentVersion: "0.0.0-test",
    }),
  });

  expect(response.status).toBe(200);

  const paired = (await response.json()) as PairedFake;

  return paired;
}

interface FakeNode {
  frames: NodeServerFrame[];
  jobs: () => Array<{ assignment: string; signature: string }>;
  welcome: () => Extract<NodeServerFrame, { kind: "welcome" }> | undefined;
  sendRaw: (payload: string | Buffer) => void;
  /** A node frame with the envelope filled in. */
  frame: (body: Record<string, unknown>) => void;
  result: (jobId: string, evidence: unknown, outcome?: "succeeded" | "failed") => void;
  progress: (jobId: string, percent: number) => void;
  closed: () => { code: number } | undefined;
  close: () => void;
  socket: WebSocket;
}

/**
 * A node that speaks the protocol and nothing else. It never runs an adapter, so
 * every assertion here is about the core's half of the contract.
 */
async function openFake(
  core: TestCore,
  paired: PairedFake,
  options: {
    hello?: boolean;
    headers?: Record<string, string>;
    path?: string;
    providers?: unknown[];
  } = {},
): Promise<FakeNode> {
  const socket = new WebSocket(`${core.socketUrl}${options.path ?? "/ws/nodes"}`, {
    headers: options.headers ?? {
      authorization: `Bearer ${paired.nodeId}.${paired.credential}`,
    },
  });

  openSockets.push(socket);

  const frames: NodeServerFrame[] = [];
  let closed: { code: number } | undefined;

  socket.on("message", (data: Buffer) => {
    frames.push(JSON.parse(data.toString("utf8")) as NodeServerFrame);
  });
  socket.on("close", (code: number) => {
    closed = { code };
  });
  socket.on("error", () => undefined);

  const fake: FakeNode = {
    frames,
    jobs: () => frames.filter((frame) => frame.kind === "job"),
    welcome: () => frames.find((frame) => frame.kind === "welcome"),
    sendRaw: (payload) => socket.send(payload),
    frame: (body) =>
      socket.send(JSON.stringify({ envelopeVersion: NODE_ENVELOPE_VERSION, ...body })),
    result: (jobId, evidence, outcome = "succeeded") => {
      socket.send(
        JSON.stringify({
          kind: "result",
          envelopeVersion: NODE_ENVELOPE_VERSION,
          jobId,
          outcome,
          evidence,
        }),
      );
    },
    progress: (jobId, percent) => {
      socket.send(
        JSON.stringify({
          kind: "progress",
          envelopeVersion: NODE_ENVELOPE_VERSION,
          jobId,
          percent,
          note: "working",
        }),
      );
    },
    closed: () => closed,
    close: () => socket.close(),
    socket,
  };

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("close", () => {
      reject(new Error(`refused before opening (close code ${String(closed?.code ?? 0)})`));
    });
    socket.once("error", reject);
  });

  if (options.hello !== false) {
    socket.send(
      JSON.stringify({
        kind: "hello",
        envelopeVersion: NODE_ENVELOPE_VERSION,
        agentVersion: "0.0.0-test",
        capabilities: ["environment.inspect", "file.search", "verification.noop", "runtime.turn"],
        ...(options.providers === undefined ? {} : { providers: options.providers }),
      }),
    );

    await waitFor(() => fake.welcome() !== undefined, "welcome frame");
  }

  return fake;
}

async function grant(
  core: TestCore,
  nodeId: string,
  capability: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const granted = await command(core, "node.grant_capability", {
    idempotencyKey: `grant-${nodeId}-${capability}-${JSON.stringify(extra)}`,
    nodeId,
    capability,
    constraints: {},
    ...extra,
  });

  expect(granted.status).toBe(200);
}

async function enqueue(
  core: TestCore,
  capability: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const enqueued = await command(core, "node.job_enqueue", {
    idempotencyKey: `job-${capability}-${JSON.stringify(extra)}`,
    capability,
    payload: {},
    ...extra,
  });

  expect(enqueued.status).toBe(200);

  return enqueued.body;
}

async function eventTypes(core: TestCore): Promise<string[]> {
  const events = await read(core, "/events?limit=500");

  return (events.body.events as Array<{ type: string }>).map((event) => event.type);
}

function jobId(record: Record<string, unknown>): string {
  return (record.job as { id: string }).id;
}

describe("the paired node loop", () => {
  it("pairs, grants, dispatches a signed job, and records verified evidence", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "verification.noop");

    const node = await openFake(core, paired);
    const enqueued = await enqueue(core, "verification.noop");

    await waitFor(() => node.jobs().length === 1, "a job frame");

    const frame = node.jobs()[0];

    if (frame === undefined) {
      throw new Error("no job frame");
    }

    // Recomputed here with node:crypto rather than with the core's own
    // `verifyAssignment`, because verifying a signature with the function that
    // produced it proves only that the function agrees with itself: replacing
    // `signAssignment` with a constant satisfies that check and fails this one.
    // It also pins the domain separator, which is part of the wire contract.
    const welcome = node.welcome();
    expect(welcome).toBeDefined();
    expect(frame.signature).toBe(
      createHmac("sha256", welcome?.credential ?? "")
        .update(`noctis.node.assignment.v1:${frame.assignment}`)
        .digest("hex"),
    );

    const assignment = NodeJobAssignmentSchema.parse(JSON.parse(frame.assignment));
    expect(assignment).toMatchObject({
      jobId: jobId(enqueued),
      nodeId: paired.nodeId,
      capability: "verification.noop",
      attempt: 1,
    });

    node.result(assignment.jobId, { verified: true });

    await waitForAsync(async () => {
      const current = await read(core, `/jobs/${assignment.jobId}`);
      return (current.body.job as { status: string }).status === "succeeded";
    }, "the job to succeed");

    const job = await read(core, `/jobs/${assignment.jobId}`);

    expect(job.body.job).toMatchObject({ status: "succeeded", nodeId: paired.nodeId });
    expect(job.body.result).toEqual({ verified: true });

    expect(await eventTypes(core)).toEqual([
      "node.paired.v1",
      "node.capability_granted.v1",
      "node.connected.v1",
      "node.job_queued.v1",
      "node.job_leased.v1",
      "node.job_result.v1",
    ]);
  });

  it("validates health grants and stores their operation class", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);
    expect(() =>
      grantCapability(
        core.core.kernel,
        { correlationId: "health-grant", actorType: "user", actorId: "local" },
        {
          idempotencyKey: "health-relative",
          nodeId: paired.nodeId,
          capability: "health.run",
          constraints: { repo: "relative" },
        },
      ),
    ).toThrow();
    expect((await read(core, `/nodes/${paired.nodeId}`)).body.grants).toEqual([]);
    await grant(core, paired.nodeId, "health.run", { constraints: { repo: "C:\\glycolens" } });
    const node = await read(core, `/nodes/${paired.nodeId}`);
    expect(node.body.grants).toEqual([
      expect.objectContaining({
        capability: "health.run",
        operationClass: "local_reversible_edit",
        constraints: { repo: "C:\\glycolens" },
      }),
    ]);
  });
  it("reports a connected node and its grants over REST", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "environment.inspect");
    await openFake(core, paired);

    const one = await read(core, `/nodes/${paired.nodeId}`);

    expect(one.body).toMatchObject({ id: paired.nodeId, status: "online", connected: true });
    expect(
      (one.body.grants as Array<{ capability: string; operationClass: string }>)[0],
    ).toMatchObject({ capability: "environment.inspect", operationClass: "read_inspect" });

    const all = await read(core, "/nodes");

    expect((all.body.nodes as unknown[]).length).toBe(1);
  });

  it("records mission evidence when the job names a Mission", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "verification.noop");

    const objective = await command(core, "objective.create", {
      idempotencyKey: "o1",
      title: "Objective",
      intent: "Prove the node loop",
      status: "draft",
      identityId: "vesper",
    });
    const mission = await command(core, "mission.create", {
      idempotencyKey: "m1",
      objectiveId: (objective.body as { id: string }).id,
      title: "Mission",
      operationClass: "read_inspect",
      hostPolicy: "any_granted_host",
    });

    const node = await openFake(core, paired);
    const missionId = (mission.body as { id: string }).id;

    await enqueue(core, "verification.noop", { missionId });
    await waitFor(() => node.jobs().length === 1, "a job frame");

    const frame = node.jobs()[0];
    const assignment = NodeJobAssignmentSchema.parse(JSON.parse(frame?.assignment ?? "{}"));

    node.result(assignment.jobId, { verified: true });

    await waitForAsync(async () => {
      const job = await read(core, `/jobs/${assignment.jobId}`);
      return (job.body.job as { status: string }).status === "succeeded";
    }, "the job to succeed");

    const evidence = core.core.kernel.db
      .prepare("SELECT mission_id, kind, host_id FROM mission_evidence")
      .all() as Array<{ mission_id: string; kind: string; host_id: string }>;

    expect(evidence).toEqual([{ mission_id: missionId, kind: "result", host_id: paired.nodeId }]);
  });
});

describe("the two socket realms are not interchangeable", () => {
  it("refuses the core token on the node socket", async () => {
    const core = await startTestCore();

    await expect(
      openFake(
        core,
        { nodeId: "", credential: "" },
        { headers: { authorization: `Bearer ${TOKEN}` } },
      ),
    ).rejects.toThrow(/server response: 401/);
  });

  it("refuses a node credential on the client socket", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await expect(
      openFake(core, paired, {
        path: "/ws/clients",
        headers: { authorization: `Bearer ${paired.nodeId}.${paired.credential}` },
      }),
    ).rejects.toThrow(/server response: 401/);
  });

  /** A browser page must never be able to become a worker. */
  it("refuses a node upgrade that carries an Origin header", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await expect(
      openFake(core, paired, {
        headers: {
          authorization: `Bearer ${paired.nodeId}.${paired.credential}`,
          origin: "http://localhost:5173",
        },
      }),
    ).rejects.toThrow(/server response: 403/);
  });

  it("refuses an unknown node id exactly as it refuses a wrong credential", async () => {
    const core = await startTestCore();

    await expect(
      openFake(core, {
        nodeId: "0199a000-0000-7000-8000-0000000000ff",
        credential: "a".repeat(64),
      }),
    ).rejects.toThrow(/server response: 401/);
  });

  /**
   * The node exists; the credential does not. Distinct from the unknown-node
   * case above, and the one that actually exercises the credential check —
   * an unknown node is refused before any credential is derived.
   */
  it("refuses a paired node presenting a credential it never held", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await expect(
      openFake(core, { nodeId: paired.nodeId, credential: "0".repeat(64) }),
    ).rejects.toThrow(/server response: 401/);
  });

  /** The far edge of the rotation window: one behind is fine, two is not. */
  it("refuses a credential that is two generations stale", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    const first = await openFake(core, paired);
    first.close();
    await waitFor(() => first.closed() !== undefined, "the first socket to close");

    const second = await openFake(core, {
      nodeId: paired.nodeId,
      credential: first.welcome()?.credential ?? "",
    });
    second.close();
    await waitFor(() => second.closed() !== undefined, "the second socket to close");

    // The credential from pairing is now two rotations behind.
    await expect(openFake(core, paired)).rejects.toThrow(/server response: 401/);
  });

  it("closes a node socket that sends a client frame", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);
    const node = await openFake(core, paired);

    node.sendRaw(JSON.stringify({ kind: "subscribe", envelopeVersion: 1, afterSequence: 0 }));

    await waitFor(() => node.closed() !== undefined, "the socket to close");
    expect(node.closed()?.code).toBe(1008);
  });

  it.each([
    ["not JSON", "{"],
    ["an unregistered frame kind", '{"kind":"execute","envelopeVersion":1}'],
    [
      "an unknown envelope version",
      '{"kind":"hello","envelopeVersion":2,"agentVersion":"1","capabilities":[]}',
    ],
    [
      "an unknown capability",
      '{"kind":"hello","envelopeVersion":1,"agentVersion":"1","capabilities":["shell.exec"]}',
    ],
  ])("closes a node socket that sends %s", async (_label, payload) => {
    const core = await startTestCore();
    const paired = await pairFake(core);
    const node = await openFake(core, paired, { hello: false });

    node.sendRaw(payload);

    await waitFor(() => node.closed() !== undefined, "the socket to close");
    expect(node.closed()?.code).toBe(1008);
  });

  it("closes a node socket that sends a binary frame", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);
    const node = await openFake(core, paired, { hello: false });

    node.sendRaw(Buffer.from([1, 2, 3]));

    await waitFor(() => node.closed() !== undefined, "the socket to close");
    expect(node.closed()?.code).toBe(1008);
  });
});

describe("pairing", () => {
  it("spends a code exactly once", async () => {
    const core = await startTestCore();
    const code = await issueCode(core, "workstation");

    await pairFake(core, { code });

    const second = await fetch(`${core.base}/node/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        hostId: "workstation",
        fingerprint: "fingerprint-b",
        agentVersion: "0.0.0-test",
      }),
    });

    expect(second.status).toBe(404);
  });

  /**
   * Two things stop a code being spent twice: the `consumed_at` marker, and the
   * idempotency claim keyed on the code's digest. The claim fires first, which
   * means the test above passes whether or not `consumed_at` is ever checked.
   *
   * So this deletes the claim — the state a retention sweep over
   * `idempotency_keys` would eventually leave behind — and requires the marker
   * to hold the line on its own.
   */
  it("refuses a spent code even when its idempotency claim has been pruned", async () => {
    const core = await startTestCore();
    const code = await issueCode(core, "workstation");

    await pairFake(core, { code });

    expect(
      core.core.kernel.db.prepare("SELECT consumed_at FROM node_pairing_codes").get(),
    ).not.toEqual({ consumed_at: null });

    core.core.kernel.db.prepare("DELETE FROM idempotency_keys WHERE scope = 'node.pair'").run();

    const response = await fetch(`${core.base}/node/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        hostId: "workstation",
        fingerprint: "fingerprint-a",
        agentVersion: "0.0.0-test",
      }),
    });

    expect(response.status).toBe(404);
  });

  /** A lost response must not cost the pairing: the credential is re-derived. */
  it("answers a retried pair request with the same credential", async () => {
    const core = await startTestCore();
    const code = await issueCode(core, "workstation");
    const first = await pairFake(core, { code });

    const retry = await fetch(`${core.base}/node/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        hostId: "workstation",
        fingerprint: "fingerprint-a",
        agentVersion: "0.0.0-test",
      }),
    });

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(first);
  });

  it("refuses a code that has expired", async () => {
    const core = await startTestCore();
    const code = await issueCode(core, "workstation");

    core.advance(16 * 60 * 1000);

    const response = await fetch(`${core.base}/node/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        hostId: "workstation",
        fingerprint: "fingerprint-a",
        agentVersion: "0.0.0-test",
      }),
    });

    expect(response.status).toBe(404);
  });

  it("refuses a code redeemed for a different host", async () => {
    const core = await startTestCore();
    const code = await issueCode(core, "workstation");

    const response = await fetch(`${core.base}/node/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        hostId: "somewhere-else",
        fingerprint: "fingerprint-a",
        agentVersion: "0.0.0-test",
      }),
    });

    expect(response.status).toBe(404);
  });

  it("never repeats the code on an idempotent replay of the issue command", async () => {
    const core = await startTestCore();
    const first = await command(core, "node.issue_pairing_code", {
      idempotencyKey: "same",
      hostId: "workstation",
    });
    const replay = await command(core, "node.issue_pairing_code", {
      idempotencyKey: "same",
      hostId: "workstation",
    });

    expect(first.body.code).toMatch(/^[0-9a-f]{32}$/);
    expect(replay.status).toBe(200);
    expect(replay.body.code).toBeUndefined();
    expect(replay.body).toMatchObject({ pairingCodeId: first.body.pairingCodeId, consumed: false });
  });

  it("rotates the credential on every connection and still accepts the previous one", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);
    const first = await openFake(core, paired);
    const rotated = first.welcome()?.credential;

    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(paired.credential);

    first.close();
    await waitFor(() => first.closed() !== undefined, "the first socket to close");

    // Reconnecting on the credential from pairing, which is now two behind the
    // row but one behind what the agent was last told.
    const second = await openFake(core, { nodeId: paired.nodeId, credential: rotated ?? "" });

    expect(second.welcome()?.generation).toBe((first.welcome()?.generation ?? 0) + 1);
  });

  /**
   * From handing a live agent from one terminal to another: the new socket
   * connects, the core closes the old one as replaced, and the *old* socket's
   * close handler then wrote `offline` for a node whose newer connection was
   * already registered. Routing was unaffected — it reads the socket map, not
   * the row — so the only symptom was `GET /nodes` calling a working node dead.
   */
  it("stays online when a connection is replaced rather than lost", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);
    const first = await openFake(core, paired);
    const second = await openFake(core, {
      nodeId: paired.nodeId,
      credential: first.welcome()?.credential ?? "",
    });

    expect(second.welcome()).toBeDefined();

    // The core closes the older socket itself; wait for that to land.
    await waitFor(() => first.closed() !== undefined, "the replaced socket to close");

    const node = await read(core, `/nodes/${paired.nodeId}`);

    expect(node.body.status).toBe("online");
  });

  it("renews rather than duplicates a node that re-pairs on the same fingerprint", async () => {
    const core = await startTestCore();
    const first = await pairFake(core, { code: await issueCode(core, "workstation", "c1") });
    const second = await pairFake(core, { code: await issueCode(core, "workstation", "c2") });

    expect(second.nodeId).toBe(first.nodeId);
    expect(second.credential).not.toBe(first.credential);

    const all = await read(core, "/nodes");
    expect((all.body.nodes as unknown[]).length).toBe(1);
  });
});

describe("revocation", () => {
  it("drops the socket, revokes the grants, and refuses the credential afterwards", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "verification.noop");

    const node = await openFake(core, paired);
    const credential = node.welcome()?.credential ?? "";

    const revoked = await command(core, "node.revoke", {
      idempotencyKey: "r1",
      nodeId: paired.nodeId,
    });

    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: "revoked" });

    await waitFor(() => node.closed() !== undefined, "the socket to be dropped");

    await expect(openFake(core, { nodeId: paired.nodeId, credential })).rejects.toThrow(
      /server response: 403/,
    );

    const after = await read(core, `/nodes/${paired.nodeId}`);
    expect((after.body.grants as Array<{ revokedAt?: string }>)[0]?.revokedAt).toBeDefined();
  });

  it("will not grant a capability to a revoked node", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await command(core, "node.revoke", { idempotencyKey: "r1", nodeId: paired.nodeId });

    const granted = await command(core, "node.grant_capability", {
      idempotencyKey: "g1",
      nodeId: paired.nodeId,
      capability: "verification.noop",
      constraints: {},
    });

    expect(granted.status).toBe(404);
  });

  it("stops routing work to a revoked node", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "verification.noop");

    const node = await openFake(core, paired);

    await command(core, "node.revoke", { idempotencyKey: "r1", nodeId: paired.nodeId });
    await waitFor(() => node.closed() !== undefined, "the socket to be dropped");

    const enqueued = await enqueue(core, "verification.noop");
    const job = await read(core, `/jobs/${jobId(enqueued)}`);

    expect(job.body.job).toMatchObject({ status: "queued" });
    expect(job.body.routingReason).toBe("no_paired_node");
  });
});

describe("routing refusals are legible", () => {
  it("names the missing capability", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "environment.inspect");
    await openFake(core, paired);

    const enqueued = await enqueue(core, "verification.noop");
    const job = await read(core, `/jobs/${jobId(enqueued)}`);

    expect(job.body.routingReason).toBe("no_node_with_capability");
  });

  /** The "wrong host" gate: a capable node on another machine is not a fallback. */
  it("names the host when a named_host Mission has no node there", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core, { hostId: "workstation" });

    await grant(core, paired.nodeId, "verification.noop");
    await openFake(core, paired);

    const objective = await command(core, "objective.create", {
      idempotencyKey: "o1",
      title: "Objective",
      intent: "Prove host routing",
      status: "draft",
      identityId: "vesper",
    });
    const mission = await command(core, "mission.create", {
      idempotencyKey: "m1",
      objectiveId: (objective.body as { id: string }).id,
      title: "Mission",
      operationClass: "read_inspect",
      hostPolicy: "named_host",
      hostId: "a-machine-that-is-not-paired",
    });

    const enqueued = await enqueue(core, "verification.noop", {
      missionId: (mission.body as { id: string }).id,
    });
    const job = await read(core, `/jobs/${jobId(enqueued)}`);

    expect(job.body.job).toMatchObject({ status: "queued" });
    expect(job.body.routingReason).toBe("no_node_for_host");
  });

  it("names the offline node when nothing is connected", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "verification.noop");

    const enqueued = await enqueue(core, "verification.noop");
    const job = await read(core, `/jobs/${jobId(enqueued)}`);

    expect(job.body.routingReason).toBe("no_online_node");
  });

  it("reports no reason at all once the job is no longer queued", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "verification.noop");
    await openFake(core, paired);

    const enqueued = await enqueue(core, "verification.noop");
    const job = await read(core, `/jobs/${jobId(enqueued)}`);

    expect(job.body.job).toMatchObject({ status: "leased" });
    expect(job.body.routingReason).toBeUndefined();
  });

  /**
   * Two capable nodes, only one connected, and the offline one sorts first — so
   * a router that scored it as available would pick it, the dispatcher would
   * find no socket, and the job would sit queued while a node that could have
   * run it did nothing. The observable symptom is starvation, not an error,
   * which is why it needs its own test rather than being left to the
   * dispatcher's own second look at the connection map.
   */
  it("places a job on the connected node even when an offline one sorts first", async () => {
    const core = await startTestCore();
    const offline = await pairFake(core, { hostId: "offline-host", fingerprint: "f-offline" });
    const online = await pairFake(core, {
      hostId: "online-host",
      fingerprint: "f-online",
      code: await issueCode(core, "online-host", "code-online"),
    });

    // Paired first, so its UUIDv7 sorts lower and wins the router's tie-break.
    expect(offline.nodeId < online.nodeId).toBe(true);

    await grant(core, offline.nodeId, "verification.noop");
    await grant(core, online.nodeId, "verification.noop");

    const node = await openFake(core, online);
    const enqueued = await enqueue(core, "verification.noop");

    await waitFor(() => node.jobs().length === 1, "a job frame on the connected node");

    const job = await read(core, `/jobs/${jobId(enqueued)}`);
    expect(job.body.job).toMatchObject({ status: "leased", nodeId: online.nodeId });
  });
});

describe("leases", () => {
  it("requeues an idempotent job whose lease lapsed, then abandons it after the last attempt", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "verification.noop");

    const node = await openFake(core, paired);
    const enqueued = await enqueue(core, "verification.noop");
    const id = jobId(enqueued);

    await waitFor(() => node.jobs().length === 1, "the first job frame");

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      core.advance(LEASE_MS + 1);
      core.core.dispatcher.pass();

      const job = await read(core, `/jobs/${id}`);
      const status = job.body.job as { status: string; attempts: number };

      if (attempt < MAX_ATTEMPTS) {
        // Requeued and immediately re-leased by the same pass.
        expect(status.status).toBe("leased");
        expect(status.attempts).toBe(attempt + 1);
      } else {
        expect(status.status).toBe("cancelled");
      }
    }

    const types = await eventTypes(core);

    expect(types.filter((type) => type === "node.job_status_changed.v1").length).toBeGreaterThan(0);
    expect(types.filter((type) => type === "node.job_leased.v1").length).toBe(MAX_ATTEMPTS);
  });

  it("refuses a result that arrives after the lease has lapsed", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "verification.noop");

    const node = await openFake(core, paired);
    const enqueued = await enqueue(core, "verification.noop");
    const id = jobId(enqueued);

    await waitFor(() => node.jobs().length === 1, "a job frame");

    core.advance(LEASE_MS + 1);
    node.result(id, { verified: true });

    // Nothing to wait for but the absence of a change, so give the frame a
    // round trip and then assert the job never moved.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const job = await read(core, `/jobs/${id}`);
    expect(job.body.job).toMatchObject({ status: "leased" });
    expect(job.body.result).toBeUndefined();
  });

  it("refuses a result for a job leased to a different node", async () => {
    const core = await startTestCore();
    const first = await pairFake(core, { hostId: "one", fingerprint: "f1" });
    const second = await pairFake(core, {
      hostId: "two",
      fingerprint: "f2",
      code: await issueCode(core, "two", "code-two"),
    });

    await grant(core, first.nodeId, "verification.noop");
    await grant(core, second.nodeId, "verification.noop");

    const nodeOne = await openFake(core, first);
    const enqueued = await enqueue(core, "verification.noop");
    const id = jobId(enqueued);

    await waitFor(() => nodeOne.jobs().length === 1, "a job frame");

    const nodeTwo = await openFake(core, second);
    nodeTwo.result(id, { verified: true });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const job = await read(core, `/jobs/${id}`);
    expect(job.body.job).toMatchObject({ status: "leased", nodeId: first.nodeId });
  });
});

describe("duplicate work", () => {
  it("returns the same job for a replayed enqueue, and queues it once", async () => {
    const core = await startTestCore();
    const first = await command(core, "node.job_enqueue", {
      idempotencyKey: "same-job",
      capability: "verification.noop",
      payload: {},
    });
    const replay = await command(core, "node.job_enqueue", {
      idempotencyKey: "same-job",
      capability: "verification.noop",
      payload: {},
    });

    expect(replay.status).toBe(200);
    expect(jobId(replay.body)).toBe(jobId(first.body));

    const rows = core.core.kernel.db.prepare("SELECT COUNT(*) AS n FROM node_jobs").get() as {
      n: number;
    };

    expect(rows.n).toBe(1);
    expect((await eventTypes(core)).filter((type) => type === "node.job_queued.v1").length).toBe(1);
  });

  it("records one result however many times the node reports it", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "verification.noop");

    const node = await openFake(core, paired);
    const enqueued = await enqueue(core, "verification.noop");
    const id = jobId(enqueued);

    await waitFor(() => node.jobs().length === 1, "a job frame");

    node.result(id, { verified: true });
    node.result(id, { verified: true });
    node.result(id, { verified: true });

    await waitForAsync(async () => {
      const job = await read(core, `/jobs/${id}`);
      return (job.body.job as { status: string }).status === "succeeded";
    }, "the job to succeed");

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await eventTypes(core)).filter((type) => type === "node.job_result.v1").length).toBe(1);
  });
});

describe("hostile node behaviour", () => {
  it("closes the socket and records nothing when evidence does not match the capability", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "environment.inspect");

    const node = await openFake(core, paired);
    const enqueued = await enqueue(core, "environment.inspect");
    const id = jobId(enqueued);

    await waitFor(() => node.jobs().length === 1, "a job frame");

    // A plausible-looking object that the capability's evidence schema does not
    // describe. Recording it would put something in the audit log that no reader
    // could interpret.
    node.result(id, { platform: "win32", unexpected: "field" });

    await waitFor(() => node.closed() !== undefined, "the socket to close");
    expect(node.closed()?.code).toBe(1008);

    const job = await read(core, `/jobs/${id}`);
    expect(job.body.job).toMatchObject({ status: "leased" });
    expect(job.body.result).toBeUndefined();
  });

  it("closes a socket that exhausts its progress budget for one job", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "verification.noop");

    const node = await openFake(core, paired);
    const enqueued = await enqueue(core, "verification.noop");
    const id = jobId(enqueued);

    await waitFor(() => node.jobs().length === 1, "a job frame");

    for (let sent = 0; sent < 250; sent += 1) {
      node.progress(id, 50);
    }

    await waitFor(() => node.closed() !== undefined, "the socket to close");
    expect(node.closed()?.code).toBe(1008);
  });

  it("closes a second hello on the same socket", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);
    const node = await openFake(core, paired);

    node.sendRaw(
      JSON.stringify({
        kind: "hello",
        envelopeVersion: NODE_ENVELOPE_VERSION,
        agentVersion: "0.0.0-test",
        capabilities: [],
      }),
    );

    await waitFor(() => node.closed() !== undefined, "the socket to close");
    expect(node.closed()?.code).toBe(1008);
  });

  it("closes a socket that reports a result before saying hello", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);
    const node = await openFake(core, paired, { hello: false });

    node.result("0199a000-0000-7000-8000-0000000000aa", { verified: true });

    await waitFor(() => node.closed() !== undefined, "the socket to close");
    expect(node.closed()?.code).toBe(1008);
  });

  it("refuses a job payload the capability does not accept", async () => {
    const core = await startTestCore();
    const enqueued = await command(core, "node.job_enqueue", {
      idempotencyKey: "bad-payload",
      capability: "file.search",
      payload: { rootGrantId: "root", nameContains: "" },
    });

    expect(enqueued.status).toBe(500);
  });
});

describe("cancellation", () => {
  it("tells the node and moves the job to cancelled", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "verification.noop");

    const node = await openFake(core, paired);
    const enqueued = await enqueue(core, "verification.noop");
    const id = jobId(enqueued);

    await waitFor(() => node.jobs().length === 1, "a job frame");

    const cancelled = await command(core, "node.job_cancel", { idempotencyKey: "c1", jobId: id });

    expect(cancelled.status).toBe(200);

    await waitFor(() => node.frames.some((frame) => frame.kind === "cancel"), "a cancel frame");

    const job = await read(core, `/jobs/${id}`);
    expect(job.body.job).toMatchObject({ status: "cancelled" });
  });
});

describe("runtime frames", () => {
  const CODEX_PROBE = {
    providerId: "codex",
    available: true,
    authMode: "chatgpt",
    models: [{ providerId: "codex", model: "gpt-5.6-sol" }],
  };

  /** A valid `runtime.turn` payload; the ids are UUIDv7-shaped like the rest of the suite. */
  const TURN_PAYLOAD = {
    threadId: "0199a000-0000-7000-8000-0000000000e1",
    identityId: "vesper",
    model: { providerId: "codex", model: "gpt-5.6-sol" },
    userMessageId: "0199a000-0000-7000-8000-0000000000e2",
    prompt: "say hello",
    primaryRootGrantId: "d",
    objectiveActive: false,
  };

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

  /** Leases one runtime.turn job to a fake node and returns both. */
  async function leaseTurn(core: TestCore, directory: string) {
    const paired = await pairFake(core);

    await grant(core, paired.nodeId, "runtime.turn", {
      constraints: {
        providers: ["codex"],
        roots: [{ grantId: "d", path: directory, mode: "write" }],
      },
    });

    const node = await openFake(core, paired, { providers: [CODEX_PROBE] });
    // An explicit key: the helper's default stringifies the payload past 255 chars.
    const enqueued = await enqueue(core, "runtime.turn", {
      idempotencyKey: "turn-1",
      payload: TURN_PAYLOAD,
    });
    const id = jobId(enqueued);

    await waitFor(() => node.jobs().length === 1, "a job frame");

    return { paired, node, id };
  }

  it("hello persists what the node can run", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    await openFake(core, paired, { providers: [CODEX_PROBE] });

    const one = await read(core, `/nodes/${paired.nodeId}`);

    expect(one.body.providers).toEqual([CODEX_PROBE]);
  });

  it("a pinned job waits for its node", async () => {
    const core = await startTestCore();
    const a = await pairFake(core, { hostId: "a", fingerprint: "fa" });
    const b = await pairFake(core, {
      hostId: "b",
      fingerprint: "fb",
      code: await issueCode(core, "b", "code-b"),
    });

    await grant(core, a.nodeId, "verification.noop");
    await grant(core, b.nodeId, "verification.noop");
    await openFake(core, a);

    const { kernel } = core.core;
    const id = kernel.ids.nextId();
    const pinned = runCommand(
      kernel,
      { scope: "node.job_enqueue", key: "pinned", resultId: id },
      (tx) =>
        enqueueJobInTransaction(
          tx,
          kernel,
          { correlationId: kernel.ids.nextId(), actorType: "system", actorId: "test" },
          {
            id,
            capability: "verification.noop",
            payload: {},
            idempotencyKey: "pinned",
            pinnedNodeId: b.nodeId,
          },
        ),
    );

    expect(pinned.ok).toBe(true);
    core.core.dispatcher.pass();

    const queued = await read(core, `/jobs/${id}`);

    expect(queued.body.job).toMatchObject({ status: "queued", pinnedNodeId: b.nodeId });
    expect(queued.body.routingReason).toBe("pinned_node_unavailable");

    const nodeB = await openFake(core, b);

    await waitFor(() => nodeB.jobs().length === 1, "the pinned job on node B");

    const leased = await read(core, `/jobs/${id}`);

    expect(leased.body.job).toMatchObject({ status: "leased", nodeId: b.nodeId });
  });

  it("a delta frame renews the lease and reaches the hub without being persisted", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const { paired, node, id } = await leaseTurn(core, directory);

    const before = await read(core, `/jobs/${id}`);
    // Presence's live brief follows the job with surface events of its own.
    const jobEvents = async () =>
      (await eventTypes(core)).filter((type) => !type.startsWith("surface."));
    const eventsBefore = (await jobEvents()).length;
    const deltas: unknown[] = [];

    core.core.runtimeFrames.subscribe({
      onDelta: (nodeId, forJob, delta) => deltas.push({ nodeId, forJob, delta }),
    });

    core.advance(LEASE_MS - 1000);
    node.frame({ kind: "delta", jobId: id, delta: { itemId: "item-1", text: "hel" } });

    await waitFor(() => deltas.length === 1, "the delta to reach the hub");

    expect(deltas[0]).toEqual({
      nodeId: paired.nodeId,
      forJob: id,
      delta: { itemId: "item-1", text: "hel" },
    });

    await waitForAsync(async () => {
      const job = await read(core, `/jobs/${id}`);
      return (job.body.job as { status: string }).status === "running";
    }, "the job to be running");

    const after = await read(core, `/jobs/${id}`);
    const lease = (record: Record<string, unknown>) =>
      Date.parse((record.job as { leaseExpiresAt: string }).leaseExpiresAt);

    expect(lease(after.body)).toBeGreaterThan(lease(before.body));
    expect(node.closed()).toBeUndefined();

    // Exactly one more event — leased -> running — and it is not a delta.
    const types = await jobEvents();
    expect(types.length).toBe(eventsBefore + 1);
    expect(types.at(-1)).toBe("node.job_status_changed.v1");

    rmSync(directory, { recursive: true, force: true });
  });

  it("an ask reaches the hub and an answer reaches the node", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const { paired, node, id } = await leaseTurn(core, directory);
    const asks: unknown[] = [];

    core.core.runtimeFrames.subscribe({ onAsk: (_nodeId, _jobId, ask) => asks.push(ask) });
    node.frame({ kind: "ask", jobId: id, ask: ASK });

    await waitFor(() => asks.length === 1, "the ask to reach the hub");
    expect(asks[0]).toEqual(ASK);

    const answer = {
      askId: ASK.askId,
      decision: "deny" as const,
      approvalId: "0199a000-0000-7000-8000-0000000000a6",
    };

    expect(core.core.dispatcher.sendAnswer(paired.nodeId, id, answer)).toBe(true);

    await waitFor(() => node.frames.some((frame) => frame.kind === "answer"), "an answer frame");

    const received = node.frames.find((frame) => frame.kind === "answer");
    expect(NodeServerFrameSchema.parse(received)).toEqual({
      kind: "answer",
      envelopeVersion: NODE_ENVELOPE_VERSION,
      jobId: id,
      answer,
    });

    rmSync(directory, { recursive: true, force: true });
  });

  it("lets a mirror heartbeat for hours without costing the node its other job", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const { paired, node, id } = await leaseTurn(core, directory);

    await grant(core, paired.nodeId, "screen.view");

    const mirror = jobId(
      await enqueue(core, "screen.view", {
        idempotencyKey: "mirror-1",
        payload: { fps: 15, width: 1280 },
      }),
    );

    await waitFor(() => node.jobs().length === 2, "the mirror job frame");

    const deltas: unknown[] = [];

    core.core.runtimeFrames.subscribe({ onDelta: (_node, _job, delta) => deltas.push(delta) });

    // Forty minutes of heartbeats at a steady rate: more frames over its life than
    // any lifetime count would allow, and a handful in any one minute. The delta
    // after each batch is how the test knows the batch has been read.
    for (let tenSeconds = 0; tenSeconds < 240; tenSeconds += 1) {
      for (let sent = 0; sent < 9; sent += 1) {
        node.progress(mirror, 0);
      }

      core.advance(10_000);
      node.frame({ kind: "delta", jobId: id, delta: { itemId: "item-1", text: "x" } });
      await waitFor(
        () => deltas.length === tenSeconds + 1,
        `batch ${String(tenSeconds)} to be read`,
      );
    }

    expect(node.closed()).toBeUndefined();

    rmSync(directory, { recursive: true, force: true });
  }, 30_000);

  it("a frame for a job the node does not hold closes the socket", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);
    const node = await openFake(core, paired);

    node.frame({
      kind: "delta",
      jobId: "0199a000-0000-7000-8000-0000000000bb",
      delta: { itemId: "item-1", text: "x" },
    });

    await waitFor(() => node.closed() !== undefined, "the socket to close");
    expect(node.closed()?.code).toBe(1008);
  });
});

describe("the live bridge", () => {
  type Row = Record<string, unknown>;

  async function report(core: TestCore, authorization: string, event: Record<string, unknown>) {
    const response = await fetch(`${core.base}/node/bridge`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ providerId: "claude", sessionRef: "vs-1", cwd: "C:\\app", ...event }),
    });

    return response.status;
  }

  it("THE GATE: a PC's hooks become a live session the owner reads, from start to end", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core, { hostId: "work" });
    const bearer = `Bearer ${paired.nodeId}.${paired.credential}`;

    expect(await report(core, bearer, { kind: "start" })).toBe(204);
    expect(await report(core, bearer, { kind: "prompt", text: "Fix the build" })).toBe(204);
    expect(await report(core, bearer, { kind: "reply", text: "Fixed: a missing import." })).toBe(
      204,
    );

    const listed = (await read(core, "/live-sessions")).body.sessions as Row[];

    expect(listed).toEqual([
      expect.objectContaining({
        nodeId: paired.nodeId,
        hostId: "work",
        providerId: "claude",
        sessionRef: "vs-1",
        cwd: "C:\\app",
        title: "Fix the build",
        status: "live",
      }),
    ]);

    const id = listed[0]?.id as string;
    const entries = (await read(core, `/live-sessions/${id}/entries`)).body.entries as Row[];

    expect(entries.map((entry) => [entry.role, entry.body])).toEqual([
      ["user", "Fix the build"],
      ["agent", "Fixed: a missing import."],
    ]);

    expect(await report(core, bearer, { kind: "end" })).toBe(204);
    expect(((await read(core, "/live-sessions")).body.sessions as Row[])[0]?.status).toBe("ended");

    // Each change is a ledger event, so an open page reads again.
    const events = (await read(core, "/events?limit=100")).body.events as Row[];
    expect(events.filter((event) => event.type === "bridge.session_updated.v1")).toHaveLength(4);
  });

  it("a session that sends a prompt first, or comes back after it ended, is live again", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);
    const bearer = `Bearer ${paired.nodeId}.${paired.credential}`;

    await report(core, bearer, { kind: "prompt", text: "Hello" });
    await report(core, bearer, { kind: "end" });
    await report(core, bearer, { kind: "prompt", text: "Resumed" });

    const listed = (await read(core, "/live-sessions")).body.sessions as Row[];

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ title: "Hello", status: "live" });
  });

  it("refuses anything but a paired node's own credential, and a body it cannot read", async () => {
    const core = await startTestCore();
    const paired = await pairFake(core);

    expect(await report(core, `Bearer ${TOKEN}`, { kind: "start" })).toBe(401);
    expect(await report(core, `Bearer ${paired.nodeId}.${"0".repeat(64)}`, { kind: "start" })).toBe(
      401,
    );
    expect(
      await report(core, `Bearer ${paired.nodeId}.${paired.credential}`, { kind: "nonsense" }),
    ).toBe(400);
    expect((await read(core, "/live-sessions")).body.sessions).toEqual([]);
    expect(
      (await read(core, "/live-sessions/0199a000-0000-7000-8000-000000000001/entries")).status,
    ).toBe(404);
  });
});
