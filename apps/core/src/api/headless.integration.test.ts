import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MissionRecord, ObjectiveRecord, ServerFrame } from "@noctis/contracts";
import { createTestVault } from "@noctis/test-kit";
import { ENVELOPE_VERSION } from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";
import webpush from "web-push";
import { WebSocket } from "ws";

import { getApprovalByAskId } from "../authority/service.js";
import type { CoreConfig } from "../config/server.js";
import { createLogger } from "../logging.js";
import type { RunningCore } from "../server.js";
import { startCore } from "../server.js";

import {
  LOGIN_PATH,
  LOGOUT_PATH,
  PUSH_KEY_PATH,
  PUSH_SUBSCRIBE_PATH,
  PUSH_UNSUBSCRIBE_PATH,
} from "./http.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

interface TestCore {
  core: RunningCore;
  base: string;
  socketUrl: string;
}

const started: Array<{ core: RunningCore; directory: string }> = [];

async function startTestCore(
  overrides: Partial<CoreConfig> = {},
  env: Record<string, string | undefined> = {},
): Promise<TestCore> {
  const directory = mkdtempSync(join(tmpdir(), "noctis-core-"));
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

  const core = await startCore({
    config,
    env,
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

/**
 * Exchanges the core token for a session cookie, the way a browser does. Returns
 * the two halves a page then holds: the cookie the browser replays on its own,
 * and the CSRF value it has to attach to every mutation by hand.
 */
async function login(core: TestCore, token: string = TOKEN): Promise<Response> {
  return fetch(`${core.base}${LOGIN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

async function session(core: TestCore): Promise<{ cookie: string; csrf: string }> {
  const response = await login(core);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const { csrf } = (await response.json()) as { csrf: string };

  return { cookie: setCookie.split(";")[0] ?? "", csrf };
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
    // 0002 added node pairing and job results; 0003 the Surface uniqueness;
    // 0004 the six Vault tables Section 4.1 lists; 0005 the consequence
    // boundary columns, source semantics, and artifact lineage; 0006 turns,
    // sessions, provider decisions, and one thread per Objective; 0007 the
    // browser sessions a cookie is verified against; 0008 the push
    // subscriptions that die with the session they belong to.
    expect(diagnostics.body.schemaVersion).toBe(8);
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

describe("the Vault graph read", () => {
  const vaults: string[] = [];

  afterEach(() => {
    while (vaults.length > 0) {
      rmSync(vaults.pop() as string, { recursive: true, force: true });
    }
  });

  async function indexedCore(): Promise<TestCore> {
    const vault = mkdtempSync(join(tmpdir(), "noctis-graph-vault-"));
    createTestVault(vault);
    vaults.push(vault);

    const core = await startTestCore({}, { NOCTIS_VAULT_ROOT: vault });
    const reindex = await command(core, "vault.reindex", { idempotencyKey: "graph-reindex" });

    expect(reindex.status).toBe(200);

    return core;
  }

  it("returns every entity, its edges, and how many there are in total", async () => {
    const graph = await read(await indexedCore(), "/vault/graph");
    const nodes = graph.body.nodes as Array<{ id: string; x: number | null }>;

    expect(graph.status).toBe(200);
    expect(nodes.length).toBeGreaterThan(0);
    expect(graph.body.total).toBe(nodes.length);
    expect(graph.body.truncated).toBe(false);
    // Coordinates come from `vault_layout`; a null here means the renderer
    // would have to invent a position, which is the instability Section 7 bans.
    expect(nodes.filter((node) => node.x === null)).toHaveLength(0);
  });

  it("THE GATE: says so when the graph is larger than the read, rather than truncating in silence", async () => {
    const core = await indexedCore();
    const full = await read(core, "/vault/graph");
    const total = full.body.total as number;

    const clipped = await read(core, "/vault/graph?limit=2");

    expect(clipped.status).toBe(200);
    expect((clipped.body.nodes as unknown[]).length).toBe(2);
    expect(clipped.body.total).toBe(total);
    // The defect this replaces: the old read returned the slice and nothing else,
    // so a client could not tell a small Vault from a clipped large one.
    expect(clipped.body.truncated).toBe(true);
  });

  it("THE GATE: never returns an edge pointing at a node it did not return", async () => {
    const clipped = await read(await indexedCore(), "/vault/graph?limit=3");
    const ids = new Set((clipped.body.nodes as Array<{ id: string }>).map((node) => node.id));

    for (const edge of clipped.body.edges as Array<{ source: string; target: string }>) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  });

  it("refuses a limit above the graph ceiling instead of quietly clamping it", async () => {
    const refused = await read(await indexedCore(), "/vault/graph?limit=5001");

    expect(refused.status).toBe(400);
    expect((refused.body.error as { message: string }).message).toContain("1-5000");
  });
});

/* -------------------------------------------------------------------------- */
/* Phase 8: the consequence boundary.                                         */
/* -------------------------------------------------------------------------- */

let phase8Keys = 0;

/** A fresh idempotency key. A second submit is a second key — that is the point. */
function newKey(label: string): string {
  phase8Keys += 1;

  return `${label}-${String(phase8Keys)}`;
}

async function requestAuthorityFor(
  core: TestCore,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await command(core, "authority.request", {
    idempotencyKey: newKey("req"),
    actorId: "vesper",
    operationClass: "publish",
    capability: "vinted.publish",
    target: { type: "listing", id: "vinted-4821" },
    consequenceSummary: "Publish the listing to Vinted",
    reversibility: "partially_reversible",
    ...overrides,
  });

  expect(response.status).toBe(200);

  return response.body;
}

describe("THE GATE: preparation cannot commit itself", () => {
  it("refuses to execute a decision nobody confirmed", async () => {
    const core = await startTestCore();
    const decision = await requestAuthorityFor(core);

    expect(decision.outcome).toBe("require_confirmation");

    const executed = await command(core, "authority.execute", {
      idempotencyKey: newKey("exec"),
      requestId: decision.requestId,
      evidenceVersion: 1,
      evidence: { url: "https://vinted.example/4821" },
    });

    expect(executed.status).toBe(403);
    expect(
      (executed.body.error as { details: { reasonCodes: string[] } }).details.reasonCodes,
    ).toContain("not_confirmed");

    const approval = await read(core, `/approvals/${String(decision.requestId)}`);

    expect(approval.body.executedAt).toBeUndefined();
  });

  it("executes once confirmed, and records the evidence the external system gave", async () => {
    const core = await startTestCore();
    const decision = await requestAuthorityFor(core);

    const confirmed = await command(core, "authority.confirm", {
      idempotencyKey: newKey("confirm"),
      requestId: decision.requestId,
    });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.confirmedAt).toBeDefined();
    expect(confirmed.body.executedAt).toBeUndefined();

    const executed = await command(core, "authority.execute", {
      idempotencyKey: newKey("exec"),
      requestId: decision.requestId,
      evidenceVersion: 1,
      evidence: { url: "https://vinted.example/4821", status: "published" },
    });

    expect(executed.status).toBe(200);
    expect(executed.body.executedAt).toBeDefined();
    expect(executed.body.executionEvidence).toEqual({
      url: "https://vinted.example/4821",
      status: "published",
    });
  });

  it("THE GATE: a duplicate submit cannot repeat an external consequence", async () => {
    const core = await startTestCore();
    const decision = await requestAuthorityFor(core);

    await command(core, "authority.confirm", {
      idempotencyKey: newKey("confirm"),
      requestId: decision.requestId,
    });

    const first = await command(core, "authority.execute", {
      idempotencyKey: newKey("exec"),
      requestId: decision.requestId,
      evidenceVersion: 1,
      evidence: { attempt: 1 },
    });

    // A *different* key, which is what a second click actually produces. An
    // idempotency key alone cannot stop this: the second submit has a new one.
    const second = await command(core, "authority.execute", {
      idempotencyKey: newKey("exec"),
      requestId: decision.requestId,
      evidenceVersion: 1,
      evidence: { attempt: 2 },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(
      (second.body.error as { details: { reasonCodes: string[] } }).details.reasonCodes,
    ).toContain("already_executed");

    const approval = await read(core, `/approvals/${String(decision.requestId)}`);

    // The first execution's evidence stands. The second never happened.
    expect(approval.body.executionEvidence).toEqual({ attempt: 1 });
  });

  it("answers a retry of the same submit with the same result", async () => {
    const core = await startTestCore();
    const decision = await requestAuthorityFor(core);

    await command(core, "authority.confirm", {
      idempotencyKey: newKey("confirm"),
      requestId: decision.requestId,
    });

    const key = newKey("exec");
    const body = {
      idempotencyKey: key,
      requestId: decision.requestId,
      evidenceVersion: 1,
      evidence: { attempt: 1 },
    };

    const first = await command(core, "authority.execute", body);
    const retry = await command(core, "authority.execute", body);

    expect(first.status).toBe(200);
    // A lost response is retried with the key it already had, and gets the
    // original answer rather than a refusal it cannot act on.
    expect(retry.status).toBe(200);
    expect(retry.body.executedAt).toBe(first.body.executedAt);
  });

  it("THE GATE: a click is not a typed confirmation", async () => {
    const core = await startTestCore();
    const decision = await requestAuthorityFor(core, {
      operationClass: "spend",
      capability: "provider.purchase",
      target: { type: "provider", id: "suno" },
      consequenceSummary: "Buy a Suno credit pack",
      reversibility: "irreversible",
      estimatedCostGbp: 8,
    });

    expect(decision.outcome).toBe("require_typed_confirmation");
    expect(decision.confirmationPhrase).toBe("SPEND GBP 8.00 ON provider:suno");

    const clicked = await command(core, "authority.confirm", {
      idempotencyKey: newKey("confirm"),
      requestId: decision.requestId,
    });

    const nearMiss = await command(core, "authority.confirm", {
      idempotencyKey: newKey("confirm"),
      requestId: decision.requestId,
      typedConfirmation: "spend gbp 8.00 on provider:suno",
    });

    const typed = await command(core, "authority.confirm", {
      idempotencyKey: newKey("confirm"),
      requestId: decision.requestId,
      typedConfirmation: decision.confirmationPhrase,
    });

    expect(clicked.status).toBe(403);
    expect(nearMiss.status).toBe(403);
    expect(typed.status).toBe(200);
    expect(typed.body.confirmedAt).toBeDefined();
  });

  it("never lets an unrecognised operation class reach the approval queue at all", async () => {
    const core = await startTestCore();

    const requested = await command(core, "authority.request", {
      idempotencyKey: newKey("req"),
      actorId: "vesper",
      operationClass: "not_a_real_class",
      capability: "vinted.publish",
      target: { type: "listing", id: "vinted-4821" },
      consequenceSummary: "Publish the listing to Vinted",
      reversibility: "partially_reversible",
    });

    // The contract refuses it before the policy is consulted, which is why
    // `evaluateAuthority`'s fail-closed `deny` is unreachable from the API and
    // is proven in `evaluate.test.ts` instead. Two gates, and the outer one
    // fires first: an operation class Noctis does not define is not a decision
    // to be made, it is a request that does not parse.
    expect(requested.status).toBe(400);

    const approvals = await read(core, "/approvals");

    expect(approvals.body.approvals).toHaveLength(0);
  });

  it("refuses to confirm or execute an approval that does not exist", async () => {
    const core = await startTestCore();
    const missing = "01941f29-7c00-7000-8000-0000000009ff";

    const confirmed = await command(core, "authority.confirm", {
      idempotencyKey: newKey("confirm"),
      requestId: missing,
    });
    const executed = await command(core, "authority.execute", {
      idempotencyKey: newKey("exec"),
      requestId: missing,
      evidenceVersion: 1,
      evidence: {},
    });

    expect(confirmed.status).toBe(404);
    expect(executed.status).toBe(404);
  });
});

describe("THE GATE: a human can say no, and the executor that asked is recorded", () => {
  function reasonCodes(response: { body: Record<string, unknown> }): string[] {
    return (response.body.error as { details: { reasonCodes: string[] } }).details.reasonCodes;
  }

  async function declinedEvents(core: TestCore): Promise<number> {
    const events = await read(core, "/events?after=0");

    return (events.body.events as Array<{ type: string }>).filter(
      (event) => event.type === "authority.declined.v1",
    ).length;
  }

  it("records who declined and when, and says so exactly once", async () => {
    const core = await startTestCore();
    const decision = await requestAuthorityFor(core);

    const declined = await command(core, "authority.decline", {
      idempotencyKey: newKey("decline"),
      requestId: decision.requestId,
      reason: "Not this listing",
    });

    expect(declined.status).toBe(200);
    expect(declined.body.declinedAt).toBeDefined();
    expect(declined.body.declinedBy).toBe("local");
    expect(declined.body.confirmedAt).toBeUndefined();
    expect(await declinedEvents(core)).toBe(1);

    // A second no with a new key is not a second act. Same record, no event.
    const again = await command(core, "authority.decline", {
      idempotencyKey: newKey("decline"),
      requestId: decision.requestId,
    });

    expect(again.status).toBe(200);
    expect(again.body.declinedAt).toBe(declined.body.declinedAt);
    expect(await declinedEvents(core)).toBe(1);
  });

  it("a declined approval can be neither confirmed nor executed", async () => {
    const core = await startTestCore();
    const decision = await requestAuthorityFor(core);

    await command(core, "authority.decline", {
      idempotencyKey: newKey("decline"),
      requestId: decision.requestId,
    });

    const confirmed = await command(core, "authority.confirm", {
      idempotencyKey: newKey("confirm"),
      requestId: decision.requestId,
    });
    const executed = await command(core, "authority.execute", {
      idempotencyKey: newKey("exec"),
      requestId: decision.requestId,
      evidenceVersion: 1,
      evidence: {},
    });

    expect(confirmed.status).toBe(403);
    expect(reasonCodes(confirmed)).toEqual(["declined"]);
    expect(executed.status).toBe(403);
    expect(reasonCodes(executed)).toEqual(["declined"]);
  });

  it("a no after the consequence happened changes nothing", async () => {
    const core = await startTestCore();
    const decision = await requestAuthorityFor(core);

    await command(core, "authority.confirm", {
      idempotencyKey: newKey("confirm"),
      requestId: decision.requestId,
    });
    await command(core, "authority.execute", {
      idempotencyKey: newKey("exec"),
      requestId: decision.requestId,
      evidenceVersion: 1,
      evidence: {},
    });

    const declined = await command(core, "authority.decline", {
      idempotencyKey: newKey("decline"),
      requestId: decision.requestId,
    });

    expect(declined.status).toBe(403);
    expect(reasonCodes(declined)).toEqual(["already_executed"]);
  });

  it("remembers which job asked, and finds the approval by its ask", async () => {
    const core = await startTestCore();
    const nodeJobId = "01941f29-7c00-7000-8000-00000000a0b1";
    const askId = "01941f29-7c00-7000-8000-00000000a0b2";
    const at = "2026-09-12T00:00:00.000Z";

    // `approvals.node_job_id` is a foreign key; an ask only comes from a job that exists.
    core.core.kernel.db
      .prepare(
        `INSERT INTO node_jobs (id, capability, status, idempotency_key, payload_version,
                                payload_json, created_at, updated_at)
         VALUES (?, 'runtime.turn', 'running', ?, 1, '{}', ?, ?)`,
      )
      .run(nodeJobId, newKey("job"), at, at);

    const key = newKey("ask");
    const decision = await requestAuthorityFor(core, { idempotencyKey: key, nodeJobId, askId });
    const approval = await read(core, `/approvals/${String(decision.requestId)}`);

    expect(approval.body.nodeJobId).toBe(nodeJobId);
    expect(approval.body.askId).toBe(askId);
    expect(getApprovalByAskId(core.core.kernel.db, askId)?.id).toBe(decision.requestId);

    // The ask id is the idempotency key: a node that reconnects re-asks under
    // the same key and gets the answer it already had, not a second decision.
    const replayed = await requestAuthorityFor(core, { idempotencyKey: key, nodeJobId, askId });

    expect(replayed.requestId).toBe(decision.requestId);
    expect(replayed.decidedAt).toBe(decision.decidedAt);
  });
});

describe("THE GATE: standing permissions are narrow and revocable", () => {
  async function grant(
    core: TestCore,
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await command(core, "authority.grant_permission", {
      idempotencyKey: newKey("grant"),
      actorId: "vesper",
      capability: "vinted.publish",
      operationClass: "publish",
      constraints: { targetType: "listing", targetIds: ["vinted-4821"] },
      ...overrides,
    });

    expect(response.status).toBe(200);

    return response.body;
  }

  it("upgrades exactly the target it names, and nothing beside it", async () => {
    const core = await startTestCore();
    await grant(core);

    const named = await requestAuthorityFor(core);
    const beside = await requestAuthorityFor(core, {
      target: { type: "listing", id: "vinted-9999" },
    });

    expect(named.outcome).toBe("allow");
    expect(named.permissionId).toBeDefined();
    expect(beside.outcome).toBe("require_confirmation");
    expect(beside.permissionId).toBeUndefined();
  });

  it("stops upgrading the moment it is revoked, and says why it was", async () => {
    const core = await startTestCore();
    const permission = await grant(core);

    expect((await requestAuthorityFor(core)).outcome).toBe("allow");

    const revoked = await command(core, "authority.revoke_permission", {
      idempotencyKey: newKey("revoke"),
      permissionId: permission.id,
      reason: "the listing was already sold",
    });

    expect(revoked.status).toBe(200);
    expect((await requestAuthorityFor(core)).outcome).toBe("require_confirmation");

    const listed = await read(core, "/permissions");
    const rows = listed.body.permissions as Array<Record<string, unknown>>;

    // Revoked, still listed, still explaining itself: a permission that
    // vanished would leave the decisions it once upgraded unaccountable.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeDefined();
    expect(rows[0]?.revokedReason).toBe("the listing was already sold");
  });

  it("THE GATE: cannot be granted over a spend, however narrowly", async () => {
    const core = await startTestCore();
    await grant(core, {
      capability: "provider.purchase",
      operationClass: "spend",
      constraints: { targetType: "provider", targetIds: ["suno"] },
    });

    const decision = await requestAuthorityFor(core, {
      operationClass: "spend",
      capability: "provider.purchase",
      target: { type: "provider", id: "suno" },
      estimatedCostGbp: 8,
    });

    expect(decision.outcome).toBe("require_typed_confirmation");
    expect(decision.reasonCodes).toContain("standing_permission_ineligible_operation_class");
  });
});

describe("THE GATE: a node cannot be a way around authority", () => {
  it("enqueues work whose capability the policy allows", async () => {
    const core = await startTestCore();
    const queued = await command(core, "node.job_enqueue", {
      idempotencyKey: newKey("job"),
      capability: "environment.inspect",
      payload: {},
    });

    expect(queued.status).toBe(200);
    expect((queued.body.job as { status: string }).status).toBe("queued");
  });

  it("refuses to queue work the policy would not allow, before the row exists", async () => {
    const core = await startTestCore();

    // `file.search` is `read_inspect` today, so this test drives the refusal
    // through the one thing the policy is sure to reject: an unknown class.
    // The capability table is what decides, and it is not the caller's to set.
    const queued = await command(core, "node.job_enqueue", {
      idempotencyKey: newKey("job"),
      capability: "not.a.capability",
      payload: {},
    });

    expect(queued.status).toBe(400);

    const jobs = await read(core, "/events");
    const names = (jobs.body.events as Array<{ type: string }>).map((event) => event.type);

    expect(names).not.toContain("node.job_queued.v1");
  });
});

describe("THE GATE: a status cannot claim more than the evidence supports", () => {
  it("keeps an external reference external until an import produces bytes", async () => {
    const core = await startTestCore();

    const external = await command(core, "artifact.record", {
      idempotencyKey: newKey("artifact"),
      kind: "external_reference",
      title: "Selected Suno song",
      uri: "https://suno.example/song/9f2",
      provenanceVersion: 1,
      provenance: { selectedIn: "a native Suno session" },
    });

    expect(external.status).toBe(200);
    expect(external.body.kind).toBe("external_reference");
    expect(external.body.checksum).toBeUndefined();

    const listedBefore = await read(core, "/artifacts");

    expect(
      (listedBefore.body.artifacts as Array<{ importedAs: unknown }>)[0]?.importedAs,
    ).toBeNull();

    const imported = await command(core, "artifact.import", {
      idempotencyKey: newKey("import"),
      artifactId: external.body.id,
      hostId: "desk",
      uri: "file:///C:/noctis/artifacts/9f2.mp3",
      checksum: "sha256:aa".padEnd(20, "b"),
    });

    expect(imported.status).toBe(200);
    expect(imported.body.kind).toBe("local_artifact");
    // Lineage, not replacement: the remote thing is still there and still says
    // what it was.
    expect(imported.body.derivedFromArtifactId).toBe(external.body.id);

    const original = await read(core, `/artifacts/${String(external.body.id)}`);

    expect(original.body.kind).toBe("external_reference");
    expect(original.body.importedAs).toBe(imported.body.id);
  });

  it("refuses a second import of the same reference", async () => {
    const core = await startTestCore();
    const external = await command(core, "artifact.record", {
      idempotencyKey: newKey("artifact"),
      kind: "external_reference",
      title: "Selected Suno song",
      uri: "https://suno.example/song/9f2",
      provenanceVersion: 1,
      provenance: {},
    });

    const body = {
      artifactId: external.body.id,
      hostId: "desk",
      uri: "file:///C:/noctis/artifacts/9f2.mp3",
      checksum: "sha256:aa".padEnd(20, "b"),
    };

    const first = await command(core, "artifact.import", {
      ...body,
      idempotencyKey: newKey("import"),
    });
    const second = await command(core, "artifact.import", {
      ...body,
      idempotencyKey: newKey("import"),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
  });

  it("says unknown before anyone has looked, and never confuses it with unavailable", async () => {
    const core = await startTestCore();

    const source = await command(core, "source.register", {
      idempotencyKey: newKey("source"),
      sourceType: "vinted",
      externalId: "listing-4821",
      freshnessSeconds: 60,
      unavailableSemantics: "unknown",
    });

    expect(source.status).toBe(200);

    const before = await read(core, `/sources/${String(source.body.id)}`);

    // Nobody has looked. That is not "no listing" and not "cannot reach Vinted".
    expect(before.body.status).toBe("unknown");
    expect(before.body.observed).toBeUndefined();

    const observed = await command(core, "source.observe", {
      idempotencyKey: newKey("observe"),
      sourceId: source.body.id,
      reachable: true,
      payloadVersion: 1,
      payload: { status: "draft" },
    });

    expect(observed.status).toBe(200);
    expect(observed.body.status).toBe("current");

    const unreachable = await command(core, "source.observe", {
      idempotencyKey: newKey("observe"),
      sourceId: source.body.id,
      reachable: false,
      payloadVersion: 1,
      payload: null,
    });

    // The source declared that an unreachable answer is not an answer, so the
    // last known value does not stand in for one.
    expect(unreachable.body.status).toBe("unknown");
  });

  it("lets a source say the last known value stands when it cannot be reached", async () => {
    const core = await startTestCore();
    const source = await command(core, "source.register", {
      idempotencyKey: newKey("source"),
      sourceType: "rss",
      externalId: "feed-1",
      freshnessSeconds: 60,
      unavailableSemantics: "last_known",
    });

    await command(core, "source.observe", {
      idempotencyKey: newKey("observe"),
      sourceId: source.body.id,
      reachable: true,
      payloadVersion: 1,
      payload: { items: 3 },
    });

    const unreachable = await command(core, "source.observe", {
      idempotencyKey: newKey("observe"),
      sourceId: source.body.id,
      reachable: false,
      payloadVersion: 1,
      payload: null,
    });

    expect(unreachable.body.status).toBe("unavailable");
  });

  it("THE GATE: shows a remembered/current conflict rather than replacing one with the other", async () => {
    const core = await startTestCore();
    const source = await command(core, "source.register", {
      idempotencyKey: newKey("source"),
      sourceType: "vinted",
      externalId: "listing-4821",
      freshnessSeconds: 3600,
      unavailableSemantics: "unknown",
    });

    await command(core, "source.observe", {
      idempotencyKey: newKey("observe"),
      sourceId: source.body.id,
      reachable: true,
      payloadVersion: 1,
      payload: { status: "draft" },
    });

    const changed = await command(core, "source.observe", {
      idempotencyKey: newKey("observe"),
      sourceId: source.body.id,
      reachable: true,
      payloadVersion: 1,
      payload: { status: "published" },
    });

    expect(changed.body.conflicted).toBe(true);
    expect((changed.body.observed as { payload: unknown }).payload).toEqual({
      status: "published",
    });
    // Both halves survive the read. Section 12.1 asks the UI to distinguish
    // remembered from current, which it cannot do if one overwrote the other.
    expect((changed.body.remembered as { payload: unknown }).payload).toEqual({
      status: "draft",
    });
  });

  it("does not call two identical observations a conflict", async () => {
    const core = await startTestCore();
    const source = await command(core, "source.register", {
      idempotencyKey: newKey("source"),
      sourceType: "vinted",
      externalId: "listing-4821",
      freshnessSeconds: 3600,
      unavailableSemantics: "unknown",
    });

    // The same payload twice: two rows, one state, and no conflict.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await command(core, "source.observe", {
        idempotencyKey: newKey("observe"),
        sourceId: source.body.id,
        reachable: true,
        payloadVersion: 1,
        payload: { status: "draft" },
      });
    }

    const state = await read(core, `/sources/${String(source.body.id)}`);

    expect(state.body.conflicted).toBe(false);
  });
});

describe("the session realm", () => {
  it("refuses a page with no credential, issues one for the right token, then serves reads and gated mutations", async () => {
    const core = await startTestCore();

    const denied = await fetch(`${core.base}/objectives`);
    expect(denied.status).toBe(401);

    const bad = await login(core, "wrong");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBe(null);

    const loginResponse = await login(core);
    expect(loginResponse.status).toBe(200);

    const setCookie = loginResponse.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
    // The value itself is never readable by a page and never logged; only that
    // the browser was handed one under the expected name.
    expect(setCookie.startsWith("noctis_session=")).toBe(true);

    const { csrf } = (await loginResponse.json()) as { csrf: string };
    const cookie = setCookie.split(";")[0] ?? "";

    expect((await fetch(`${core.base}/objectives`, { headers: { cookie } })).status).toBe(200);

    const body = JSON.stringify({
      idempotencyKey: newKey("session-objective"),
      title: "Ship the front door",
      intent: "Prove the cookie realm end to end",
      status: "draft",
      identityId: "vesper",
      protocolIds: [],
    });

    const withoutCsrf = await fetch(`${core.base}/commands/objective.create`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(withoutCsrf.status).toBe(403);

    const withCsrf = await fetch(`${core.base}/commands/objective.create`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-noctis-csrf": csrf },
      body,
    });
    expect(withCsrf.status).toBe(200);

    const loggedOut = await fetch(`${core.base}${LOGOUT_PATH}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-noctis-csrf": csrf },
      body: "{}",
    });
    expect(loggedOut.status).toBe(200);

    expect((await fetch(`${core.base}/objectives`, { headers: { cookie } })).status).toBe(401);
  });

  it("leaves the bearer realm alone: a token still needs no csrf header, even carrying a cookie", async () => {
    const core = await startTestCore();
    // A session belonging to someone else, attached to a bearer mutation that
    // sends no CSRF header. The token is answered on its own merits, so the
    // cookie neither helps nor hinders.
    const foreign = await session(core);

    const created = await command(
      core,
      "objective.create",
      {
        idempotencyKey: newKey("bearer-still-works"),
        title: "Ship the kernel",
        intent: "The native shell is unaffected",
        status: "draft",
        identityId: "vesper",
        protocolIds: [],
      },
      authorized({ cookie: foreign.cookie }),
    );

    expect(created.status).toBe(200);
  });

  it("refuses one session's csrf value presented with another session's cookie", async () => {
    const core = await startTestCore();
    const mine = await session(core);
    const theirs = await session(core);

    const crossed = await fetch(`${core.base}/commands/objective.create`, {
      method: "POST",
      headers: {
        cookie: mine.cookie,
        "content-type": "application/json",
        "x-noctis-csrf": theirs.csrf,
      },
      body: JSON.stringify({
        idempotencyKey: newKey("crossed"),
        title: "Never created",
        intent: "The csrf value belongs to another session",
        status: "draft",
        identityId: "vesper",
        protocolIds: [],
      }),
    });

    expect(crossed.status).toBe(403);
  });
});

describe("the session realm in its deployed shape", () => {
  // Every other test in this file reaches the core through Node's `fetch`,
  // which sends no Origin header, so the origin gate never fires. A real page
  // sends one on every request — including its own same-origin POST — and the
  // gate runs before the login exemption. These two cases are the only ones
  // that exercise the configuration the front door actually ships under.
  const ORIGIN = "https://noctis.example";

  async function loginFrom(core: TestCore, origin: string): Promise<Response> {
    return fetch(`${core.base}${LOGIN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ token: TOKEN }),
    });
  }

  it("logs a browser in when it sends the Origin the core allows", async () => {
    const core = await startTestCore({ allowedOrigins: [ORIGIN] });

    const response = await loginFrom(core, ORIGIN);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie") ?? "").toContain("HttpOnly");

    const { csrf } = (await response.json()) as { csrf: string };
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    // And the session it issued works from that origin for the whole round
    // trip, read and gated mutation alike.
    const objectives = await fetch(`${core.base}/objectives`, {
      headers: { cookie, origin: ORIGIN },
    });
    expect(objectives.status).toBe(200);

    const created = await fetch(`${core.base}/commands/objective.create`, {
      method: "POST",
      headers: {
        cookie,
        origin: ORIGIN,
        "content-type": "application/json",
        "x-noctis-csrf": csrf,
      },
      body: JSON.stringify({
        idempotencyKey: newKey("origin-objective"),
        title: "Ship the front door",
        intent: "Prove the realm under its real origin policy",
        status: "draft",
        identityId: "vesper",
        protocolIds: [],
      }),
    });
    expect(created.status).toBe(200);
  });

  it("refuses a login from an origin that is not allowlisted, before the login exemption", async () => {
    const core = await startTestCore({ allowedOrigins: [ORIGIN] });

    const response = await loginFrom(core, "https://evil.example");

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBe(null);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "forbidden_origin",
    );
  });

  it("refuses a browser entirely when no origin is allowlisted, which is the default", async () => {
    const core = await startTestCore();

    expect((await loginFrom(core, ORIGIN)).status).toBe(403);
  });
});

describe("the live stream", () => {
  it("streams a committed event to a logged-in browser over SSE", async () => {
    const core = await startTestCore();
    const { cookie, csrf } = await session(core);
    const controller = new AbortController();

    const stream = await fetch(`${core.base}/events/live?afterSequence=0`, {
      headers: { cookie, accept: "text/event-stream" },
      signal: controller.signal,
    });

    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();

    await fetch(`${core.base}/commands/objective.create`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-noctis-csrf": csrf },
      body: JSON.stringify({
        idempotencyKey: newKey("sse-stream"),
        title: "Ship the front door",
        intent: "Prove the SSE realm end to end",
        status: "draft",
        identityId: "vesper",
        protocolIds: [],
      }),
    });

    const decoder = new TextDecoder();
    let seen = "";

    while (!seen.includes("objective.created.v1")) {
      const chunk = await reader?.read();

      if (chunk?.done === true) {
        break;
      }

      seen += decoder.decode((chunk?.value as Uint8Array | undefined) ?? new Uint8Array(), {
        stream: true,
      });
    }

    expect(seen).toContain("event: event");
    expect(seen).toContain("objective.created.v1");

    controller.abort();
  });

  it("refuses the stream to a browser with no session", async () => {
    const core = await startTestCore();

    const response = await fetch(`${core.base}/events/live?afterSequence=0`);

    expect(response.status).toBe(401);
  });

  it("refuses a non-numeric afterSequence", async () => {
    const core = await startTestCore();
    const { cookie } = await session(core);

    const response = await fetch(`${core.base}/events/live?afterSequence=abc`, {
      headers: { cookie },
    });

    expect(response.status).toBe(400);
  });

  it("refuses a negative afterSequence", async () => {
    const core = await startTestCore();
    const { cookie } = await session(core);

    const response = await fetch(`${core.base}/events/live?afterSequence=-1`, {
      headers: { cookie },
    });

    expect(response.status).toBe(400);
  });

  it("clamps a cursor far ahead of the ledger and announces a gap, rather than opening a stream that only ever heartbeats", async () => {
    const core = await startTestCore();
    const { cookie } = await session(core);
    const controller = new AbortController();

    // Passes `Number.isInteger` (it is one, just a very large one) and binds
    // fine into `node:sqlite` — the bug this guards is a cursor accepted at
    // the 400 check but never satisfied by any committed event.
    const stream = await fetch(`${core.base}/events/live?afterSequence=1e21`, {
      headers: { cookie, accept: "text/event-stream" },
      signal: controller.signal,
    });

    expect(stream.status).toBe(200);

    const reader = stream.body?.getReader();
    const decoder = new TextDecoder();
    let seen = "";

    while (!seen.includes('"kind":"gap"')) {
      const chunk = await reader?.read();

      if (chunk?.done === true) {
        break;
      }

      seen += decoder.decode((chunk?.value as Uint8Array | undefined) ?? new Uint8Array(), {
        stream: true,
      });
    }

    expect(seen).toContain("event: frame");
    expect(seen).toContain('"kind":"gap"');

    controller.abort();
  });
});

describe("the core as the front door", () => {
  function webRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "noctis-web-"));

    writeFileSync(join(root, "index.html"), "<!doctype html><title>Noctis</title>");
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "app.js"), "export const app = 1;");

    return root;
  }

  it("serves nothing but the API when no web root is configured", async () => {
    const core = await startTestCore();
    const response = await fetch(`${core.base}/`);

    // The dev loop is unchanged: Vite serves the page, and an unauthenticated
    // GET of anything still meets the credential gate first.
    expect(response.status).toBe(401);
  });

  it("serves the page and its assets to a browser that has no session yet", async () => {
    const root = webRoot();

    try {
      const core = await startTestCore({ webRoot: root });

      const page = await fetch(`${core.base}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");

      const asset = await fetch(`${core.base}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/javascript");

      // A deep link is a route, not a file, so it gets the shell.
      const route = await fetch(`${core.base}/settings`);
      expect(route.status).toBe(200);
      expect(await route.text()).toContain("Noctis");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never lets the page shadow an API route", async () => {
    const root = webRoot();

    try {
      const core = await startTestCore({ webRoot: root });

      // Unauthenticated: each of these must still meet the credential gate
      // rather than being answered with index.html.
      for (const path of ["/objectives", "/permissions", "/events/live", "/commands/x"]) {
        const response = await fetch(`${core.base}${path}`);

        expect([401, 404], path).toContain(response.status);
        expect(response.headers.get("content-type") ?? "", path).toContain("application/json");
      }

      expect((await fetch(`${core.base}/health`)).status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to read outside the web root", async () => {
    const root = webRoot();

    try {
      const core = await startTestCore({ webRoot: root });

      for (const path of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json"]) {
        const response = await fetch(`${core.base}${path}`);

        expect(response.status, path).toBe(404);
        expect(await response.text(), path).not.toContain("noctis-os");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Decision 0.25: the phone hears about it. These cover the realm the endpoints
 * live in — who may subscribe, and what a core without keys says — not the
 * delivery itself, which `notify/push.test.ts` covers with an injected sender.
 */
describe("the push realm", () => {
  // Generated per run, never written down: `web-push` validates the key lengths
  // in `setVapidDetails`, so a made-up pair would stop the core at startup --
  // which is the behaviour we want in production and a nuisance here.
  const VAPID = { ...webpush.generateVAPIDKeys(), subject: "mailto:owner@example.com" };

  const SUBSCRIPTION = {
    endpoint: "https://push.example/endpoint-1",
    keys: { p256dh: "p256dh-value", auth: "auth-value" },
  };

  async function post(
    core: TestCore,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${core.base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("says push is unavailable when the core has no VAPID keys", async () => {
    const core = await startTestCore();
    const response = await read(core, PUSH_KEY_PATH);

    expect(response.status).toBe(404);
    expect((response.body as { error: { code: string } }).error.code).toBe("push_unavailable");
  });

  it("offers the public key, and never the private one", async () => {
    const core = await startTestCore({ vapid: VAPID });
    const response = await read(core, PUSH_KEY_PATH);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ publicKey: VAPID.publicKey });
    expect(JSON.stringify(response.body)).not.toContain(VAPID.privateKey);
  });

  it("stores a subscription against the session that presented it", async () => {
    const core = await startTestCore({ vapid: VAPID });
    const { cookie, csrf } = await session(core);

    const stored = await post(core, PUSH_SUBSCRIBE_PATH, SUBSCRIPTION, {
      cookie,
      "content-type": "application/json",
      "x-noctis-csrf": csrf,
    });

    expect(stored.status).toBe(200);

    const row = core.core.kernel.db
      .prepare("SELECT session_id AS sessionId, endpoint FROM push_subscriptions")
      .get() as { sessionId: string; endpoint: string };

    expect(row.endpoint).toBe(SUBSCRIPTION.endpoint);
    expect(
      core.core.kernel.db.prepare("SELECT id FROM sessions WHERE id = ?").get(row.sessionId),
    ).toBeDefined();
  });

  it("refuses a bearer-authenticated subscription, which would outlive every session", async () => {
    const core = await startTestCore({ vapid: VAPID });
    const refused = await post(core, PUSH_SUBSCRIBE_PATH, SUBSCRIPTION, authorized());

    expect(refused.status).toBe(400);
    expect((refused.body as { error: { code: string } }).error.code).toBe("session_required");
    expect(core.core.kernel.db.prepare("SELECT * FROM push_subscriptions").all()).toEqual([]);
  });

  it("refuses a subscription that is not a PushSubscription", async () => {
    const core = await startTestCore({ vapid: VAPID });
    const { cookie, csrf } = await session(core);
    const headers = { cookie, "content-type": "application/json", "x-noctis-csrf": csrf };

    for (const body of [
      { endpoint: "not-a-url", keys: SUBSCRIPTION.keys },
      { endpoint: SUBSCRIPTION.endpoint },
      {},
    ]) {
      const refused = await post(core, PUSH_SUBSCRIBE_PATH, body, headers);

      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("refuses a subscription with a session cookie but no csrf header", async () => {
    const core = await startTestCore({ vapid: VAPID });
    const { cookie } = await session(core);

    const refused = await post(core, PUSH_SUBSCRIBE_PATH, SUBSCRIPTION, {
      cookie,
      "content-type": "application/json",
    });

    expect(refused.status).toBe(403);
  });

  it("forgets an endpoint on unsubscribe, and says the same for one it never held", async () => {
    const core = await startTestCore({ vapid: VAPID });
    const { cookie, csrf } = await session(core);
    const headers = { cookie, "content-type": "application/json", "x-noctis-csrf": csrf };

    await post(core, PUSH_SUBSCRIBE_PATH, SUBSCRIPTION, headers);

    const gone = await post(
      core,
      PUSH_UNSUBSCRIBE_PATH,
      { endpoint: SUBSCRIPTION.endpoint },
      headers,
    );
    const never = await post(
      core,
      PUSH_UNSUBSCRIBE_PATH,
      { endpoint: "https://push.example/never" },
      headers,
    );

    expect([gone.status, never.status]).toEqual([200, 200]);
    expect(core.core.kernel.db.prepare("SELECT * FROM push_subscriptions").all()).toEqual([]);
  });

  it("keeps the push paths out of the static handler when the core serves the page", async () => {
    const root = mkdtempSync(join(tmpdir(), "noctis-web-"));
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Noctis</title>");

    try {
      const core = await startTestCore({
        webRoot: root,
        allowedOrigins: ["http://127.0.0.1"],
        vapid: VAPID,
      });

      // Without `push` in `static.ts`'s API segments this answers 200 with the
      // app shell, and the page's key fetch parses HTML as JSON.
      const anonymous = await fetch(`${core.base}${PUSH_KEY_PATH}`);

      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("content-type") ?? "").toContain("application/json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
