import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CoreConfig, RunningCore } from "@noctis/core";
import { createLogger, signAssignment, startCore } from "@noctis/core";
import type {
  NodeCredential,
  NodeFrame,
  RuntimeAsk,
  RuntimeItem,
  RuntimeProbe,
} from "@noctis/contracts";
import {
  EnvironmentInspectEvidenceSchema,
  FileSearchEvidenceSchema,
  NODE_ENVELOPE_VERSION,
  RuntimeTurnEvidenceSchema,
} from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import type { AgentOptions, RunningAgent } from "./agent.js";
import { startAgent } from "./agent.js";
import { FAKE_PROBE, createFakeRuntime } from "./runtimes/fake.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

const started: Array<{ core: RunningCore; directory: string }> = [];
const agents: RunningAgent[] = [];
const fakes: Array<{ server: Server; sockets: WebSocketServer }> = [];
const scratches: string[] = [];

interface TestCore {
  core: RunningCore;
  base: string;
}

async function startTestCore(): Promise<TestCore> {
  const directory = mkdtempSync(join(tmpdir(), "noctis-agent-"));
  const config: CoreConfig = {
    bindAddress: "127.0.0.1",
    port: 0,
    token: TOKEN,
    databasePath: join(directory, "core.db"),
    allowedOrigins: [],
    logLevel: "error",
    sessionTtlHours: 720,
  };

  const core = await startCore({
    config,
    logger: createLogger({ sink: () => undefined, level: "error" }),
    dispatchIntervalMs: 50,
  });

  started.push({ core, directory });

  return { core, base: `http://127.0.0.1:${String(core.port)}` };
}

afterEach(async () => {
  while (agents.length > 0) {
    agents.pop()?.close();
  }

  while (fakes.length > 0) {
    const fake = fakes.pop();

    if (fake !== undefined) {
      fake.sockets.close();
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  }

  while (started.length > 0) {
    const entry = started.pop();

    if (entry !== undefined) {
      await entry.core.close();
      rmSync(entry.directory, { recursive: true, force: true });
    }
  }

  while (scratches.length > 0) {
    const directory = scratches.pop();

    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

async function command(
  core: TestCore,
  name: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${core.base}/commands/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  expect(response.status).toBe(200);

  return (await response.json()) as Record<string, unknown>;
}

async function readJob(core: TestCore, id: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${core.base}/jobs/${id}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  return (await response.json()) as Record<string, unknown>;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Pairs over the real HTTP endpoint, exactly as `main.ts pair` does. */
async function pair(core: TestCore, hostId = "test-host"): Promise<NodeCredential> {
  const issued = await command(core, "node.issue_pairing_code", {
    idempotencyKey: `code-${hostId}`,
    hostId,
  });

  const response = await fetch(`${core.base}/node/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: issued.code,
      hostId,
      fingerprint: `fingerprint-${hostId}`,
      agentVersion: "0.0.0-test",
    }),
  });

  expect(response.status).toBe(200);

  const paired = (await response.json()) as {
    nodeId: string;
    generation: number;
    credential: string;
  };

  return { coreUrl: core.base, ...paired };
}

async function connectAgent(
  core: TestCore,
  credential: NodeCredential,
  saved: NodeCredential[] = [],
  overrides: Partial<AgentOptions> = {},
): Promise<RunningAgent> {
  const agent = startAgent({
    credential,
    saveCredential: (next) => saved.push(next),
    initialBackoffMs: 20,
    maxBackoffMs: 100,
    // Nothing on the test machine is probed; each case says what it found.
    probes: () => Promise.resolve([]),
    ...overrides,
  });

  agents.push(agent);

  await waitFor(() => agent.connected(), "the agent to connect");

  return agent;
}

async function runJob(
  core: TestCore,
  capability: string,
  payload: unknown = {},
): Promise<Record<string, unknown>> {
  const enqueued = await command(core, "node.job_enqueue", {
    idempotencyKey: `job-${capability}-${JSON.stringify(payload)}`,
    capability,
    payload,
  });

  const id = (enqueued.job as { id: string }).id;

  await waitFor(async () => {
    const job = await readJob(core, id);
    return (job.job as { status: string }).status === "succeeded";
  }, `${capability} to succeed`);

  return readJob(core, id);
}

describe("the real agent against the real core", () => {
  it("pairs, connects, and executes each granted capability end to end", async () => {
    const core = await startTestCore();
    const credential = await pair(core);
    const saved: NodeCredential[] = [];

    const scratch = mkdtempSync(join(tmpdir(), "noctis-grant-"));
    scratches.push(scratch);
    mkdirSync(join(scratch, "notes"));
    writeFileSync(join(scratch, "notes", "findings.md"), "evidence");

    await command(core, "node.grant_capability", {
      idempotencyKey: "g1",
      nodeId: credential.nodeId,
      capability: "verification.noop",
      constraints: {},
    });
    await command(core, "node.grant_capability", {
      idempotencyKey: "g2",
      nodeId: credential.nodeId,
      capability: "environment.inspect",
      constraints: {},
    });
    await command(core, "node.grant_capability", {
      idempotencyKey: "g3",
      nodeId: credential.nodeId,
      capability: "file.search",
      constraints: { roots: [{ grantId: "scratch", path: scratch }] },
    });

    await connectAgent(core, credential, saved);

    expect(await runJob(core, "verification.noop")).toMatchObject({ result: { verified: true } });

    const environment = await runJob(core, "environment.inspect");
    expect(EnvironmentInspectEvidenceSchema.parse(environment.result)).toMatchObject({
      platform: process.platform,
    });

    const search = await runJob(core, "file.search", {
      rootGrantId: "scratch",
      nameContains: "findings",
    });
    const evidence = FileSearchEvidenceSchema.parse(search.result);

    expect(evidence.matches).toHaveLength(1);
    expect(evidence.matches[0]?.relativePath).toBe(join("notes", "findings.md"));

    // The rotated credential reached the agent's store, which is the only copy
    // of it that exists — the core keeps a generation counter and nothing else.
    expect(saved.at(-1)?.generation).toBe(credential.generation + 1);
  });

  it("reconnects after the core drops it, and runs work again", async () => {
    const core = await startTestCore();
    const credential = await pair(core);
    const saved: NodeCredential[] = [];

    await command(core, "node.grant_capability", {
      idempotencyKey: "g1",
      nodeId: credential.nodeId,
      capability: "verification.noop",
      constraints: {},
    });

    const agent = await connectAgent(core, credential, saved);

    expect(core.core.dispatcher.disconnect(credential.nodeId, 1011, "test drop")).toBe(true);

    await waitFor(() => !agent.connected(), "the agent to notice the drop");
    await waitFor(() => agent.connected(), "the agent to reconnect");

    // A second connection means a second rotation, on a credential the agent
    // only has because it kept the one from the first welcome.
    expect(saved).toHaveLength(2);
    expect(await runJob(core, "verification.noop")).toMatchObject({ result: { verified: true } });
  });

  it("keeps retrying a core that is not there, with a growing delay", async () => {
    const agent = startAgent({
      credential: {
        coreUrl: "http://127.0.0.1:1",
        nodeId: "0199a000-0000-7000-8000-00000000000a",
        generation: 0,
        credential: "a".repeat(64),
      },
      saveCredential: () => undefined,
      probes: () => Promise.resolve([]),
      initialBackoffMs: 10,
      maxBackoffMs: 40,
    });

    agents.push(agent);

    await waitFor(() => agent.attempts() >= 3, "three reconnect attempts");

    expect(agent.connected()).toBe(false);
  });

  // The two tests above pass whether or not the agent holds its own process
  // open, because vitest's worker keeps the event loop alive for them. On a real
  // machine the pending reconnect is the only thing left once the socket has
  // gone, so a timer that does not hold the loop lets `node main.js` exit 0 — at
  // boot before the tailnet is up, and on every drop after that. Task Scheduler
  // reads exit 0 as success and restarts nothing. Found on `zarrarpc` on
  // 2026-09-22, when the first cold start exited two seconds before login.
  //
  // `getActiveResourcesInfo()` is Node's own list of what is keeping the loop
  // alive, and an unref'd timer is exactly what it leaves out.
  it("holds its own process open while it waits to reconnect", async () => {
    const liveTimers = () =>
      process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
    const before = liveTimers();

    const agent = startAgent({
      credential: {
        coreUrl: "http://127.0.0.1:1",
        nodeId: "0199a000-0000-7000-8000-00000000000b",
        generation: 0,
        credential: "b".repeat(64),
      },
      saveCredential: () => undefined,
      probes: () => Promise.resolve([]),
      // Long enough that the retry is certainly still pending when it is counted.
      initialBackoffMs: 60_000,
      maxBackoffMs: 60_000,
    });

    agents.push(agent);

    await waitFor(() => agent.attempts() >= 1, "the first reconnect to be scheduled");

    expect(liveTimers()).toBe(before + 1);
  });

  it("reports a failure rather than going silent when an adapter refuses", async () => {
    const core = await startTestCore();
    const credential = await pair(core);

    await command(core, "node.grant_capability", {
      idempotencyKey: "g1",
      nodeId: credential.nodeId,
      capability: "file.search",
      constraints: { roots: [{ grantId: "granted", path: tmpdir() }] },
    });

    await connectAgent(core, credential);

    const enqueued = await command(core, "node.job_enqueue", {
      idempotencyKey: "j1",
      capability: "file.search",
      // A grant id the node was never given, so the adapter refuses locally.
      payload: { rootGrantId: "not-granted", nameContains: "anything" },
    });

    const id = (enqueued.job as { id: string }).id;

    await waitFor(async () => {
      const job = await readJob(core, id);
      return (job.job as { status: string }).status === "failed";
    }, "the job to fail");

    const job = await readJob(core, id);
    expect(job.failureReason).toContain("not-granted");
  });
});

describe("a runtime turn through the real core", () => {
  const TURN = {
    threadId: "0199a000-0000-7000-8000-0000000000e1",
    identityId: "vesper",
    model: { providerId: "codex", model: "fake-model" },
    userMessageId: "0199a000-0000-7000-8000-0000000000e2",
    primaryRootGrantId: "scratch",
    objectiveActive: false,
  };

  interface Seen {
    items: Array<{ jobId: string; item: RuntimeItem }>;
    deltas: Array<{ jobId: string; text: string }>;
    asks: Array<{ jobId: string; ask: RuntimeAsk }>;
  }

  /** A paired node granted runtime.turn over a scratch root, with the fake behind codex. */
  async function turnReadyAgent(probes: RuntimeProbe[] = [FAKE_PROBE]): Promise<{
    core: TestCore;
    credential: NodeCredential;
    seen: Seen;
  }> {
    const core = await startTestCore();
    const credential = await pair(core);
    const scratch = mkdtempSync(join(tmpdir(), "noctis-turn-root-"));

    scratches.push(scratch);

    await command(core, "node.grant_capability", {
      idempotencyKey: "g-turn",
      nodeId: credential.nodeId,
      capability: "runtime.turn",
      constraints: {
        providers: ["codex"],
        roots: [{ grantId: "scratch", path: scratch, mode: "write" }],
      },
    });

    const seen: Seen = { items: [], deltas: [], asks: [] };

    core.core.runtimeFrames.subscribe({
      onStreamItem: (_nodeId, jobId, _sequence, item) => seen.items.push({ jobId, item }),
      onDelta: (_nodeId, jobId, delta) => seen.deltas.push({ jobId, text: delta.text }),
      onAsk: (_nodeId, jobId, ask) => seen.asks.push({ jobId, ask }),
    });

    await connectAgent(core, credential, [], {
      runtimes: { codex: createFakeRuntime() },
      probes: () => Promise.resolve(probes),
    });

    return { core, credential, seen };
  }

  async function enqueueTurn(core: TestCore, key: string, prompt: string): Promise<string> {
    const enqueued = await command(core, "node.job_enqueue", {
      idempotencyKey: key,
      capability: "runtime.turn",
      payload: { ...TURN, prompt },
    });

    return (enqueued.job as { id: string }).id;
  }

  async function status(core: TestCore, id: string): Promise<string> {
    return ((await readJob(core, id)).job as { status: string }).status;
  }

  it("streams items, deltas and an ask to the real core, and the answer comes back", async () => {
    const { core, credential, seen } = await turnReadyAgent();

    // hello carried the probe: the core knows this node offers the fake model.
    const node = await fetch(`${core.base}/nodes/${credential.nodeId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await node.json()) as { providers: unknown }).providers).toEqual([FAKE_PROBE]);

    const id = await enqueueTurn(core, "turn-ask", "ASK: please");

    await waitFor(() => seen.asks.some((ask) => ask.jobId === id), "the ask to reach the hub");

    expect(seen.deltas.filter((delta) => delta.jobId === id).map((delta) => delta.text)).toEqual([
      "Hel",
      "lo",
    ]);
    expect(seen.items.map((entry) => entry.item.kind)).toEqual(["agent_message", "command"]);

    const ask = seen.asks[0]?.ask;

    expect(ask).toMatchObject({ itemId: "c1", kind: "command", capability: "runtime.command" });
    // The runtime is parked on the ask: the job is running, not finished.
    expect(await status(core, id)).toBe("running");

    expect(
      core.core.dispatcher.sendAnswer(credential.nodeId, id, {
        askId: ask?.askId ?? "",
        decision: "allow",
        approvalId: "0199a000-0000-7000-8000-0000000000a6",
      }),
    ).toBe(true);

    await waitFor(async () => (await status(core, id)) === "succeeded", "the turn to succeed");

    const evidence = RuntimeTurnEvidenceSchema.parse((await readJob(core, id)).result);

    expect(evidence.itemCount).toBeGreaterThanOrEqual(2);
    expect(evidence.stoppedReason).toBe("completed");
    expect(seen.items.at(-1)?.item).toMatchObject({ itemId: "c1", status: "completed" });
  });

  it("runs two turns on one node at the same time", async () => {
    const { core, seen } = await turnReadyAgent();

    const first = await enqueueTurn(core, "turn-slow-1", "SLOW: one");
    const second = await enqueueTurn(core, "turn-slow-2", "SLOW: two");

    // Both have started streaming while neither has finished.
    await waitFor(
      () =>
        seen.deltas.some((delta) => delta.jobId === first) &&
        seen.deltas.some((delta) => delta.jobId === second),
      "both turns to stream",
    );
    expect([await status(core, first), await status(core, second)]).toEqual(["running", "running"]);

    await waitFor(
      async () =>
        (await status(core, first)) === "succeeded" && (await status(core, second)) === "succeeded",
      "both turns to succeed",
    );
  });
});

/**
 * A server that speaks the core's half of the protocol badly on purpose.
 *
 * The agent's refusals are the half a real core can never exercise, because a
 * real core does not send unsigned jobs, jobs for other nodes, or jobs whose
 * lease has already lapsed.
 */
interface FakeCore {
  url: string;
  frames: NodeFrame[];
  welcome: (credential: string, grants: unknown[]) => void;
  job: (assignment: unknown, signature: string) => void;
  connected: () => boolean;
}

async function startFakeCore(): Promise<FakeCore> {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  const frames: NodeFrame[] = [];

  let live: WebSocket | undefined;

  server.on("upgrade", (req, socket, head) => {
    sockets.handleUpgrade(req, socket, head, (ws) => {
      live = ws;
      ws.on("message", (data: Buffer) => {
        frames.push(JSON.parse(data.toString("utf8")) as NodeFrame);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  fakes.push({ server, sockets });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("fake core did not bind");
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    frames,
    welcome: (credential, grants) => {
      live?.send(
        JSON.stringify({
          kind: "welcome",
          envelopeVersion: NODE_ENVELOPE_VERSION,
          nodeId: "0199a000-0000-7000-8000-00000000000a",
          generation: 1,
          credential,
          grants,
        }),
      );
    },
    job: (assignment, signature) => {
      live?.send(
        JSON.stringify({
          kind: "job",
          envelopeVersion: NODE_ENVELOPE_VERSION,
          assignment: JSON.stringify(assignment),
          signature,
        }),
      );
    },
    connected: () => live !== undefined,
  };
}

describe("the agent refuses what a real core would never send", () => {
  const NODE = "0199a000-0000-7000-8000-00000000000a";
  const SESSION = "b".repeat(64);
  const GRANT = {
    id: "0199a000-0000-7000-8000-00000000000c",
    nodeId: NODE,
    capability: "verification.noop",
    operationClass: "read_inspect",
    constraintsVersion: 1,
    constraints: {},
    grantedAt: "2026-09-01T12:00:00.000Z",
  };

  function assignment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      jobId: "0199a000-0000-7000-8000-00000000000d",
      nodeId: NODE,
      capability: "verification.noop",
      payloadVersion: 1,
      payload: {},
      idempotencyKey: "k1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      attempt: 1,
      ...overrides,
    };
  }

  async function connected(): Promise<FakeCore> {
    const fake = await startFakeCore();
    const agent = startAgent({
      credential: { coreUrl: fake.url, nodeId: NODE, generation: 0, credential: "a".repeat(64) },
      saveCredential: () => undefined,
      reconnect: false,
      probes: () => Promise.resolve([]),
    });

    agents.push(agent);

    await waitFor(() => fake.connected(), "the agent to dial the fake core");
    await waitFor(() => fake.frames.some((frame) => frame.kind === "hello"), "hello");

    fake.welcome(SESSION, [GRANT]);
    await waitFor(() => agent.connected(), "the agent to accept the welcome");

    return fake;
  }

  async function expectNoResult(fake: FakeCore): Promise<void> {
    // Nothing to wait for but an absence, so give it a generous round trip.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(fake.frames.filter((frame) => frame.kind === "result")).toEqual([]);
  }

  it("runs a correctly signed job, which is what makes the refusals below mean something", async () => {
    const fake = await connected();

    // Built once: two calls stamp two leaseExpiresAt values across a millisecond
    // boundary, and the signature then covers bytes the job frame never sent.
    const signed = assignment();

    fake.job(signed, signAssignment(SESSION, JSON.stringify(signed)));

    await waitFor(() => fake.frames.some((frame) => frame.kind === "result"), "a result frame");

    const result = fake.frames.find((frame) => frame.kind === "result");
    expect(result).toMatchObject({ outcome: "succeeded", evidence: { verified: true } });
  });

  it("ignores a job whose signature does not verify", async () => {
    const fake = await connected();

    fake.job(assignment(), "0".repeat(64));
    await expectNoResult(fake);
  });

  it("ignores a job signed with a credential that is not this node's session", async () => {
    const fake = await connected();
    const body = JSON.stringify(assignment());

    fake.job(assignment(), signAssignment("c".repeat(64), body));
    await expectNoResult(fake);
  });

  it("ignores a job addressed to another node", async () => {
    const fake = await connected();
    const forged = assignment({ nodeId: "0199a000-0000-7000-8000-00000000000e" });

    fake.job(forged, signAssignment(SESSION, JSON.stringify(forged)));
    await expectNoResult(fake);
  });

  it("ignores a job whose lease has already lapsed", async () => {
    const fake = await connected();
    const stale = assignment({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });

    fake.job(stale, signAssignment(SESSION, JSON.stringify(stale)));
    await expectNoResult(fake);
  });

  it("refuses a capability it was not granted, and says so", async () => {
    const fake = await connected();
    const ungranted = assignment({ capability: "environment.inspect" });

    fake.job(ungranted, signAssignment(SESSION, JSON.stringify(ungranted)));

    await waitFor(() => fake.frames.some((frame) => frame.kind === "result"), "a result frame");

    expect(fake.frames.find((frame) => frame.kind === "result")).toMatchObject({
      outcome: "failed",
      failureReason: "capability environment.inspect is not granted to this node",
    });
  });
});
