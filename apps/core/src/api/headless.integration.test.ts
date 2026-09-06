import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MissionRecord, ObjectiveRecord, ServerFrame } from "@noctis/contracts";
import { ENVELOPE_VERSION } from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { CoreConfig } from "../config/server.js";
import { createLogger } from "../logging.js";
import type { RunningCore } from "../server.js";
import { startCore } from "../server.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

interface TestCore {
  core: RunningCore;
  base: string;
  socketUrl: string;
}

const started: Array<{ core: RunningCore; directory: string }> = [];

async function startTestCore(overrides: Partial<CoreConfig> = {}): Promise<TestCore> {
  const directory = mkdtempSync(join(tmpdir(), "noctis-core-"));
  const config: CoreConfig = {
    bindAddress: "127.0.0.1",
    port: 0,
    token: TOKEN,
    databasePath: join(directory, "core.db"),
    allowedOrigins: [],
    logLevel: "error",
    ...overrides,
  };

  const core = await startCore({
    config,
    logger: createLogger({ sink: () => undefined, level: "error" }),
  });

  started.push({ core, directory });

  return {
    core,
    base: `http://127.0.0.1:${String(core.port)}`,
    socketUrl: `ws://127.0.0.1:${String(core.port)}`,
  };
}

afterEach(async () => {
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
  headers: Record<string, string> = authorized(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${core.base}/commands/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function read(
  core: TestCore,
  path: string,
  headers: Record<string, string> = authorized(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${core.base}${path}`, { headers });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
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

interface TestClient {
  frames: ServerFrame[];
  events: () => ServerFrame[];
  subscribe: (afterSequence: number) => void;
  sendRaw: (payload: string | Buffer) => void;
  closed: () => { code: number } | undefined;
  close: () => void;
}

async function openClient(
  core: TestCore,
  options: { token?: string; path?: string } = {},
): Promise<TestClient> {
  const socket = new WebSocket(`${core.socketUrl}${options.path ?? "/ws/clients"}`, {
    headers: { authorization: `Bearer ${options.token ?? TOKEN}` },
  });

  const frames: ServerFrame[] = [];
  let closed: { code: number } | undefined;

  socket.on("message", (data: Buffer) => {
    frames.push(JSON.parse(data.toString("utf8")) as ServerFrame);
  });
  socket.on("close", (code: number) => {
    closed = { code };
  });
  socket.on("error", () => undefined);

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  return {
    frames,
    events: () => frames.filter((frame) => frame.kind === "event"),
    subscribe(afterSequence) {
      socket.send(
        JSON.stringify({ kind: "subscribe", envelopeVersion: ENVELOPE_VERSION, afterSequence }),
      );
    },
    sendRaw(payload) {
      socket.send(payload);
    },
    closed: () => closed,
    close: () => {
      socket.close();
    },
  };
}

/** Creates an active Objective and returns it. Used by several tests as setup. */
async function activeObjective(core: TestCore, suffix: string): Promise<ObjectiveRecord> {
  const created = await command(core, "objective.create", {
    idempotencyKey: `create-${suffix}`,
    title: "Ship the kernel",
    intent: "Prove the headless loop end to end",
    status: "draft",
    identityId: "vesper",
    protocolIds: [],
  });

  const objective = created.body as unknown as ObjectiveRecord;

  await command(core, "objective.change_status", {
    idempotencyKey: `activate-${suffix}`,
    objectiveId: objective.id,
    expectedRevision: objective.revision,
    status: "active",
  });

  return objective;
}

describe("headless kernel loop", () => {
  it("creates and activates an Objective, links a Mission, and records a decision", async () => {
    const core = await startTestCore();

    const created = await command(core, "objective.create", {
      idempotencyKey: "k-create",
      title: "Ship the kernel",
      intent: "Prove the headless loop end to end",
      status: "draft",
      identityId: "vesper",
      protocolIds: ["noir"],
    });

    expect(created.status).toBe(200);
    const objective = created.body as unknown as ObjectiveRecord;
    expect(objective.status).toBe("draft");
    expect(objective.revision).toBe(0);
    expect(objective.activatedAt).toBeUndefined();

    const activated = await command(core, "objective.change_status", {
      idempotencyKey: "k-activate",
      objectiveId: objective.id,
      expectedRevision: 0,
      status: "active",
    });

    expect(activated.status).toBe(200);
    const active = activated.body as unknown as ObjectiveRecord;
    expect(active.status).toBe("active");
    expect(active.revision).toBe(1);
    expect(active.activatedAt).toBeDefined();

    const missionResponse = await command(core, "mission.create", {
      idempotencyKey: "k-mission",
      objectiveId: objective.id,
      title: "Publish the release note",
      operationClass: "publish",
      hostPolicy: "core_only",
    });

    expect(missionResponse.status).toBe(200);
    const mission = missionResponse.body as unknown as MissionRecord;
    expect(mission.objectiveId).toBe(objective.id);
    expect(mission.status).toBe("draft");

    const linked = await read(core, `/objectives/${objective.id}/missions`);
    expect((linked.body.missions as MissionRecord[]).map((entry) => entry.id)).toEqual([
      mission.id,
    ]);

    const decision = await command(core, "authority.request", {
      idempotencyKey: "k-authority",
      objectiveId: objective.id,
      missionId: mission.id,
      actorId: "vesper",
      operationClass: "publish",
      capability: "release.publish",
      target: { type: "repository", id: "noctis-os" },
      consequenceSummary: "Publishes the release note publicly",
      reversibility: "partially_reversible",
    });

    expect(decision.status).toBe(200);
    expect(decision.body.outcome).toBe("require_confirmation");
    expect(decision.body.policyId).toBe("baseline.v1");

    const events = await read(core, "/events?after=0");
    expect((events.body.events as Array<{ type: string }>).map((event) => event.type)).toEqual([
      "objective.created.v1",
      "objective.activated.v1",
      "mission.created.v1",
      "authority.decision_recorded.v1",
    ]);
    expect(events.body.latestSequence).toBe(4);

    const diagnostics = await read(core, "/diagnostics");
    expect(diagnostics.body.latestSequence).toBe(4);
    // Migration 0002 added the node pairing table and the job result columns.
    expect(diagnostics.body.schemaVersion).toBe(2);
  });

  it("allows a local reversible edit only while its Objective is active", async () => {
    const core = await startTestCore();
    const objective = await activeObjective(core, "scope");

    const inScope = await command(core, "authority.request", {
      idempotencyKey: "a-1",
      objectiveId: objective.id,
      actorId: "vesper",
      operationClass: "local_reversible_edit",
      capability: "fs.write",
      target: { type: "file", id: "notes.md" },
      consequenceSummary: "Writes a local draft",
      reversibility: "reversible",
    });

    const unscoped = await command(core, "authority.request", {
      idempotencyKey: "a-2",
      actorId: "vesper",
      operationClass: "local_reversible_edit",
      capability: "fs.write",
      target: { type: "file", id: "notes.md" },
      consequenceSummary: "Writes a local draft",
      reversibility: "reversible",
    });

    expect(inScope.body.outcome).toBe("allow");
    expect(unscoped.body.outcome).toBe("require_confirmation");
  });

  it("returns the original result when a command is retried with its key", async () => {
    const core = await startTestCore();
    const body = {
      idempotencyKey: "retry-me",
      title: "Ship the kernel",
      intent: "Prove the headless loop end to end",
      status: "draft",
      identityId: "vesper",
      protocolIds: [],
    };

    const first = await command(core, "objective.create", body);
    const second = await command(core, "objective.create", body);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const list = await read(core, "/objectives");
    expect(list.body.objectives).toHaveLength(1);

    const events = await read(core, "/events?after=0");
    expect(events.body.events).toHaveLength(1);
  });
});

describe("identity activation", () => {
  it("creates a thread on first activation and reuses it on the second", async () => {
    const core = await startTestCore();

    const first = await command(core, "identity.activate", {
      idempotencyKey: "activate-vesper-1",
      identityId: "vesper",
    });

    expect(first.status).toBe(200);
    expect(first.body.activeIdentityId).toBe("vesper");
    const thread = first.body.thread as { id: string; revision: number };
    expect(thread.revision).toBe(0);

    const second = await command(core, "identity.activate", {
      idempotencyKey: "activate-vesper-2",
      identityId: "vesper",
    });

    expect(second.status).toBe(200);
    expect((second.body.thread as { id: string }).id).toBe(thread.id);

    const list = await read(core, "/identities");
    expect(list.body.activeIdentityId).toBe("vesper");
    expect(list.body.threads).toHaveLength(1);
  });

  it("keeps Vesper's and Jester's threads separate across switches", async () => {
    const core = await startTestCore();

    const vesper = await command(core, "identity.activate", {
      idempotencyKey: "switch-vesper",
      identityId: "vesper",
    });
    const jester = await command(core, "identity.activate", {
      idempotencyKey: "switch-jester",
      identityId: "jester",
    });
    const backToVesper = await command(core, "identity.activate", {
      idempotencyKey: "switch-vesper-again",
      identityId: "vesper",
    });

    const vesperThread = vesper.body.thread as { id: string };
    const jesterThread = jester.body.thread as { id: string };
    const restoredThread = backToVesper.body.thread as { id: string };

    expect(jesterThread.id).not.toBe(vesperThread.id);
    expect(restoredThread.id).toBe(vesperThread.id);
    expect(backToVesper.body.activeIdentityId).toBe("vesper");

    const list = await read(core, "/identities");
    expect(list.body.activeIdentityId).toBe("vesper");
    expect(list.body.threads).toHaveLength(2);
  });

  it("replays the original activation for a repeated idempotency key", async () => {
    const core = await startTestCore();
    const body = { idempotencyKey: "replay-me", identityId: "jester" };

    const first = await command(core, "identity.activate", body);
    const second = await command(core, "identity.activate", body);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});

describe("client replay over /ws/clients", () => {
  it("replays from the requested sequence and then streams live", async () => {
    const core = await startTestCore();
    const objective = await activeObjective(core, "replay");

    const client = await openClient(core);
    client.subscribe(0);
    await waitFor(() => client.events().length === 2, "backfill");

    await command(core, "mission.create", {
      idempotencyKey: "m-live",
      objectiveId: objective.id,
      title: "Live mission",
      operationClass: "read_inspect",
      hostPolicy: "core_only",
    });

    await waitFor(() => client.events().length === 3, "live event");

    const sequences = client
      .events()
      .map((frame) => (frame.kind === "event" ? frame.event.sequence : -1));

    expect(sequences).toEqual([1, 2, 3]);
    client.close();
  });

  it("resumes from the last sequence a disconnected client saw", async () => {
    const core = await startTestCore();
    const objective = await activeObjective(core, "resume");

    const first = await openClient(core);
    first.subscribe(0);
    await waitFor(() => first.events().length === 2, "first backfill");
    first.close();

    // Committed while nothing is listening. The ledger, not a buffer, is what
    // makes this recoverable.
    await command(core, "mission.create", {
      idempotencyKey: "m-offline",
      objectiveId: objective.id,
      title: "Missed while offline",
      operationClass: "read_inspect",
      hostPolicy: "core_only",
    });

    const resumed = await openClient(core);
    resumed.subscribe(2);
    await waitFor(() => resumed.events().length === 1, "resumed backfill");

    const frame = resumed.events()[0];
    expect(frame?.kind === "event" && frame.event.sequence).toBe(3);
    expect(frame?.kind === "event" && frame.event.type).toBe("mission.created.v1");
    resumed.close();
  });

  it("reports a gap when a client's cursor is ahead of the ledger", async () => {
    const core = await startTestCore();
    await activeObjective(core, "gap");

    const client = await openClient(core);
    client.subscribe(99);
    await waitFor(() => client.frames.length > 0, "gap frame");

    expect(client.frames[0]).toEqual({
      kind: "gap",
      envelopeVersion: ENVELOPE_VERSION,
      fromSequence: 2,
      toSequence: 99,
    });
    client.close();
  });

  it("delivers every committed event exactly once across a subscribe boundary", async () => {
    const core = await startTestCore();
    const objective = await activeObjective(core, "once");

    const client = await openClient(core);
    client.subscribe(0);

    for (let index = 0; index < 5; index += 1) {
      await command(core, "mission.create", {
        idempotencyKey: `m-${String(index)}`,
        objectiveId: objective.id,
        title: `Mission ${String(index)}`,
        operationClass: "read_inspect",
        hostPolicy: "core_only",
      });
    }

    await waitFor(() => client.events().length === 7, "all events");

    const sequences = client
      .events()
      .map((frame) => (frame.kind === "event" ? frame.event.sequence : -1));

    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(sequences).size).toBe(sequences.length);
    client.close();
  });
});

describe("refusals", () => {
  it("rejects a stale revision", async () => {
    const core = await startTestCore();
    const objective = await activeObjective(core, "stale");

    const stale = await command(core, "objective.change_status", {
      idempotencyKey: "stale-1",
      objectiveId: objective.id,
      expectedRevision: 0,
      status: "paused",
    });

    expect(stale.status).toBe(409);
    expect((stale.body.error as { code: string }).code).toBe("revision_conflict");
  });

  it("rejects a transition the state machine does not allow", async () => {
    const core = await startTestCore();
    const created = await command(core, "objective.create", {
      idempotencyKey: "forbidden-1",
      title: "Ship the kernel",
      intent: "Prove the headless loop end to end",
      status: "draft",
      identityId: "vesper",
      protocolIds: [],
    });
    const objective = created.body as unknown as ObjectiveRecord;

    const forbidden = await command(core, "objective.change_status", {
      idempotencyKey: "forbidden-2",
      objectiveId: objective.id,
      expectedRevision: 0,
      status: "completed",
    });

    expect(forbidden.status).toBe(409);
    expect((forbidden.body.error as { code: string }).code).toBe("forbidden_transition");
  });

  it("refuses a Mission for an Objective that does not exist", async () => {
    const core = await startTestCore();

    const orphan = await command(core, "mission.create", {
      idempotencyKey: "orphan-1",
      objectiveId: "0199a000-0000-7000-8000-0000000000ff",
      title: "Orphan",
      operationClass: "read_inspect",
      hostPolicy: "core_only",
    });

    expect(orphan.status).toBe(404);
  });

  it.each([
    ["a missing field", "objective.create", { idempotencyKey: "x", title: "T" }],
    [
      "an unknown field",
      "objective.create",
      {
        idempotencyKey: "x",
        title: "T",
        intent: "I",
        status: "draft",
        identityId: "vesper",
        surprise: true,
      },
    ],
    [
      "an initial status that is not draft or suggested",
      "objective.create",
      { idempotencyKey: "x", title: "T", intent: "I", status: "active", identityId: "vesper" },
    ],
    [
      "a named host with no host",
      "mission.create",
      {
        idempotencyKey: "x",
        objectiveId: "0199a000-0000-7000-8000-0000000000ff",
        title: "T",
        operationClass: "read_inspect",
        hostPolicy: "named_host",
      },
    ],
    [
      "an empty idempotency key",
      "objective.create",
      { idempotencyKey: "", title: "T", intent: "I", status: "draft", identityId: "vesper" },
    ],
  ])("rejects %s with 400", async (_label, name, body) => {
    const core = await startTestCore();
    const response = await command(core, name, body);

    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe("invalid_request");
  });
});

describe("hostile input", () => {
  it.each([
    ["no header", {}],
    ["a wrong token", { authorization: `Bearer ${"z".repeat(32)}` }],
    ["a truncated token", { authorization: `Bearer ${TOKEN.slice(0, 16)}` }],
    ["the token without a scheme", { authorization: TOKEN }],
  ])("refuses an authenticated route with %s", async (_label, headers) => {
    const core = await startTestCore();

    expect((await read(core, "/ready", headers)).status).toBe(401);
    expect((await read(core, "/objectives", headers)).status).toBe(401);
    expect((await command(core, "objective.create", { idempotencyKey: "x" }, headers)).status).toBe(
      401,
    );
  });

  it("serves liveness without a token but nothing else", async () => {
    const core = await startTestCore();

    expect((await read(core, "/health", {})).status).toBe(200);
    expect((await read(core, "/diagnostics", {})).status).toBe(401);
  });

  it("refuses a browser origin that is not allowlisted, before checking the token", async () => {
    const core = await startTestCore();

    const response = await command(
      core,
      "objective.create",
      { idempotencyKey: "x" },
      authorized({ origin: "https://evil.example" }),
    );

    expect(response.status).toBe(403);
    expect((response.body.error as { code: string }).code).toBe("forbidden_origin");
  });

  it("accepts an allowlisted origin", async () => {
    const core = await startTestCore({ allowedOrigins: ["https://ok.example"] });

    const response = await read(core, "/ready", authorized({ origin: "https://ok.example" }));

    expect(response.status).toBe(200);
  });

  it.each([
    ["an unknown path", "/wat"],
    ["a non-uuid resource id", "/objectives/not-a-uuid"],
    ["a traversal-shaped id", "/objectives/..%2f..%2fetc"],
    ["an unknown nested path", "/objectives/0199a000-0000-7000-8000-0000000000ff/secrets"],
  ])("answers 404 for %s", async (_label, path) => {
    const core = await startTestCore();
    const response = await read(core, path);

    expect(response.status).toBe(404);
  });

  it("answers 404 for an unregistered command rather than executing anything", async () => {
    const core = await startTestCore();

    expect((await command(core, "objective.delete", { idempotencyKey: "x" })).status).toBe(404);
    expect((await command(core, "constructor", {})).status).toBe(404);
    expect((await command(core, "__proto__", {})).status).toBe(404);
  });

  it("refuses a body that is not declared as JSON", async () => {
    const core = await startTestCore();

    const response = await fetch(`${core.base}/commands/objective.create`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
      body: "{}",
    });

    expect(response.status).toBe(415);
  });

  it("refuses a body that is not JSON at all", async () => {
    const core = await startTestCore();

    const response = await fetch(`${core.base}/commands/objective.create`, {
      method: "POST",
      headers: authorized(),
      body: "not json",
    });

    expect(response.status).toBe(400);
  });

  it("refuses an oversized body without reading it", async () => {
    const core = await startTestCore();

    const response = await fetch(`${core.base}/commands/objective.create`, {
      method: "POST",
      headers: authorized(),
      body: JSON.stringify({ idempotencyKey: "x", intent: "y".repeat(2 * 1024 * 1024) }),
    });

    expect(response.status).toBe(413);
  });

  it("echoes a supplied correlation id and invents one otherwise", async () => {
    const core = await startTestCore();
    const supplied = "0199a000-0000-7000-8000-0000000000c1";

    const withId = await fetch(`${core.base}/health`, {
      headers: { "x-correlation-id": supplied },
    });
    const without = await fetch(`${core.base}/health`, {
      headers: { "x-correlation-id": "not-a-uuid" },
    });

    expect(withId.headers.get("x-correlation-id")).toBe(supplied);
    expect(without.headers.get("x-correlation-id")).not.toBe("not-a-uuid");
    expect(without.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never returns an internal detail in an error body", async () => {
    const core = await startTestCore();
    const response = await command(core, "objective.create", { idempotencyKey: "x" });

    expect(JSON.stringify(response.body)).not.toMatch(/SQLITE|at Object|node:|\.ts:/);
  });
});

describe("hostile sockets", () => {
  it.each([
    ["a wrong token", { token: "z".repeat(32) }],
    ["no matching path", { path: "/ws/anything" }],
    ["the node realm, which this server does not serve", { path: "/ws/nodes" }],
  ])("refuses a socket upgrade with %s", async (_label, options) => {
    const core = await startTestCore();

    await expect(openClient(core, options)).rejects.toThrow();
  });

  it.each([
    ["a frame that is not JSON", "definitely not json"],
    ["an unknown frame kind", JSON.stringify({ kind: "shutdown", envelopeVersion: 1 })],
    [
      "an unsupported envelope version",
      JSON.stringify({ kind: "subscribe", envelopeVersion: 2, afterSequence: 0 }),
    ],
    [
      "a negative sequence",
      JSON.stringify({ kind: "subscribe", envelopeVersion: 1, afterSequence: -1 }),
    ],
    [
      "an unknown field",
      JSON.stringify({ kind: "subscribe", envelopeVersion: 1, afterSequence: 0, replay: "all" }),
    ],
  ])("closes the socket on %s", async (_label, payload) => {
    const core = await startTestCore();
    const client = await openClient(core);

    client.sendRaw(payload);
    await waitFor(() => client.closed() !== undefined, "socket close");

    expect(client.closed()?.code).toBe(1008);
    expect(client.events()).toHaveLength(0);
  });

  it("closes the socket on a binary frame", async () => {
    const core = await startTestCore();
    const client = await openClient(core);

    client.sendRaw(Buffer.from([0x00, 0x01]));
    await waitFor(() => client.closed() !== undefined, "socket close");

    expect(client.closed()?.code).toBe(1008);
  });

  it("closes a socket that tries to subscribe twice", async () => {
    const core = await startTestCore();
    await activeObjective(core, "double");

    const client = await openClient(core);
    client.subscribe(0);
    await waitFor(() => client.events().length === 2, "backfill");
    client.subscribe(0);

    await waitFor(() => client.closed() !== undefined, "socket close");
    expect(client.closed()?.code).toBe(1008);
    expect(client.events()).toHaveLength(2);
  });
});
