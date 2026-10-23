import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeServerFrame, RuntimeAsk, ServerFrame, RuntimeItem } from "@noctis/contracts";
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
import { listSurfaceIntents, changeSurfaceLifecycle } from "../objectives/surface-intents.js";
import { listReminders } from "../productivity/service.js";
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

async function startTestCore(logs?: string[]): Promise<TestCore> {
  const directory = mkdtempSync(join(tmpdir(), "noctis-conversation-"));
  const config: CoreConfig = {
    bindAddress: "127.0.0.1",
    port: 0,
    token: TOKEN,
    databasePath: join(directory, "core.db"),
    allowedOrigins: [],
    logLevel: "error",
    sessionTtlHours: 720,
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
    logger: createLogger({
      sink: (line) => logs?.push(line),
      level: logs === undefined ? "error" : "warn",
    }),
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

/**
 * Polls until `predicate` holds. An async predicate is awaited before the next
 * poll, so no request is still in flight when the test moves on and `afterEach`
 * closes the core underneath it.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
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
  /**
   * Dials again on the same credential, the way the real agent does after its
   * socket drops. A fresh `connectFake` would pair a *second* node, which is a
   * different machine and answers a different question.
   */
  reconnect: () => Promise<FakeNode>;
  /** The `Authorization` value this node presents on the HTTP node realm. */
  bearer: () => string;
}

/** Pairs, grants `runtime.turn` on `directory`, connects, and says hello with Codex (by default). */
async function connectFake(
  core: TestCore,
  directory: string,
  agents: { providers: string[]; probes: unknown[] } = {
    providers: ["codex"],
    probes: [CODEX_PROBE],
  },
): Promise<FakeNode> {
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
  let credential = paired.credential;

  const granted = await command(core, "node.grant_capability", {
    idempotencyKey: `grant-${paired.nodeId}`,
    nodeId: paired.nodeId,
    capability: "runtime.turn",
    constraints: {
      providers: agents.providers,
      roots: [{ grantId: "d", path: directory, mode: "write" }],
    },
  });
  expect(granted.status).toBe(200);

  async function dial(): Promise<FakeNode> {
    const socket = new WebSocket(`${core.socketUrl}/ws/nodes`, {
      headers: { authorization: `Bearer ${paired.nodeId}.${credential}` },
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
        providers: agents.probes,
      }),
    );

    const fake: FakeNode = {
      nodeId: paired.nodeId,
      frames,
      jobs: () => frames.filter((frame) => frame.kind === "job"),
      answers: () => frames.filter((frame) => frame.kind === "answer"),
      frame: (body) =>
        socket.send(JSON.stringify({ envelopeVersion: NODE_ENVELOPE_VERSION, ...body })),
      reconnect: dial,
      bearer: () => `Bearer ${paired.nodeId}.${credential}`,
    };

    await waitFor(() => frames.some((frame) => frame.kind === "welcome"), "welcome frame");

    // The core rotates on every connection, so the next dial must present what
    // the last welcome handed over (`nodes/credentials.ts`).
    const welcome = frames.find((frame) => frame.kind === "welcome");

    if (welcome?.kind === "welcome") {
      credential = welcome.credential;
    }

    return fake;
  }

  return dial();
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
  it("attaches only core-derived capture receipts and deduplicates later proposal frames", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-capture-"));
    const node = await connectFake(core, directory);
    await setDefault(core);
    const sent = await send(core, "capture-receipt");
    await waitFor(() => node.jobs().length === 1, "capture job");
    const jobId = lastTurnJob(node).assignment.jobId;
    const forged = "0199a000-0000-7000-8000-000000000bad";
    const item = {
      itemId: "reminder",
      kind: "proposal",
      status: "completed",
      proposal: { kind: "reminder", text: "Renew tax", trigger: null },
      appliedRecordId: forged,
    } as RuntimeItem;
    core.core.conversation.onStreamItem("node", jobId, 0, item);
    const reminders = listReminders(core.core.kernel.db);
    expect(reminders).toHaveLength(1);
    const first = (await read(core, `/turns/${sent.body.id as string}`)).body.items as Body[];
    expect(first[0]?.appliedRecordId).toBe(reminders[0]?.id);
    expect(first[0]?.appliedRecordId).not.toBe(forged);
    core.core.conversation.onStreamItem("node", jobId, 1, item);
    expect(listReminders(core.core.kernel.db)).toHaveLength(1);
    const later = (await read(core, `/turns/${sent.body.id as string}`)).body.items as Body[];
    expect(later[0]?.appliedRecordId).toBe(reminders[0]?.id);
    core.core.conversation.onStreamItem("node", jobId, 2, {
      itemId: "bad",
      kind: "proposal",
      status: "completed",
      proposal: {
        kind: "reminder",
        text: "Past",
        trigger: { kind: "at", at: "2000-01-01T00:00:00Z" },
      },
    });
    const refused = (await read(core, `/turns/${sent.body.id as string}`)).body.items as Body[];
    expect(refused.find((entry) => entry.itemId === "bad")?.appliedRecordId).toBeUndefined();
    rmSync(directory, { recursive: true, force: true });
  });
  it.each([
    [
      "document",
      {
        title: "Plan",
        format: "markdown",
        content: { from: "inline", text: "# Plan\n- [ ] first" },
      },
    ],
    [
      "timeline",
      {
        title: "Today",
        items: [
          { id: "a", start: "09:00", end: "10:00", label: "Build", detail: "Plan", due: true },
        ],
      },
    ],
    [
      "verification",
      {
        title: "Checks",
        items: [{ id: "a", claim: "Build", status: "partial", reason: "Phone pending" }],
      },
    ],
  ])(
    "accepts the complete model %s payload into its owning thread",
    async (surfaceKind, payload) => {
      const core = await startTestCore();
      const node = await connectFake(core, mkdtempSync(join(tmpdir(), "noctis-panel-")));
      await setDefault(core);
      const sent = await send(core, "new-panel");
      await waitFor(() => node.jobs().length === 1, "panel job");
      const actions = [{ label: "Continue", message: "Continue this plan" }];
      node.frame({
        kind: "stream",
        jobId: lastTurnJob(node).assignment.jobId,
        sequence: 0,
        item: {
          itemId: "panel",
          kind: "proposal",
          status: "completed",
          proposal: {
            kind: "surface",
            surfaceKind,
            role: "primary",
            persistence: "restorable",
            priority: 20,
            payloadVersion: 1,
            payload: { ...(payload as object), actions },
          },
        },
      });
      await waitFor(
        () =>
          listSurfaceIntents(core.core.kernel.db, { threadId: sent.body.threadId as string })
            .length === 1,
        "new panel accepted",
      );
      expect(
        listSurfaceIntents(core.core.kernel.db, { threadId: sent.body.threadId as string })[0]
          ?.payload,
      ).toEqual({ ...(payload as object), actions });
    },
  );
  it("refuses a model document file source and a foreign objective", async () => {
    const logs: string[] = [];
    const core = await startTestCore(logs);
    const node = await connectFake(core, mkdtempSync(join(tmpdir(), "noctis-panel-")));
    await setDefault(core);
    const foreign = await command(core, "objective.create", {
      idempotencyKey: "foreign-panel-objective",
      title: "Foreign",
      intent: "Another owner",
      status: "draft",
      identityId: "vesper",
    });
    expect(foreign.status).toBe(200);
    const sent = await send(core, "refuse-panel");
    await waitFor(() => node.jobs().length === 1, "panel job");
    const base = {
      kind: "surface" as const,
      role: "primary" as const,
      persistence: "ephemeral" as const,
      priority: 20,
      payloadVersion: 1,
    };
    node.frame({
      kind: "stream",
      jobId: lastTurnJob(node).assignment.jobId,
      sequence: 0,
      item: {
        itemId: "file",
        kind: "proposal",
        status: "completed",
        proposal: {
          ...base,
          surfaceKind: "document",
          payload: {
            title: "File",
            format: "text",
            content: { from: "file", nodeId: "node", grantId: "grant", relativePath: "private.md" },
          },
        },
      },
    });
    node.frame({
      kind: "stream",
      jobId: lastTurnJob(node).assignment.jobId,
      sequence: 1,
      item: {
        itemId: "foreign",
        kind: "proposal",
        status: "completed",
        proposal: {
          ...base,
          objectiveId: foreign.body.id,
          surfaceKind: "list",
          payload: { items: [] },
        },
      },
    });
    await waitFor(
      () =>
        logs.some((line) => line.includes("document_must_be_inline")) &&
        logs.some((line) => line.includes("foreign_objective_for_surface")),
      "proposal refusals",
    );
    expect(
      listSurfaceIntents(core.core.kernel.db, { threadId: sent.body.threadId as string }),
    ).toHaveLength(0);
    expect(
      listSurfaceIntents(core.core.kernel.db, { objectiveId: foreign.body.id as string }),
    ).toHaveLength(0);
  });
  it("free-chat proposals create one panel per turn and reject core-only kinds", async () => {
    const logs: string[] = [];
    const core = await startTestCore(logs);
    const directory = mkdtempSync(join(tmpdir(), "noctis-panel-"));
    const node = await connectFake(core, directory);
    await setDefault(core);
    const first = await send(core, "panel-first");
    await waitFor(() => node.jobs().length === 1, "first panel job");
    const firstJob = lastTurnJob(node).assignment.jobId;
    const threadId = first.body.threadId as string;
    const proposal = {
      kind: "surface" as const,
      surfaceKind: "list",
      role: "supporting" as const,
      persistence: "restorable" as const,
      priority: 20,
      payloadVersion: 1,
      payload: { items: [{ id: "plan", label: "A plan" }] },
    };
    node.frame({
      kind: "stream",
      jobId: firstJob,
      sequence: 0,
      item: { itemId: "plan", kind: "proposal", status: "completed", proposal },
    });
    await waitFor(
      () => listSurfaceIntents(core.core.kernel.db, { threadId }).length === 1,
      "first panel",
    );
    const firstPanel = listSurfaceIntents(core.core.kernel.db, { threadId })[0]!;
    expect(firstPanel.sourceIds).toEqual([first.body.id]);
    const closed = changeSurfaceLifecycle(
      core.core.kernel,
      { correlationId: core.core.kernel.ids.nextId(), actorType: "user", actorId: "local" },
      { idempotencyKey: "close-panel", surfaceId: firstPanel.id, lifecycle: "dismissed" },
    );
    expect(closed.ok).toBe(true);
    for (const [index, surfaceKind] of [
      "approval",
      "vault_recall",
      "native_application",
      "external_tool",
    ].entries()) {
      node.frame({
        kind: "stream",
        jobId: firstJob,
        sequence: index + 1,
        item: {
          itemId: `forbidden-${index}`,
          kind: "proposal",
          status: "completed",
          proposal: { ...proposal, surfaceKind },
        },
      });
    }
    await waitFor(
      () => logs.filter((line) => line.includes("kind_not_proposable")).length === 4,
      "forbidden kinds logged",
    );
    expect(listSurfaceIntents(core.core.kernel.db, { threadId })).toHaveLength(1);
    node.frame({
      kind: "result",
      jobId: firstJob,
      outcome: "succeeded",
      evidence: {
        model: MODEL,
        sessionRef: "panel-session",
        itemCount: 6,
        stoppedReason: "completed",
      },
    });
    await waitFor(
      async () =>
        (await read(core, `/turns/${first.body.id as string}`)).body.status === "completed",
      "first turn completed",
    );
    const second = await send(core, "panel-second", { threadId });
    await waitFor(() => node.jobs().length === 2, "second panel job");
    node.frame({
      kind: "stream",
      jobId: lastTurnJob(node).assignment.jobId,
      sequence: 0,
      item: { itemId: "plan", kind: "proposal", status: "completed", proposal },
    });
    await waitFor(
      () => listSurfaceIntents(core.core.kernel.db, { threadId }).length === 2,
      "second panel",
    );
    const panels = listSurfaceIntents(core.core.kernel.db, { threadId });
    expect(panels.find((panel) => panel.id === firstPanel.id)?.lifecycle).toBe("dismissed");
    expect(panels.find((panel) => panel.id !== firstPanel.id)?.sourceIds).toEqual([second.body.id]);
    rmSync(directory, { recursive: true, force: true });
  });
  it("an agent opens a Noctis page as a panel, but never one pointed at a folder", async () => {
    const logs: string[] = [];
    const core = await startTestCore(logs);
    const directory = mkdtempSync(join(tmpdir(), "noctis-panel-"));
    const node = await connectFake(core, directory);
    await setDefault(core);
    const sent = await send(core, "open the vault");
    await waitFor(() => node.jobs().length === 1, "page panel job");
    const jobId = lastTurnJob(node).assignment.jobId;
    const threadId = sent.body.threadId as string;
    const page = (payload: Record<string, unknown>) => ({
      kind: "surface" as const,
      surfaceKind: "page",
      role: "primary" as const,
      persistence: "restorable" as const,
      priority: 50,
      payloadVersion: 1,
      payload,
    });

    node.frame({
      kind: "stream",
      jobId,
      sequence: 0,
      item: {
        itemId: "vault",
        kind: "proposal",
        status: "completed",
        proposal: page({ page: "Vault" }),
      },
    });
    node.frame({
      kind: "stream",
      jobId,
      sequence: 1,
      item: {
        itemId: "files",
        kind: "proposal",
        status: "completed",
        proposal: page({
          page: "Files",
          folder: { nodeId: node.nodeId, grantId: "d", relativePath: "secret" },
        }),
      },
    });
    await waitFor(
      () => logs.some((line) => line.includes("page_folder_not_proposable")),
      "folder page refused",
    );
    const panels = listSurfaceIntents(core.core.kernel.db, { threadId });
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ kind: "page", payload: { page: "Vault" } });
    rmSync(directory, { recursive: true, force: true });
  });
  it("an options panel shows each picture from a shared folder, and drops one from anywhere else", async () => {
    const logs: string[] = [];
    const core = await startTestCore(logs);
    const directory = mkdtempSync(join(tmpdir(), "noctis-panel-"));
    const node = await connectFake(core, directory);
    await setDefault(core);
    const sent = await send(core, "find me a usb-c cable");
    await waitFor(() => node.jobs().length === 1, "options panel job");
    const threadId = sent.body.threadId as string;
    const option = (id: string, path: string) => ({
      id,
      title: `Cable ${id}`,
      price: "£7.99",
      image: { path },
      url: "https://www.amazon.co.uk/dp/B0EXAMPLE",
      action: { label: "Add to basket", message: `Add ${id} to my basket` },
    });

    node.frame({
      kind: "stream",
      jobId: lastTurnJob(node).assignment.jobId,
      sequence: 0,
      item: {
        itemId: "options",
        kind: "proposal",
        status: "completed",
        proposal: {
          kind: "surface",
          surfaceKind: "options",
          role: "primary",
          persistence: "restorable",
          priority: 50,
          payloadVersion: 1,
          payload: {
            title: "USB-C cables under £10",
            options: [
              option("inside", join(directory, "noctis-show", ".shots", "a.png")),
              option("outside", join(tmpdir(), "elsewhere", "b.png")),
            ],
          },
        },
      },
    });
    await waitFor(
      () => listSurfaceIntents(core.core.kernel.db, { threadId }).length === 1,
      "options panel",
    );
    const [panel] = listSurfaceIntents(core.core.kernel.db, { threadId });
    const [inside, outside] = (panel?.payload as { options: Array<Record<string, unknown>> })
      .options;

    expect(panel?.kind).toBe("options");
    expect(inside?.image).toEqual({
      from: "file",
      nodeId: node.nodeId,
      grantId: "d",
      relativePath: "noctis-show/.shots/a.png",
    });
    expect(outside).not.toHaveProperty("image");
    expect(outside).toMatchObject({ url: "https://www.amazon.co.uk/dp/B0EXAMPLE" });

    // A picture named by node and grant is what the core resolves, never what the model says.
    node.frame({
      kind: "stream",
      jobId: lastTurnJob(node).assignment.jobId,
      sequence: 1,
      item: {
        itemId: "named-grant",
        kind: "proposal",
        status: "completed",
        proposal: {
          kind: "surface",
          surfaceKind: "options",
          role: "primary",
          persistence: "restorable",
          priority: 50,
          payloadVersion: 1,
          payload: {
            title: "Named grant",
            options: [
              {
                id: "x",
                title: "x",
                image: {
                  from: "file",
                  nodeId: node.nodeId,
                  grantId: "d",
                  relativePath: "secret.png",
                },
              },
            ],
          },
        },
      },
    });
    await waitFor(() => logs.some((line) => line.includes("invalid_surface_payload")), "refusal");
    expect(listSurfaceIntents(core.core.kernel.db, { threadId })).toHaveLength(1);
    rmSync(directory, { recursive: true, force: true });
  });
  it("a named panel is the same panel in later turns, so live work updates one place", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-panel-"));
    const node = await connectFake(core, directory);
    await setDefault(core);
    const proposal = (label: string) => ({
      kind: "surface" as const,
      surfaceKind: "list",
      panelId: "readme-drafts",
      role: "primary" as const,
      persistence: "restorable" as const,
      priority: 20,
      payloadVersion: 1,
      payload: { items: [{ id: "a", label }] },
    });
    const first = await send(core, "named-first");
    const threadId = first.body.threadId as string;
    await waitFor(() => node.jobs().length === 1, "first job");
    const firstJob = lastTurnJob(node).assignment.jobId;
    node.frame({
      kind: "stream",
      jobId: firstJob,
      sequence: 0,
      item: { itemId: "p", kind: "proposal", status: "completed", proposal: proposal("Drafting") },
    });
    await waitFor(
      () => listSurfaceIntents(core.core.kernel.db, { threadId }).length === 1,
      "named panel",
    );
    node.frame({
      kind: "result",
      jobId: firstJob,
      outcome: "succeeded",
      evidence: { model: MODEL, sessionRef: "named", itemCount: 1, stoppedReason: "completed" },
    });
    await waitFor(
      async () =>
        (await read(core, `/turns/${first.body.id as string}`)).body.status === "completed",
      "first turn completed",
    );
    await send(core, "named-second", { threadId });
    await waitFor(() => node.jobs().length === 2, "second job");
    node.frame({
      kind: "stream",
      jobId: lastTurnJob(node).assignment.jobId,
      sequence: 0,
      item: { itemId: "p", kind: "proposal", status: "completed", proposal: proposal("Ready") },
    });
    await waitFor(
      () =>
        (
          listSurfaceIntents(core.core.kernel.db, { threadId })[0]?.payload as {
            items: Array<{ label: string }>;
          }
        ).items[0]?.label === "Ready",
      "named panel updated",
    );
    expect(listSurfaceIntents(core.core.kernel.db, { threadId })).toHaveLength(1);
    rmSync(directory, { recursive: true, force: true });
  });
  it("a visual panel shows an HTML or SVG file from the turn's shared folder and nothing else", async () => {
    const logs: string[] = [];
    const core = await startTestCore(logs);
    const directory = mkdtempSync(join(tmpdir(), "noctis-panel-"));
    const node = await connectFake(core, directory);
    await setDefault(core);
    const sent = await send(core, "visual");
    const threadId = sent.body.threadId as string;
    await waitFor(() => node.jobs().length === 1, "visual job");
    const jobId = lastTurnJob(node).assignment.jobId;
    const visual = (path: string) => ({
      kind: "surface" as const,
      surfaceKind: "visual",
      role: "primary" as const,
      persistence: "restorable" as const,
      priority: 20,
      payloadVersion: 1,
      payload: { title: "Rate limiter", path },
    });
    for (const [index, path] of [
      join(tmpdir(), "elsewhere.html"),
      join(directory, "photo.png"),
      join(directory, "figures", "limiter.html"),
    ].entries()) {
      node.frame({
        kind: "stream",
        jobId,
        sequence: index,
        item: {
          itemId: `v${String(index)}`,
          kind: "proposal",
          status: "completed",
          proposal: visual(path),
        },
      });
    }
    await waitFor(
      () => listSurfaceIntents(core.core.kernel.db, { threadId }).length === 1,
      "visual panel",
    );
    expect(listSurfaceIntents(core.core.kernel.db, { threadId })[0]).toMatchObject({
      kind: "visual",
      payload: {
        title: "Rate limiter",
        source: { from: "file", relativePath: "figures/limiter.html" },
      },
    });
    expect(logs.some((line) => line.includes("file_outside_shared_folders"))).toBe(true);
    expect(logs.some((line) => line.includes("file_does_not_fit_panel"))).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  });
  it("shows an existing file by its path: a document for text, media for an image, no copy in the call", async () => {
    const logs: string[] = [];
    const core = await startTestCore(logs);
    const directory = mkdtempSync(join(tmpdir(), "noctis-panel-"));
    const node = await connectFake(core, directory);
    await setDefault(core);
    const sent = await send(core, "by-path");
    const threadId = sent.body.threadId as string;
    await waitFor(() => node.jobs().length === 1, "path job");
    const jobId = lastTurnJob(node).assignment.jobId;
    const show = (surfaceKind: string, path: string) => ({
      kind: "surface" as const,
      surfaceKind,
      role: "primary" as const,
      persistence: "restorable" as const,
      priority: 20,
      payloadVersion: 1,
      payload: { title: "README", path },
    });
    for (const [index, [kind, path]] of [
      ["document", join(directory, "README.md")],
      ["media", join(directory, "docs", "shot.png")],
      ["document", join(directory, "docs", "shot.png")],
    ].entries()) {
      node.frame({
        kind: "stream",
        jobId,
        sequence: index,
        item: {
          itemId: `f${String(index)}`,
          kind: "proposal",
          status: "completed",
          proposal: show(kind!, path!),
        },
      });
    }
    await waitFor(
      () => listSurfaceIntents(core.core.kernel.db, { threadId }).length === 2,
      "file panels",
    );
    const panels = listSurfaceIntents(core.core.kernel.db, { threadId });
    expect(panels.find((panel) => panel.kind === "document")?.payload).toMatchObject({
      title: "README",
      format: "markdown",
      content: { from: "file", relativePath: "README.md" },
    });
    expect(panels.find((panel) => panel.kind === "media")?.payload).toMatchObject({
      mediaType: "image/png",
      source: { from: "file", relativePath: "docs/shot.png" },
    });
    await waitFor(
      () => logs.some((line) => line.includes("file_does_not_fit_panel")),
      "an image is not a document",
    );
    node.frame({
      kind: "stream",
      jobId,
      sequence: 3,
      item: {
        itemId: "raw",
        kind: "proposal",
        status: "completed",
        proposal: {
          ...show("media", "unused"),
          payload: {
            title: "Named source",
            mediaType: "image/png",
            source: { from: "file", nodeId: "node", grantId: "grant", relativePath: "a.png" },
          },
        },
      },
    });
    await waitFor(
      () => logs.some((line) => line.includes("file_panel_needs_a_path")),
      "media only by path",
    );
    expect(listSurfaceIntents(core.core.kernel.db, { threadId })).toHaveLength(2);
    node.frame({
      kind: "stream",
      jobId,
      sequence: 4,
      item: {
        itemId: "gone",
        kind: "proposal",
        status: "completed",
        proposal: { ...show("media", join(directory, "docs", "shot.png")), withdrawn: true },
      },
    });
    await waitFor(
      () =>
        listSurfaceIntents(core.core.kernel.db, { threadId }).find(
          (panel) => panel.kind === "media",
        )?.lifecycle === "dismissed",
      "a deleted file closes its panel",
    );
    rmSync(directory, { recursive: true, force: true });
  });
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
    core.core.kernel.db
      .prepare("UPDATE node_owner_presence SET present = 1, updated_at = ? WHERE node_id = ?")
      .run(new Date().toISOString(), node.nodeId);
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
    // What the owner's words can name, so a model never invents an id.
    expect(payload.targets).toMatchObject({
      // The PC the owner is using is what "my PC" means.
      pcs: [{ nodeId: node.nodeId, current: true, online: true, ownerPresent: true }],
      folders: [{ grantId: "d", nodeId: node.nodeId }],
      tasks: [],
    });

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
    // Presence's live brief follows the job with surface events of its own.
    const jobEvents = async () =>
      (await eventTypes(core)).filter((type) => !type.startsWith("surface."));
    const before = (await jobEvents()).length;

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
    const after = await jobEvents();
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
    await waitFor(async () => {
      const response = await read(core, `/threads/${sent.body.threadId as string}/messages`);
      messages = response.body.messages as Array<Body>;
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

  it("an ask the agent raised itself waits for a person, even a read under an active Objective", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);
    const objectiveId = await activeObjective(core, "agent-ask");

    await setDefault(core);
    await send(core, "turn-agent-ask", { objectiveId });
    await waitFor(() => node.jobs().length === 1, "the turn");

    const read_ask: RuntimeAsk = {
      ...ASK,
      operationClass: "read_inspect",
      askedBy: "runtime",
    };

    node.frame({ kind: "ask", jobId: lastTurnJob(node).assignment.jobId, ask: read_ask });

    let approval: Body | undefined;
    await waitFor(async () => {
      const response = await read(core, "/approvals");
      approval = (response.body.approvals as Body[]).find((a) => a.askId === read_ask.askId);
      return approval !== undefined;
    }, "the approval");

    // `require_confirmation` is what `notify/triggers.ts` sends a push for.
    expect(approval).toMatchObject({
      outcome: "require_confirmation",
      reasonCodes: ["operation_class_default", "runtime_asked"],
    });
    expect(node.answers()).toHaveLength(0);
  });

  it("a turn that ends while its approval waits closes the approval, so nobody answers a dead question", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);

    await setDefault(core);
    await send(core, "turn-ends-waiting");
    await waitFor(() => node.jobs().length === 1, "the turn");

    const jobId = lastTurnJob(node).assignment.jobId;

    node.frame({ kind: "ask", jobId, ask: { ...ASK, askedBy: "runtime" } });
    await waitFor(async () => {
      const response = await read(core, "/approvals");
      return (response.body.approvals as Body[]).some((a) => a.askId === ASK.askId);
    }, "the pending approval");

    node.frame({
      kind: "result",
      jobId,
      outcome: "failed",
      evidence: null,
      failureReason: 'approval timed out: "run the tests" was not answered within 10 minutes',
    });

    let approval: Body | undefined;
    await waitFor(async () => {
      const response = await read(core, "/approvals");
      approval = (response.body.approvals as Body[]).find((a) => a.askId === ASK.askId);
      return approval?.declinedAt !== undefined;
    }, "the approval to close");

    expect(approval).toMatchObject({ declinedBy: "system" });
    expect(node.answers()).toHaveLength(0);
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
    await waitFor(async () => {
      const response = await read(core, "/approvals");
      pending = (response.body.approvals as Array<Body>).filter(
        (a) => a.askId === askB.askId || a.askId === askC.askId,
      );
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
    await waitFor(async () => {
      const response = await read(core, `/turns/${first.body.id as string}`);
      turn = response.body;
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

  it("GET /turns is every thread's turns, newest first: what Missions reads", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));

    await connectFake(core, directory);
    await setDefault(core);

    const objectiveId = await activeObjective(core, "missions");
    const free = await send(core, "free-turn");
    const inObjective = await send(core, "objective-turn", { objectiveId });

    const turns = await read(core, "/turns");
    expect(turns.status).toBe(200);
    // Two threads, one list, newest first — and each turn carries the host,
    // model, job and items the page shows without a second read.
    expect((turns.body.turns as Array<Body>).map((turn) => turn.id)).toEqual([
      inObjective.body.id,
      free.body.id,
    ]);
    expect((turns.body.turns as Array<Body>)[0]).toMatchObject({
      objectiveId,
      identityId: "vesper",
      model: MODEL,
      status: "queued",
      items: [],
    });
    expect((turns.body.turns as Array<Body>)[1]?.objectiveId).toBeUndefined();

    rmSync(directory, { recursive: true, force: true });
  });

  it("GET /models lists what connected nodes offer and each identity's default", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));

    const empty = await read(core, "/models");
    expect(empty.body).toEqual({ catalogue: [], defaults: {}, roots: [] });

    await connectFake(core, directory);
    await setDefault(core);

    const models = await read(core, "/models");
    expect(models.status).toBe(200);
    expect(models.body).toMatchObject({ catalogue: [MODEL], defaults: { vesper: MODEL } });

    // The roots a turn can be pinned to. `path` is the fake node's temp
    // directory, so it is matched by shape rather than by value.
    expect(models.body.roots).toEqual([
      expect.objectContaining({ grantId: "d", mode: "write", connected: true }),
    ]);

    rmSync(directory, { recursive: true, force: true });
  });

  it("a folder shared later, in a grant of its own, is offered and can be pinned", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const later = mkdtempSync(join(tmpdir(), "noctis-root-later-"));
    const fake = await connectFake(core, directory);

    await setDefault(core);
    const shared = await command(core, "node.grant_capability", {
      idempotencyKey: "share-later",
      nodeId: fake.nodeId,
      capability: "runtime.turn",
      constraints: {
        providers: ["codex"],
        roots: [{ grantId: "later", path: later, mode: "write" }],
      },
    });
    expect(shared.status).toBe(200);

    const roots = (await read(core, "/models")).body.roots as Body[];
    expect(roots.map((root) => root.grantId).sort()).toEqual(["d", "later"]);

    const sent = await send(core, "pinned-later", { rootGrantId: "later" });
    expect(sent.status).toBe(200);
    expect(sent.body.jobId).toEqual(expect.any(String));

    rmSync(directory, { recursive: true, force: true });
    rmSync(later, { recursive: true, force: true });
  });

  it("stops sharing one folder, keeping the others in its grant, and tells the node at once", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const fake = await connectFake(core, directory);
    const unshare = (key: string, rootGrantId: string) =>
      command(core, "node.unshare_folder", {
        idempotencyKey: key,
        nodeId: fake.nodeId,
        rootGrantId,
      });
    const offered = async () =>
      ((await read(core, "/models")).body.roots as Body[]).map((root) => root.grantId).sort();

    await command(core, "node.grant_capability", {
      idempotencyKey: "share-two",
      nodeId: fake.nodeId,
      capability: "runtime.turn",
      constraints: {
        providers: ["codex"],
        roots: [
          { grantId: "keep", path: directory, mode: "read" },
          { grantId: "drop", path: directory, mode: "write" },
        ],
      },
    });
    expect(await offered()).toEqual(["d", "drop", "keep"]);

    const dropped = await unshare("unshare-drop", "drop");
    expect(dropped.status).toBe(200);
    expect(await offered()).toEqual(["d", "keep"]);

    // The node's own copy of its grants is replaced, so it stops at once rather than at reconnect.
    await waitFor(() => {
      const welcomes = fake.frames.filter((frame) => frame.kind === "welcome");
      const roots = JSON.stringify(welcomes.at(-1));

      return welcomes.length > 1 && roots.includes('"keep"') && !roots.includes('"drop"');
    }, "the node was not sent its new grants");

    expect((await unshare("unshare-d", "d")).status).toBe(200);
    expect(await offered()).toEqual(["keep"]);
    expect((await unshare("unshare-again", "drop")).status).toBe(404);
    expect(await eventTypes(core)).toContain("node.capability_revoked.v1");

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

  it("a node that reconnects and re-asks gets the decision already recorded", async () => {
    // Task 2.6, and the case a green suite is least likely to find: the socket
    // that carried an ask dies while a person is reading the question. The node
    // reconnects and asks again, because from its side nothing was answered.
    //
    // ADR-0025 is what makes that safe: the ask id *is* the idempotency key of
    // the authority request, so the second ask claims a key the first already
    // claimed and reads back the same approval. A second decision would be a
    // second consequence boundary over one act — and if the human had already
    // said yes, it would be one they were never asked about.
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const first = await connectFake(core, directory);

    await setDefault(core);
    await send(core, "turn-reask");
    await waitFor(() => first.jobs().length === 1, "the turn");

    const jobId = lastTurnJob(first).assignment.jobId;

    first.frame({ kind: "ask", jobId, ask: ASK });

    let original: Body | undefined;

    await waitFor(async () => {
      const response = await read(core, "/approvals");
      original = (response.body.approvals as Body[]).find((a) => a.askId === ASK.askId);

      return original !== undefined;
    }, "the first approval");

    if (original === undefined) {
      throw new Error("no approval was recorded for the ask");
    }

    expect(original.outcome).toBe("require_confirmation");

    // The socket dies mid-question. The node's own pending ask rejects; the
    // core's approval row does not care.
    openSockets.pop()?.terminate();
    await waitFor(() => core.core.dispatcher.connectedCount === 0, "the node to disconnect");

    const second = await first.reconnect();

    second.frame({ kind: "ask", jobId, ask: ASK });

    // Confirming once answers the re-asking connection, and there is still one
    // approval — not two.
    const confirmed = await command(core, "authority.confirm", {
      idempotencyKey: "confirm-reask",
      requestId: original.id,
    });
    expect(confirmed.status).toBe(200);

    await waitFor(() => second.answers().length === 1, "the answer on the new socket");
    expect(second.answers()[0]?.answer).toMatchObject({
      askId: ASK.askId,
      approvalId: original.id,
      decision: "allow",
    });

    const after = (await read(core, "/approvals")).body.approvals as Body[];
    expect(after.filter((a) => a.askId === ASK.askId)).toHaveLength(1);

    rmSync(directory, { recursive: true, force: true });
  });

  it("a host that is merely asleep refuses the send and writes nothing", async () => {
    // Task 2.6. Distinct from the test above on purpose: a node that could run
    // this and happens to be disconnected is a different answer from a node
    // that never could, and the difference is what makes "send it elsewhere"
    // an offer the page can make.
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));

    await connectFake(core, directory);
    await setDefault(core);

    // The socket goes; the grant and the probe stay. That is exactly a machine
    // the owner shut the lid on.
    openSockets.pop()?.terminate();
    await waitFor(() => core.core.dispatcher.connectedCount === 0, "the node to disconnect");

    const refused = await send(core, "asleep");

    expect(refused.status).toBe(503);
    expect(
      (refused.body as unknown as { error: { details: { reason: string } } }).error.details,
    ).toEqual({ reason: "node_offline" });

    // Nothing written: no turn to read past, and the same prompt is still
    // sendable once the machine wakes — or somewhere else, unpinned.
    const types = await eventTypes(core);
    expect(types).not.toContain("provider.decision_recorded.v1");
    expect(types).not.toContain("identity.turn_completed.v1");

    rmSync(directory, { recursive: true, force: true });
  });

  // Task 3.3's first half. The router treats `activeLeases` as a tie-break
  // between nodes and never as a cap, and the agent starts each assignment with
  // `void execute(...)`, so nothing in either process serialises a node's work.
  // That is a claim about two files reading each other correctly, which is
  // exactly the kind of claim that stops being true by accident.
  it("two Objectives run at once on one node, answer out of order, and do not mix", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);
    const alpha = await activeObjective(core, "alpha");
    const beta = await activeObjective(core, "beta");

    await setDefault(core);

    const first = await send(core, "concurrent-alpha", { objectiveId: alpha });
    await waitFor(() => node.jobs().length === 1, "the first Objective's job");
    const alphaJob = lastTurnJob(node).assignment.jobId;

    // Nothing has finished the first job, and nothing will until after the
    // second one has answered. A core that ran one turn per node at a time
    // would leave this prompt queued, so the second frame arriving at all is
    // most of the assertion.
    const second = await send(core, "concurrent-beta", { objectiveId: beta });
    await waitFor(() => node.jobs().length === 2, "the second Objective's job");
    const betaJob = lastTurnJob(node).assignment.jobId;

    expect(betaJob).not.toBe(alphaJob);
    expect(second.body.threadId).not.toBe(first.body.threadId);

    const inFlight = core.core.kernel.db
      .prepare(
        "SELECT COUNT(*) AS n FROM node_jobs WHERE id IN (?, ?) AND status IN ('leased', 'running')",
      )
      .get(alphaJob, betaJob) as { n: number };
    expect(inFlight.n).toBe(2);

    // Out of order on purpose: the Objective that was asked second answers first.
    node.frame({
      kind: "stream",
      jobId: betaJob,
      sequence: 0,
      item: { itemId: "b1", kind: "agent_message", status: "completed", text: "beta answered" },
    });
    node.frame({
      kind: "stream",
      jobId: alphaJob,
      sequence: 0,
      item: { itemId: "a1", kind: "agent_message", status: "completed", text: "alpha answered" },
    });

    async function bodiesOf(threadId: string): Promise<string[]> {
      const response = await read(core, `/threads/${threadId}/messages`);

      return (response.body.messages as Array<Body>).map((message) => message.body as string);
    }

    let alphaBodies: string[] = [];
    let betaBodies: string[] = [];
    await waitFor(async () => {
      alphaBodies = await bodiesOf(first.body.threadId as string);
      betaBodies = await bodiesOf(second.body.threadId as string);

      return alphaBodies.length === 2 && betaBodies.length === 2;
    }, "a reply on each thread");

    // Each Objective's thread holds its own prompt and its own answer. Two
    // threads, two histories — the same separation the free/Objective split
    // proved, now under simultaneous load rather than one after the other.
    expect(alphaBodies).toEqual(["prompt concurrent-alpha", "alpha answered"]);
    expect(betaBodies).toEqual(["prompt concurrent-beta", "beta answered"]);

    node.frame({
      kind: "result",
      jobId: betaJob,
      outcome: "succeeded",
      evidence: {
        model: MODEL,
        sessionRef: "session-beta",
        itemCount: 1,
        finalText: "beta",
        stoppedReason: "completed",
      },
    });

    const alphaId = first.body.id as string;
    const betaId = second.body.id as string;

    let betaTurn: Body = {};
    await waitFor(async () => {
      const response = await read(core, `/turns/${betaId}`);
      betaTurn = response.body;

      return betaTurn.status === "completed";
    }, "the second Objective's turn to finish");

    // The one that is still working is untouched by the one that finished.
    const alphaMidway = await read(core, `/turns/${alphaId}`);
    expect(alphaMidway.body.status).toBe("running");

    node.frame({
      kind: "result",
      jobId: alphaJob,
      outcome: "succeeded",
      evidence: {
        model: MODEL,
        sessionRef: "session-alpha",
        itemCount: 1,
        finalText: "alpha",
        stoppedReason: "completed",
      },
    });

    let alphaTurn: Body = {};
    await waitFor(async () => {
      const response = await read(core, `/turns/${alphaId}`);
      alphaTurn = response.body;

      return alphaTurn.status === "completed";
    }, "the first Objective's turn to finish");

    // Each thread resumes its own runtime session next time, not the other's.
    const sessions = core.core.kernel.db
      .prepare("SELECT thread_id, session_ref FROM identity_sessions ORDER BY session_ref")
      .all() as Array<{ thread_id: string; session_ref: string }>;
    expect(sessions).toEqual([
      { thread_id: first.body.threadId, session_ref: "session-alpha" },
      { thread_id: second.body.threadId, session_ref: "session-beta" },
    ]);

    rmSync(directory, { recursive: true, force: true });
  });
});

const DELEGATION_A = "0199a000-0000-7000-8000-0000000000d1";
const DELEGATION_B = "0199a000-0000-7000-8000-0000000000d2";
const OUTPUT_ATTACHMENT = "0199a000-0000-7000-8000-0000000000e1";
const FRAME_PATH = "C:\\frames\\1.png";

function delegatedResults(node: FakeNode) {
  return node.frames.flatMap((frame) => (frame.kind === "delegated" ? [frame] : []));
}

/** The child turn's node answers: a reply, one image, and a session to resume. */
function finishChild(node: FakeNode, jobId: string, reply: string, sessionRef: string): void {
  node.frame({
    kind: "stream",
    jobId,
    sequence: 0,
    item: { itemId: "m1", kind: "agent_message", status: "completed", text: reply },
  });
  node.frame({
    kind: "stream",
    jobId,
    sequence: 1,
    item: {
      itemId: "ig_1",
      kind: "output",
      status: "completed",
      mediaType: "image/png",
      path: FRAME_PATH,
      attachmentId: OUTPUT_ATTACHMENT,
    },
  });
  node.frame({
    kind: "result",
    jobId,
    outcome: "succeeded",
    evidence: {
      model: MODEL,
      sessionRef,
      itemCount: 2,
      finalText: reply,
      stoppedReason: "completed",
    },
  });
}

async function delegationApprovals(core: TestCore): Promise<Body[]> {
  const response = await read(core, "/approvals");

  return (response.body.approvals as Body[]).filter((a) => a.capability === "runtime.delegate");
}

describe("delegation", () => {
  it("THE GATE: a delegated turn runs on a linked child thread, and a second request continues it", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);
    const objectiveId = await activeObjective(core, "delegate");

    await setDefault(core);
    const parent = await send(core, "parent", { objectiveId });
    await waitFor(() => node.jobs().length === 1, "the parent turn");
    const parentJob = lastTurnJob(node).assignment.jobId;

    node.frame({
      kind: "delegate",
      jobId: parentJob,
      delegation: { delegationId: DELEGATION_A, runtime: "codex", prompt: "draw frame 1" },
    });
    await waitFor(() => node.jobs().length === 2, "the child turn");

    const child = lastTurnJob(node);
    const childThreadId = child.payload.threadId;
    expect(childThreadId).not.toBe(parent.body.threadId);
    expect(child.payload).toMatchObject({
      prompt: "draw frame 1",
      model: MODEL,
      primaryRootGrantId: "d",
      objectiveId,
    });

    finishChild(node, child.assignment.jobId, "frame drawn", "child-session");
    await waitFor(() => delegatedResults(node).length === 1, "the delegation result");

    expect(delegatedResults(node)[0]).toMatchObject({
      jobId: parentJob,
      result: {
        delegationId: DELEGATION_A,
        outcome: "completed",
        threadId: childThreadId,
        reply: "frame drawn",
        outputs: [{ mediaType: "image/png", path: FRAME_PATH, attachmentId: OUTPUT_ATTACHMENT }],
      },
    });

    // Policy decided it, and the decision is on the record against the parent's job.
    expect(await delegationApprovals(core)).toEqual([
      expect.objectContaining({
        outcome: "allow",
        nodeJobId: parentJob,
        operationClass: "local_reversible_edit",
        target: expect.objectContaining({ type: "runtime", id: "codex" }) as unknown,
      }),
    ]);

    const thread = await read(core, `/threads/${childThreadId}`);
    expect(thread.status).toBe(200);
    expect(thread.body).toMatchObject({
      id: childThreadId,
      identityId: "vesper",
      parentThreadId: parent.body.threadId,
      parentTurnId: parent.body.id,
    });

    const children = await read(core, `/threads/${parent.body.threadId as string}/children`);
    expect((children.body.threads as Body[]).map((t) => t.id)).toEqual([childThreadId]);

    // The Objective's own thread is still the parent, not the child.
    const byObjective = await read(core, `/threads?identityId=vesper&objectiveId=${objectiveId}`);
    expect(byObjective.body.id).toBe(parent.body.threadId);

    node.frame({
      kind: "delegate",
      jobId: parentJob,
      delegation: {
        delegationId: DELEGATION_B,
        runtime: "codex",
        prompt: "make the sky darker",
        threadId: childThreadId,
      },
    });
    await waitFor(() => node.jobs().length === 3, "the follow-up child turn");
    expect(lastTurnJob(node).payload).toMatchObject({
      threadId: childThreadId,
      sessionRef: "child-session",
      prompt: "make the sky darker",
    });

    rmSync(directory, { recursive: true, force: true });
  });

  it("THE GATE (S3): a thread runs on the PC's local model, and Claude's turn delegates to it and to Hermes", async () => {
    const LOCAL_MODEL = { providerId: "local", model: "qwen3.5-9b" };
    const HERMES_MODEL = { providerId: "hermes", model: "qwen3.5-9b" };
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory, {
      providers: ["codex", "local", "hermes"],
      probes: [
        CODEX_PROBE,
        { providerId: "local", available: true, authMode: "local", models: [LOCAL_MODEL] },
        { providerId: "hermes", available: true, authMode: "local", models: [HERMES_MODEL] },
      ],
    });

    // A thread on the local model: costed as local, never as a subscription or a meter.
    const direct = await send(core, "local-direct", { model: LOCAL_MODEL });
    expect(direct.status).toBe(200);
    await waitFor(() => node.jobs().length === 1, "the local turn");
    expect(lastTurnJob(node).payload.model).toEqual(LOCAL_MODEL);
    expect(
      core.core.kernel.db
        .prepare("SELECT cost_class FROM provider_decisions WHERE turn_id = ?")
        .get(direct.body.id as string),
    ).toEqual({ cost_class: "local" });

    // Another agent's turn hands work to it, and gets the reply back.
    const objectiveId = await activeObjective(core, "local");
    await setDefault(core);
    await send(core, "parent-for-local", { objectiveId });
    await waitFor(() => node.jobs().length === 2, "the parent turn");
    const parentJob = lastTurnJob(node).assignment.jobId;

    node.frame({
      kind: "delegate",
      jobId: parentJob,
      delegation: { delegationId: DELEGATION_A, runtime: "local", prompt: "tighten this line" },
    });
    await waitFor(() => node.jobs().length === 3, "the local child turn");

    const child = lastTurnJob(node);
    expect(child.payload).toMatchObject({ model: LOCAL_MODEL, prompt: "tighten this line" });

    finishChild(node, child.assignment.jobId, "tighter", "local-session");
    await waitFor(() => delegatedResults(node).length === 1, "the delegation result");
    expect(delegatedResults(node)[0]?.result).toMatchObject({
      outcome: "completed",
      reply: "tighter",
    });

    // The agent that does things on the PC, thinking on the same local model.
    node.frame({
      kind: "delegate",
      jobId: parentJob,
      delegation: {
        delegationId: DELEGATION_B,
        runtime: "hermes",
        prompt: "tidy the renders folder",
      },
    });
    await waitFor(() => node.jobs().length === 4, "the Hermes child turn");
    expect(lastTurnJob(node).payload).toMatchObject({ model: HERMES_MODEL });

    rmSync(directory, { recursive: true, force: true });
  });

  it("Jester runs on Hermes alone (ADR-0030): the first Hermes model unless one is chosen, never another agent", async () => {
    const LOCAL_MODEL = { providerId: "local", model: "qwen3.5-9b" };
    const HERMES_MODEL = { providerId: "hermes", model: "qwen3.5-9b" };
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory, {
      providers: ["codex", "local", "hermes"],
      probes: [
        CODEX_PROBE,
        { providerId: "local", available: true, authMode: "local", models: [LOCAL_MODEL] },
        { providerId: "hermes", available: true, authMode: "local", models: [HERMES_MODEL] },
      ],
    });

    // A Codex default left over from before is no model Jester runs on.
    await setDefault(core, "jester");
    const sent = await send(core, "jester-default", { identityId: "jester" });

    expect(sent.status).toBe(200);
    await waitFor(() => node.jobs().length === 1, "Jester's turn");
    expect(lastTurnJob(node).payload).toMatchObject({ identityId: "jester", model: HERMES_MODEL });

    for (const model of [LOCAL_MODEL, MODEL]) {
      const refused = await send(core, `jester-${model.providerId}`, {
        identityId: "jester",
        model,
      });

      expect(refused.status).toBe(503);
      expect(refused.body.error).toMatchObject({
        code: "unavailable",
        details: { reason: "jester_runs_on_hermes" },
      });
    }
    expect(node.jobs()).toHaveLength(1);

    rmSync(directory, { recursive: true, force: true });
  });

  it("outside an active Objective a delegation waits for the owner, and a decline refuses it", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);

    await setDefault(core);
    await send(core, "parent-free");
    await waitFor(() => node.jobs().length === 1, "the parent turn");
    const parentJob = lastTurnJob(node).assignment.jobId;

    node.frame({
      kind: "delegate",
      jobId: parentJob,
      delegation: { delegationId: DELEGATION_A, runtime: "codex", prompt: "draw" },
    });

    await waitFor(
      async () => (await delegationApprovals(core)).length === 1,
      "the delegation approval",
    );
    const [first] = await delegationApprovals(core);
    expect(first).toMatchObject({ outcome: "require_confirmation", nodeJobId: parentJob });
    expect(node.jobs()).toHaveLength(1);

    const confirmed = await command(core, "authority.confirm", {
      idempotencyKey: "confirm-delegation",
      requestId: first?.id,
    });
    expect(confirmed.status).toBe(200);
    await waitFor(() => node.jobs().length === 2, "the child turn after confirmation");

    node.frame({
      kind: "delegate",
      jobId: parentJob,
      delegation: { delegationId: DELEGATION_B, runtime: "codex", prompt: "draw again" },
    });
    await waitFor(
      async () => (await delegationApprovals(core)).length === 2,
      "the second approval",
    );
    const second = (await delegationApprovals(core)).find((a) => a.id !== first?.id);

    const declined = await command(core, "authority.decline", {
      idempotencyKey: "decline-delegation",
      requestId: second?.id,
    });
    expect(declined.status).toBe(200);
    await waitFor(() => delegatedResults(node).length === 1, "the refusal");
    expect(delegatedResults(node)[0]?.result).toMatchObject({
      delegationId: DELEGATION_B,
      outcome: "refused",
    });
    expect(node.jobs()).toHaveLength(2);

    rmSync(directory, { recursive: true, force: true });
  });

  it("a delegation continues only a thread its own parent started", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);
    const objectiveId = await activeObjective(core, "foreign");

    await setDefault(core);
    const parent = await send(core, "parent-a", { objectiveId });
    await waitFor(() => node.jobs().length === 1, "the parent turn");

    // The parent's own thread is a real thread, and not one this turn delegated.
    node.frame({
      kind: "delegate",
      jobId: lastTurnJob(node).assignment.jobId,
      delegation: {
        delegationId: DELEGATION_A,
        runtime: "codex",
        prompt: "continue other work",
        threadId: parent.body.threadId,
      },
    });
    await waitFor(() => delegatedResults(node).length === 1, "the refusal");
    expect(delegatedResults(node)[0]?.result).toMatchObject({ outcome: "refused" });
    expect(node.jobs()).toHaveLength(1);

    rmSync(directory, { recursive: true, force: true });
  });

  it("the owner continues a delegated thread by naming it", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);
    const objectiveId = await activeObjective(core, "owner-continues");

    await setDefault(core);
    await send(core, "parent-o", { objectiveId });
    await waitFor(() => node.jobs().length === 1, "the parent turn");

    node.frame({
      kind: "delegate",
      jobId: lastTurnJob(node).assignment.jobId,
      delegation: { delegationId: DELEGATION_A, runtime: "codex", prompt: "draw" },
    });
    await waitFor(() => node.jobs().length === 2, "the child turn");
    const child = lastTurnJob(node);
    finishChild(node, child.assignment.jobId, "drawn", "child-session");
    await waitFor(() => delegatedResults(node).length === 1, "the delegation result");

    const continued = await send(core, "owner-follow-up", { threadId: child.payload.threadId });
    expect(continued.status).toBe(200);
    expect(continued.body.threadId).toBe(child.payload.threadId);
    await waitFor(() => node.jobs().length === 3, "the owner's turn");
    expect(lastTurnJob(node).payload).toMatchObject({
      threadId: child.payload.threadId,
      sessionRef: "child-session",
    });

    const unknown = await send(core, "owner-unknown", { threadId: OUTPUT_ATTACHMENT });
    expect(unknown.status).toBe(404);

    rmSync(directory, { recursive: true, force: true });
  });

  it("a node hands over an output's bytes for a job it holds, and the page reads them back", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);

    await setDefault(core);
    await send(core, "outputs");
    await waitFor(() => node.jobs().length === 1, "the turn");
    const jobId = lastTurnJob(node).assignment.jobId;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const headers = {
      "content-type": "image/png",
      "x-noctis-filename": "frame.png",
      "x-noctis-job": jobId,
    };

    const anonymous = await fetch(`${core.base}/node/outputs`, {
      method: "POST",
      headers,
      body: png,
    });
    expect(anonymous.status).toBe(401);
    await anonymous.body?.cancel();

    const foreignJob = await fetch(`${core.base}/node/outputs`, {
      method: "POST",
      headers: { ...headers, authorization: node.bearer(), "x-noctis-job": OUTPUT_ATTACHMENT },
      body: png,
    });
    expect(foreignJob.status).toBe(403);
    await foreignJob.body?.cancel();

    const stored = await fetch(`${core.base}/node/outputs`, {
      method: "POST",
      headers: { ...headers, authorization: node.bearer() },
      body: png,
    });
    expect(stored.status).toBe(200);
    const record = (await stored.json()) as Body;
    expect(record).toMatchObject({ filename: "frame.png", mediaType: "image/png", sizeBytes: 11 });

    const content = await fetch(`${core.base}/attachments/${record.id as string}/content`, {
      headers: authorized(),
    });
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(png);

    rmSync(directory, { recursive: true, force: true });
  });
});

describe("a session started outside Noctis", () => {
  async function adopt(core: TestCore, node: FakeNode, extra: Record<string, unknown> = {}) {
    return command(core, "conversation.adopt_session", {
      idempotencyKey: `adopt-${JSON.stringify(extra)}`,
      identityId: "vesper",
      nodeId: node.nodeId,
      rootGrantId: "d",
      providerId: "codex",
      sessionRef: "vscode-thread",
      title: "Draft the cold open",
      ...extra,
    });
  }

  it("THE GATE: is adopted as a pinned thread, forked on its first turn, and resumed after", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);

    const adopted = await adopt(core, node);
    expect(adopted.status).toBe(200);
    expect(adopted.body).toMatchObject({
      kind: "named",
      title: "Draft the cold open",
      nodeId: node.nodeId,
      rootGrantId: "d",
      providerId: "codex",
    });
    const threadId = adopted.body.id as string;

    // No default model is set: a pinned thread's agent chooses its own.
    const first = await send(core, "adopted-1", { threadId });
    expect(first.status).toBe(200);
    expect(first.body.threadId).toBe(threadId);
    await waitFor(() => node.jobs().length === 1, "the first job");

    const forked = lastTurnJob(node);
    expect(forked.payload).toMatchObject({
      sessionRef: "vscode-thread",
      forkSession: true,
      primaryRootGrantId: "d",
      model: MODEL,
    });
    expect(forked.assignment.nodeId).toBe(node.nodeId);

    node.frame({
      kind: "result",
      jobId: forked.assignment.jobId,
      outcome: "succeeded",
      evidence: { model: MODEL, sessionRef: "fork-1", itemCount: 1, stoppedReason: "completed" },
    });
    await waitFor(
      async () =>
        (await read(core, `/turns/${first.body.id as string}`)).body.status === "completed",
      "the forked turn to complete",
    );

    await send(core, "adopted-2", { threadId });
    await waitFor(() => node.jobs().length === 2, "the second job");

    const resumed = lastTurnJob(node).payload;
    expect(resumed.sessionRef).toBe("fork-1");
    expect(resumed.forkSession).toBe(undefined);

    // Free chat is still its own thread beside it.
    await setDefault(core);
    const free = await send(core, "free-1");
    expect(free.status).toBe(200);
    expect(free.body.threadId).not.toBe(threadId);

    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses another agent's model on a thread pinned to one", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);
    const adopted = await adopt(core, node);

    const refused = await send(core, "other-agent", {
      threadId: adopted.body.id,
      model: { providerId: "claude", model: "sonnet" },
    });
    expect(refused.status).toBe(503);
    expect(JSON.stringify(refused.body)).toContain("thread_runs_on_codex");
    expect(node.jobs()).toHaveLength(0);

    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses a folder the PC does not share with that agent", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);

    expect((await adopt(core, node, { providerId: "claude" })).status).toBe(404);
    expect((await adopt(core, node, { rootGrantId: "elsewhere" })).status).toBe(404);

    rmSync(directory, { recursive: true, force: true });
  });

  it("THE GATE: shows what was said before Noctis, read from the adopted session even after the fork", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);
    const adopted = await adopt(core, node);
    const threadId = adopted.body.id as string;
    expect(adopted.body.adoptedSessionRef).toBe("vscode-thread");

    // The first turn swaps the thread onto its fork, whose transcript also holds Noctis's turns.
    const first = await send(core, "adopted-1", { threadId });
    await waitFor(() => node.jobs().length === 1, "the first job");
    node.frame({
      kind: "result",
      jobId: lastTurnJob(node).assignment.jobId,
      outcome: "succeeded",
      evidence: { model: MODEL, sessionRef: "fork-1", itemCount: 1, stoppedReason: "completed" },
    });
    await waitFor(
      async () =>
        (await read(core, `/turns/${first.body.id as string}`)).body.status === "completed",
      "the forked turn to complete",
    );

    const exchanges = [{ prompt: "Draft the cold open", reply: "Here it is." }];
    const history = read(core, `/threads/${threadId}/history`);
    await waitFor(() => node.jobs().length === 2, "the session.history job");

    const job = NodeJobAssignmentSchema.parse(JSON.parse(node.jobs()[1]?.assignment ?? "{}"));
    expect(job).toMatchObject({
      capability: "session.history",
      nodeId: node.nodeId,
      payload: { rootGrantId: "d", providerId: "codex", sessionRef: "vscode-thread" },
    });
    node.frame({ kind: "result", jobId: job.jobId, outcome: "succeeded", evidence: { exchanges } });

    expect(await history).toEqual({ status: 200, body: { exchanges } });

    // A conversation that adopted nothing has no history before Noctis.
    const fresh = await command(core, "conversation.create_thread", {
      idempotencyKey: "fresh",
      identityId: "vesper",
    });
    expect((await read(core, `/threads/${fresh.body.id as string}/history`)).status).toBe(404);

    rmSync(directory, { recursive: true, force: true });
  });

  it("lists a shared folder's sessions through the node that holds it", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory);
    const sessions = [
      {
        providerId: "codex",
        sessionRef: "vscode-thread",
        title: "Draft the cold open",
        lastActiveAt: "2026-10-08T12:00:00.000Z",
        source: "vscode",
      },
    ];

    const listing = read(core, `/sessions?node=${node.nodeId}&root=d`);
    await waitFor(() => node.jobs().length === 1, "the session.list job");

    const job = NodeJobAssignmentSchema.parse(JSON.parse(node.jobs()[0]?.assignment ?? "{}"));
    expect(job).toMatchObject({ capability: "session.list", payload: { rootGrantId: "d" } });
    node.frame({ kind: "result", jobId: job.jobId, outcome: "succeeded", evidence: { sessions } });

    expect(await listing).toEqual({ status: 200, body: { sessions } });

    rmSync(directory, { recursive: true, force: true });
  });
});

describe("many conversations", () => {
  it("THE GATE: the owner opens new conversations beside free chat, and lists them by last activity", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    await connectFake(core, directory);
    await setDefault(core);

    const storyboard = await command(core, "conversation.create_thread", {
      idempotencyKey: "new-storyboard",
      identityId: "vesper",
      title: "Storyboard pass",
    });
    expect(storyboard.status).toBe(200);
    expect(storyboard.body).toMatchObject({ kind: "named", title: "Storyboard pass" });

    const untitled = await command(core, "conversation.create_thread", {
      idempotencyKey: "new-untitled",
      identityId: "vesper",
    });

    expect((await send(core, "free-first")).status).toBe(200);
    await send(core, "storyboard-first", { threadId: storyboard.body.id });

    const listed = await read(core, "/conversations?identityId=vesper");
    expect(listed.status).toBe(200);

    const conversations = listed.body.conversations as Body[];
    // Newest activity first; a conversation nobody has written in yet sorts by when it was opened.
    expect(conversations.map((conversation) => conversation.id)).toEqual([
      storyboard.body.id,
      expect.any(String),
      untitled.body.id,
    ]);
    expect(conversations[0]).toMatchObject({
      title: "Storyboard pass",
      preview: "prompt storyboard-first",
    });
    expect(conversations[1]).toMatchObject({ kind: "free", preview: "prompt free-first" });
    expect(conversations[2]?.preview).toBe(undefined);

    // Jester's conversations are Jester's.
    expect((await read(core, "/conversations?identityId=jester")).body).toEqual({
      conversations: [],
    });

    rmSync(directory, { recursive: true, force: true });
  });

  it("renames a conversation, archives it off the list, and restores it", async () => {
    const core = await startTestCore();
    const created = await command(core, "conversation.create_thread", {
      idempotencyKey: "to-rename",
      identityId: "vesper",
    });
    const threadId = created.body.id as string;
    const ids = async (query = "") =>
      (
        (await read(core, `/conversations?identityId=vesper${query}`)).body.conversations as Body[]
      ).map((conversation) => conversation.id);

    const renamed = await command(core, "conversation.rename_thread", {
      idempotencyKey: "rename",
      threadId,
      title: "Hook tests",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: threadId, title: "Hook tests" });

    const archived = await command(core, "conversation.archive_thread", {
      idempotencyKey: "archive",
      threadId,
      archived: true,
    });
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toEqual(expect.any(String));
    expect(await ids()).not.toContain(threadId);
    expect(await ids("&archived=1")).toEqual([threadId]);

    const restored = await command(core, "conversation.archive_thread", {
      idempotencyKey: "restore",
      threadId,
      archived: false,
    });
    expect(restored.body.archivedAt).toBe(undefined);
    expect(await ids()).toContain(threadId);
    expect(await ids("&archived=1")).toEqual([]);

    // Free chat is where a message with no thread goes: it keeps its name and its place.
    await setDefault(core);
    const free = await send(core, "free-chat");
    for (const [name, extra] of [
      ["conversation.rename_thread", { title: "Mine" }],
      ["conversation.archive_thread", { archived: true }],
    ] as const) {
      const refused = await command(core, name, {
        idempotencyKey: `free-${name}`,
        threadId: free.body.threadId,
        ...extra,
      });
      expect(refused.status).toBe(404);
    }
  });

  it("starts free chat afresh, keeping the old one as a conversation on the list", async () => {
    const core = await startTestCore();
    const startFresh = (key: string) =>
      command(core, "conversation.start_fresh", { idempotencyKey: key, identityId: "vesper" });

    expect((await startFresh("nothing-yet")).status).toBe(404);

    await setDefault(core);
    const old = (await send(core, "old-free")).body.threadId as string;

    const fresh = await startFresh("fresh");
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ id: old, kind: "named" });
    expect((await read(core, "/threads?identityId=vesper")).status).toBe(404);

    const next = (await send(core, "new-free")).body.threadId as string;
    expect(next).not.toBe(old);
    expect((await read(core, "/threads?identityId=vesper")).body.id).toBe(next);

    const listed = (await read(core, "/conversations?identityId=vesper")).body
      .conversations as Body[];
    expect(listed.map((conversation) => conversation.id).sort()).toEqual([old, next].sort());
  });
});

describe("waking an agent before the owner sends", () => {
  const HERMES_MODEL = { providerId: "hermes", model: "qwen3.5-9b" };
  const HERMES_PROBE = {
    providerId: "hermes",
    available: true,
    authMode: "local",
    models: [HERMES_MODEL],
  };

  function lastJob(node: FakeNode) {
    const job = node.jobs().at(-1);

    if (job === undefined) {
      throw new Error("no job frame");
    }

    return NodeJobAssignmentSchema.parse(JSON.parse(job.assignment));
  }

  const wake = (core: TestCore, key: string, extra: Record<string, unknown> = {}) =>
    command(core, "conversation.warm", { idempotencyKey: key, identityId: "jester", ...extra });

  const turnCount = (core: TestCore): number =>
    (core.core.kernel.db.prepare("SELECT COUNT(*) AS n FROM identity_turns").get() as { n: number })
      .n;

  it("THE GATE: waking Jester sends a warm job with nothing said, and records no turn", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory, {
      providers: ["codex", "hermes"],
      probes: [CODEX_PROBE, HERMES_PROBE],
    });

    expect((await wake(core, "wake-1")).status).toBe(200);
    await waitFor(() => node.jobs().length === 1, "the warm job");

    const job = lastJob(node);
    expect(job.capability).toBe("runtime.warm");
    expect(job.payload).toMatchObject({ identityId: "jester", model: HERMES_MODEL });
    expect(job.payload).not.toHaveProperty("prompt");
    expect(turnCount(core)).toBe(0);

    const identities = await read(core, "/identities");
    const jester = (
      identities.body.threads as Array<{ identityId: string; awakeUntil?: string }>
    ).find((thread) => thread.identityId === "jester");
    expect(Date.parse(jester?.awakeUntil ?? "")).toBeGreaterThan(core.core.kernel.clock.now());

    rmSync(directory, { recursive: true, force: true });
  });

  it("waking does not choose the next turn's model", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const OTHER = { providerId: "hermes", model: "qwen3.5-27b" };
    const node = await connectFake(core, directory, {
      providers: ["codex", "hermes"],
      probes: [CODEX_PROBE, { ...HERMES_PROBE, models: [HERMES_MODEL, OTHER] }],
    });

    await wake(core, "wake-2");
    await waitFor(() => node.jobs().length === 1, "the warm job");
    await send(core, "after-wake", { identityId: "jester", model: OTHER });
    await waitFor(() => node.jobs().length === 2, "the turn");

    expect(lastTurnJob(node).payload.model).toEqual(OTHER);

    rmSync(directory, { recursive: true, force: true });
  });

  it("waking again sends one more job, and is cheap", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory, {
      providers: ["codex", "hermes"],
      probes: [CODEX_PROBE, HERMES_PROBE],
    });

    await wake(core, "wake-4");
    await waitFor(() => node.jobs().length === 1, "the first warm job");
    expect((await wake(core, "wake-5")).status).toBe(200);
    await waitFor(() => node.jobs().length === 2, "the second warm job");
    expect(lastJob(node).capability).toBe("runtime.warm");
    expect(turnCount(core)).toBe(0);

    rmSync(directory, { recursive: true, force: true });
  });

  it("no PC, no wake: refused, and nothing says the agent is awake", async () => {
    const core = await startTestCore();

    expect((await wake(core, "wake-3")).status).toBeGreaterThanOrEqual(400);

    const identities = await read(core, "/identities");
    expect(JSON.stringify(identities.body)).not.toContain("awakeUntil");
  });
});

describe("a conversation keeps the model and folder it was last given", () => {
  const MINI = { providerId: "codex", model: "gpt-5.6-mini" };
  const TWO_MODELS = {
    providers: ["codex"],
    probes: [{ ...CODEX_PROBE, models: [MODEL, MINI] }],
  };

  async function complete(core: TestCore, node: FakeNode, turnId: string, sessionRef: string) {
    node.frame({
      kind: "result",
      jobId: lastTurnJob(node).assignment.jobId,
      outcome: "succeeded",
      evidence: { model: MODEL, sessionRef, itemCount: 1, stoppedReason: "completed" },
    });
    await waitFor(
      async () => (await read(core, `/turns/${turnId}`)).body.status === "completed",
      "the turn to complete",
    );
  }

  async function shareSecondFolder(core: TestCore, node: FakeNode, path: string): Promise<void> {
    const shared = await command(core, "node.grant_capability", {
      idempotencyKey: "share-second",
      nodeId: node.nodeId,
      capability: "runtime.turn",
      constraints: { providers: ["codex"], roots: [{ grantId: "later", path, mode: "write" }] },
    });
    expect(shared.status).toBe(200);
  }

  it("a message that names no model runs on the conversation's last model, not the default", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory, TWO_MODELS);

    await setDefault(core);
    const first = await send(core, "sticky-1", { model: MINI });
    await waitFor(() => node.jobs().length === 1, "the first job");
    await complete(core, node, first.body.id as string, "sess-1");

    await send(core, "sticky-2", { threadId: first.body.threadId });
    await waitFor(() => node.jobs().length === 2, "the second job");

    expect(lastTurnJob(node).payload.model).toEqual(MINI);

    rmSync(directory, { recursive: true, force: true });
  });

  it("each turn says which folder it ran in", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    await connectFake(core, directory);

    await setDefault(core);
    const sent = await send(core, "folder-1");

    expect(sent.body.rootGrantId).toBe("d");
    const turns = await read(core, `/threads/${sent.body.threadId as string}/turns`);
    expect((turns.body.turns as Body[])[0]?.rootGrantId).toBe("d");

    rmSync(directory, { recursive: true, force: true });
  });

  it("another folder starts a fresh session and says so; the same folder resumes it", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const later = mkdtempSync(join(tmpdir(), "noctis-root-later-"));
    const node = await connectFake(core, directory);
    await shareSecondFolder(core, node, later);

    await setDefault(core);
    const first = await send(core, "move-1", { rootGrantId: "d" });
    const threadId = first.body.threadId as string;
    await waitFor(() => node.jobs().length === 1, "the first job");
    await complete(core, node, first.body.id as string, "sess-d");

    const moved = await send(core, "move-2", { threadId, rootGrantId: "later" });
    await waitFor(() => node.jobs().length === 2, "the moved job");
    expect(lastTurnJob(node).payload).toMatchObject({ primaryRootGrantId: "later" });
    expect(lastTurnJob(node).payload.sessionRef).toBe(undefined);

    const messages = (await read(core, `/threads/${threadId}/messages`)).body.messages as Body[];
    const notes = messages.filter((message) => message.role === "system");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toMatch(/fresh session/);

    await complete(core, node, moved.body.id as string, "sess-later");
    await send(core, "move-3", { threadId, rootGrantId: "later" });
    await waitFor(() => node.jobs().length === 3, "the third job");
    expect(lastTurnJob(node).payload.sessionRef).toBe("sess-later");

    rmSync(directory, { recursive: true, force: true });
    rmSync(later, { recursive: true, force: true });
  });

  it("a continued session takes another model of its own agent, and keeps it", async () => {
    const core = await startTestCore();
    const directory = mkdtempSync(join(tmpdir(), "noctis-root-"));
    const node = await connectFake(core, directory, TWO_MODELS);
    const adopted = await command(core, "conversation.adopt_session", {
      idempotencyKey: "adopt-mini",
      identityId: "vesper",
      nodeId: node.nodeId,
      rootGrantId: "d",
      providerId: "codex",
      sessionRef: "vscode-thread",
      title: "Reveal video",
    });
    const threadId = adopted.body.id as string;

    const first = await send(core, "pinned-mini", { threadId, model: MINI });
    expect(first.status).toBe(200);
    await waitFor(() => node.jobs().length === 1, "the first job");
    expect(lastTurnJob(node).payload).toMatchObject({ model: MINI, forkSession: true });
    await complete(core, node, first.body.id as string, "fork-1");

    await send(core, "pinned-again", { threadId });
    await waitFor(() => node.jobs().length === 2, "the second job");
    expect(lastTurnJob(node).payload).toMatchObject({ model: MINI, sessionRef: "fork-1" });

    rmSync(directory, { recursive: true, force: true });
  });
});
