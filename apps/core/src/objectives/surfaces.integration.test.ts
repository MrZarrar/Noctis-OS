import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompositionPlan, SurfaceIntent } from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { CoreConfig } from "../config/server.js";
import { createLogger } from "../logging.js";
import type { RunningCore } from "../server.js";
import { startCore } from "../server.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const START = Date.parse("2026-09-06T12:00:00.000Z");
const CLIENT = "workbench-1";
const FINGERPRINT = "3440x1440@1";
const NO_AUTOMATIC_SWEEP_MS = 3_600_000;

let keySequence = 0;

function key(label: string): string {
  keySequence += 1;
  return `${label}-${String(keySequence)}`;
}

interface TestCore {
  core: RunningCore;
  base: string;
}

const directories: string[] = [];
const running: RunningCore[] = [];

/** Starting a second core against the same directory is a restart, not a new machine. */
async function startAt(directory: string, offsetMs = 0): Promise<TestCore> {
  const config: CoreConfig = {
    bindAddress: "127.0.0.1",
    port: 0,
    token: TOKEN,
    databasePath: join(directory, "core.db"),
    allowedOrigins: [],
    logLevel: "error",
  };

  const core = await startCore({
    config,
    clock: { now: () => START + offsetMs },
    logger: createLogger({ sink: () => undefined, level: "error" }),
    dispatchIntervalMs: NO_AUTOMATIC_SWEEP_MS,
  });

  running.push(core);

  return { core, base: `http://127.0.0.1:${String(core.port)}` };
}

async function freshCore(): Promise<TestCore & { directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), "noctis-surfaces-"));
  directories.push(directory);

  return { ...(await startAt(directory)), directory };
}

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }

  while (directories.length > 0) {
    const directory = directories.pop();

    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function headers(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
}

async function command(
  core: TestCore,
  name: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${core.base}/commands/${name}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function read(
  core: TestCore,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${core.base}${path}`, { headers: headers() });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function activeObjective(core: TestCore): Promise<string> {
  const created = await command(core, "objective.create", {
    idempotencyKey: key("create"),
    title: "Ship the Phase 6 slice",
    intent: "Compose Surfaces deterministically",
    status: "draft",
    identityId: "vesper",
    protocolIds: [],
  });

  expect(created.status).toBe(200);

  const activated = await command(core, "objective.change_status", {
    idempotencyKey: key("activate"),
    objectiveId: created.body.id,
    expectedRevision: 0,
    status: "active",
  });

  expect(activated.status).toBe(200);

  return created.body.id as string;
}

async function upsert(
  core: TestCore,
  objectiveId: string,
  overrides: Record<string, unknown> = {},
): Promise<SurfaceIntent> {
  const response = await command(core, "surface.upsert_intent", {
    idempotencyKey: key("upsert"),
    objectiveId,
    kind: "detail",
    role: "primary",
    persistence: "objective",
    priority: 0,
    minSize: "compact",
    payloadVersion: 1,
    payload: { title: "Detail" },
    ...overrides,
  });

  expect(response.status).toBe(200);

  return response.body as unknown as SurfaceIntent;
}

async function composed(
  core: TestCore,
  objectiveId: string,
  extra: Record<string, unknown> = {},
): Promise<{ plan: CompositionPlan; changed: boolean }> {
  const response = await command(core, "surface.compose", {
    idempotencyKey: key("compose"),
    objectiveId,
    clientId: CLIENT,
    display: { fingerprint: FINGERPRINT, widthPx: 3440 },
    attentionState: "active_canvas",
    ...extra,
  });

  expect(response.status).toBe(200);

  return response.body as unknown as { plan: CompositionPlan; changed: boolean };
}

function surfacesPath(objectiveId: string): string {
  return (
    `/objectives/${objectiveId}/surfaces?clientId=${CLIENT}` +
    `&fingerprint=${encodeURIComponent(FINGERPRINT)}&widthPx=3440&attentionState=active_canvas`
  );
}

describe("the Objective and Surface vertical slice", () => {
  it("points the identity thread at the Objective it activated", async () => {
    const core = await freshCore();
    const objectiveId = await activeObjective(core);
    const identities = await read(core, "/identities");
    const threads = identities.body.threads as Array<Record<string, unknown>>;

    expect(threads.find((thread) => thread.identityId === "vesper")?.activeObjectiveId).toBe(
      objectiveId,
    );
  });

  it("upserts a Surface by identity instead of duplicating it", async () => {
    const core = await freshCore();
    const objectiveId = await activeObjective(core);
    const first = await upsert(core, objectiveId, { priority: 1 });
    const second = await upsert(core, objectiveId, { priority: 7 });

    expect(second.id).toBe(first.id);
    expect(second.priority).toBe(7);

    const listed = await read(core, surfacesPath(objectiveId));

    expect((listed.body.intents as unknown[]).length).toBe(1);
  });

  it("refuses a lifecycle transition the state machine does not allow", async () => {
    const core = await freshCore();
    const objectiveId = await activeObjective(core);
    const intent = await upsert(core, objectiveId);

    expect(intent.lifecycle).toBe("proposed");

    const response = await command(core, "surface.change_lifecycle", {
      idempotencyKey: key("lifecycle"),
      surfaceId: intent.id,
      lifecycle: "active",
    });

    expect(response.status).toBe(409);
    expect((response.body.error as Record<string, unknown>).code).toBe("forbidden_transition");
  });

  it("drops a dismissed Surface out of the composition", async () => {
    const core = await freshCore();
    const objectiveId = await activeObjective(core);
    const intent = await upsert(core, objectiveId);

    expect((await composed(core, objectiveId)).plan.slots).toHaveLength(1);

    const dismissed = await command(core, "surface.change_lifecycle", {
      idempotencyKey: key("dismiss"),
      surfaceId: intent.id,
      lifecycle: "dismissed",
    });

    expect(dismissed.status).toBe(200);

    const after = await composed(core, objectiveId);

    expect(after.plan.slots).toHaveLength(0);
    expect(after.changed).toBe(true);
  });

  it("commits a snapshot only when the composition actually changed", async () => {
    const core = await freshCore();
    const objectiveId = await activeObjective(core);
    await upsert(core, objectiveId);

    expect((await composed(core, objectiveId)).changed).toBe(true);
    expect((await composed(core, objectiveId)).changed).toBe(false);
  });

  it("honours then releases a user override for this display", async () => {
    const core = await freshCore();
    const objectiveId = await activeObjective(core);
    const intent = await upsert(core, objectiveId);

    expect((await composed(core, objectiveId)).plan.slots[0]?.region).toBe("centre");

    const set = await command(core, "surface.set_override", {
      idempotencyKey: key("override"),
      surfaceId: intent.id,
      clientId: CLIENT,
      displayFingerprint: FINGERPRINT,
      region: "left",
      size: "standard",
    });

    expect(set.status).toBe(200);
    expect((await composed(core, objectiveId)).plan.slots[0]?.region).toBe("left");

    const released = await command(core, "surface.release_override", {
      idempotencyKey: key("release"),
      surfaceId: intent.id,
      clientId: CLIENT,
      displayFingerprint: FINGERPRINT,
    });

    expect(released.status).toBe(200);
    expect((await composed(core, objectiveId)).plan.slots[0]?.region).toBe("centre");
  });

  it("keeps an override on the display it was made on", async () => {
    const core = await freshCore();
    const objectiveId = await activeObjective(core);
    const intent = await upsert(core, objectiveId);

    await command(core, "surface.set_override", {
      idempotencyKey: key("override"),
      surfaceId: intent.id,
      clientId: CLIENT,
      displayFingerprint: "1920x1080@1",
      region: "left",
      size: "standard",
    });

    expect((await composed(core, objectiveId)).plan.slots[0]?.region).toBe("centre");
  });

  it("answers a replayed compose with the plan it committed", async () => {
    const core = await freshCore();
    const objectiveId = await activeObjective(core);
    await upsert(core, objectiveId);

    const idempotencyKey = key("replay");
    const body = {
      idempotencyKey,
      objectiveId,
      clientId: CLIENT,
      display: { fingerprint: FINGERPRINT, widthPx: 3440 },
      attentionState: "active_canvas",
    };

    const first = await command(core, "surface.compose", body);
    const retry = await command(core, "surface.compose", body);

    expect(retry.status).toBe(200);
    expect((retry.body as { plan: CompositionPlan }).plan.slots).toEqual(
      (first.body as { plan: CompositionPlan }).plan.slots,
    );
  });

  it("rejects a command that tries to place a Surface by geometry", async () => {
    const core = await freshCore();
    const objectiveId = await activeObjective(core);

    const response = await command(core, "surface.upsert_intent", {
      idempotencyKey: key("geometry"),
      objectiveId,
      kind: "detail",
      role: "primary",
      persistence: "objective",
      priority: 0,
      minSize: "compact",
      payloadVersion: 1,
      payload: {},
      x: 10,
      y: 20,
      width: 640,
      zIndex: 99,
    });

    expect(response.status).toBe(400);
    expect((response.body.error as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("THE GATE: restores the Objective, composition, and pinned context after a restart", async () => {
    const first = await freshCore();
    const objectiveId = await activeObjective(first);
    const pinned = await upsert(first, objectiveId, {
      kind: "conversation",
      role: "supporting",
      persistence: "pinned",
    });
    await upsert(first, objectiveId, { kind: "detail" });

    await command(first, "surface.set_override", {
      idempotencyKey: key("override"),
      surfaceId: pinned.id,
      clientId: CLIENT,
      displayFingerprint: FINGERPRINT,
      region: "left",
      size: "standard",
    });

    const before = await composed(first, objectiveId);

    expect(before.plan.slots).toHaveLength(2);

    await running.pop()?.close();

    // A different process, a different port, the same database.
    const restarted = await startAt(first.directory, 60_000);
    const identities = await read(restarted, "/identities");
    const threads = identities.body.threads as Array<Record<string, unknown>>;

    expect(threads.find((thread) => thread.identityId === "vesper")?.activeObjectiveId).toBe(
      objectiveId,
    );

    const restored = await read(restarted, surfacesPath(objectiveId));
    const plan = restored.body.plan as CompositionPlan;
    const snapshot = restored.body.snapshot as CompositionPlan;

    expect(plan.slots).toEqual(before.plan.slots);
    expect(plan.reasonCodes).toEqual(before.plan.reasonCodes);
    expect(snapshot.slots).toEqual(before.plan.slots);
    // Regenerated, not replayed: the plan is fresh, the arrangement is not.
    expect(plan.generatedAt).not.toBe(before.plan.generatedAt);
  });

  it("records a composition change on the event stream", async () => {
    const core = await freshCore();
    const objectiveId = await activeObjective(core);
    await upsert(core, objectiveId);
    await composed(core, objectiveId);

    const events = await read(core, "/events?after=0");
    const names = (events.body.events as Array<{ type: string }>).map((event) => event.type);

    expect(names).toContain("surface.intent_upserted.v1");
    expect(names).toContain("surface.composition_changed.v1");
  });
});
