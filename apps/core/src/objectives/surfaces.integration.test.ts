import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompositionPlan, SurfaceIntent } from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { composeSurfaces, upsertSurfaceIntent } from "./surface-intents.js";

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
    sessionTtlHours: 720,
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

/**
 * A draft Objective: created, not activated.
 *
 * Activation is what makes the core propose the three seed Surfaces
 * (`objectives/proposed-surfaces.ts`), and a test asserting on exactly the
 * Surfaces it created itself needs a canvas nobody else has written to. A draft
 * composes exactly like an active one — the compositor takes an Objective id and
 * a display, and asks nothing about status.
 */
async function draftObjective(core: TestCore): Promise<string> {
  const created = await command(core, "objective.create", {
    idempotencyKey: key("create"),
    title: "Ship the Phase 6 slice",
    intent: "Compose Surfaces deterministically",
    status: "draft",
    identityId: "vesper",
    protocolIds: [],
  });

  expect(created.status).toBe(200);

  return created.body.id as string;
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
  it("keeps updated panels hidden and restores the same closed intent", async () => {
    const core = await freshCore();
    const objectiveId = await draftObjective(core);
    const first = await upsert(core, objectiveId, {
      kind: "detail",
      role: "supporting",
      sourceIds: ["0199a000-0000-7000-8000-0000000000d1"],
    });
    expect(
      (
        await command(core, "surface.arrange", {
          idempotencyKey: key("hide"),
          objectiveId,
          clientId: CLIENT,
          display: { fingerprint: FINGERPRINT, widthPx: 3440 },
          attentionState: "active_canvas",
          placements: [{ surfaceId: first.id, region: "overflow", size: "compact" }],
        })
      ).status,
    ).toBe(200);
    const updated = await upsert(core, objectiveId, {
      kind: "detail",
      role: "supporting",
      sourceIds: first.sourceIds,
      payload: { title: "Updated" },
    });
    expect(updated.id).toBe(first.id);
    expect((await composed(core, objectiveId)).plan.overflowSurfaceIds).toContain(first.id);
    for (const lifecycle of ["dismissed", "proposed"]) {
      expect(
        (
          await command(core, "surface.change_lifecycle", {
            idempotencyKey: key(lifecycle),
            surfaceId: first.id,
            lifecycle,
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await command(core, "surface.arrange", {
          idempotencyKey: key("show"),
          objectiveId,
          clientId: CLIENT,
          display: { fingerprint: FINGERPRINT, widthPx: 3440 },
          attentionState: "active_canvas",
          placements: [{ surfaceId: first.id, region: "centre", size: "compact" }],
        })
      ).status,
    ).toBe(200);
    const response = await read(core, surfacesPath(objectiveId));
    const intents = response.body.intents as SurfaceIntent[];
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ id: first.id, payload: { title: "Updated" } });
    expect((await composed(core, objectiveId)).plan.slots.map((slot) => slot.surfaceId)).toContain(
      first.id,
    );
  });
  it("arranges panels atomically, swaps same-region order and isolates owners", async () => {
    const core = await freshCore();
    const objectiveId = await draftObjective(core);
    const first = await upsert(core, objectiveId, { kind: "one", role: "supporting" });
    const second = await upsert(core, objectiveId, { kind: "two", role: "supporting" });
    const scope = {
      objectiveId,
      clientId: CLIENT,
      display: { fingerprint: FINGERPRINT, widthPx: 3440 },
      attentionState: "active_canvas",
    };
    const slots = (await composed(core, objectiveId)).plan.slots;
    const placements = [first, second].map((intent) => ({
      surfaceId: intent.id,
      region: "right",
      size: "standard",
      order: slots.find((slot) => slot.surfaceId !== intent.id)!.order,
    }));
    const arrangeKey = key("arrange");
    expect(
      (
        await command(core, "surface.arrange", {
          ...scope,
          idempotencyKey: arrangeKey,
          placements,
        })
      ).status,
    ).toBe(200);
    const swapped = (await composed(core, objectiveId)).plan.slots;
    expect(swapped.map((slot) => slot.surfaceId)).toEqual(
      [...slots].reverse().map((slot) => slot.surfaceId),
    );
    const before = core.core.kernel.db.prepare("SELECT * FROM surface_overrides ORDER BY id").all();
    expect(
      (await command(core, "surface.arrange", { ...scope, idempotencyKey: arrangeKey, placements }))
        .status,
    ).toBe(200);
    expect(
      core.core.kernel.db.prepare("SELECT * FROM surface_overrides ORDER BY id").all(),
    ).toEqual(before);
    const foreign = await upsert(core, await draftObjective(core), { kind: "foreign" });
    const invalid = [
      { ...placements[0], region: "centre" },
      { ...placements[1], surfaceId: foreign.id },
    ];
    expect(
      (
        await command(core, "surface.arrange", {
          ...scope,
          idempotencyKey: key("foreign"),
          placements: invalid,
        })
      ).status,
    ).toBe(404);
    expect(
      core.core.kernel.db.prepare("SELECT * FROM surface_overrides ORDER BY id").all(),
    ).toEqual(before);
    core.core.kernel.db.exec(
      `CREATE TRIGGER refuse_second BEFORE UPDATE ON surface_overrides WHEN OLD.surface_id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'test failure'); END;`,
    );
    expect(
      (
        await command(core, "surface.arrange", {
          ...scope,
          idempotencyKey: key("rollback"),
          placements: placements.map((entry) => ({ ...entry, size: "wide" })),
        })
      ).status,
    ).toBe(500);
    expect(
      core.core.kernel.db.prepare("SELECT * FROM surface_overrides ORDER BY id").all(),
    ).toEqual(before);
    core.core.kernel.db.exec("DROP TRIGGER refuse_second");
    expect(
      (
        await command(core, "surface.arrange", {
          ...scope,
          idempotencyKey: key("unsupported"),
          display: { ...scope.display, widthPx: 1400 },
          placements: [{ ...placements[0], region: "left" }],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await command(core, "surface.arrange", {
          ...scope,
          idempotencyKey: key("overflow"),
          placements: [{ ...placements[0], region: "overflow" }],
        })
      ).status,
    ).toBe(200);
    expect((await composed(core, objectiveId)).plan.overflowSurfaceIds).toContain(first.id);
    expect(
      (
        await command(core, "surface.arrange", {
          ...scope,
          idempotencyKey: key("strict"),
          unexpected: true,
          placements,
        })
      ).status,
    ).toBe(400);
    for (const malformed of [
      { ...scope, objectiveId: undefined },
      { ...scope, presence: true },
      { ...scope, clientId: "" },
      { ...scope, display: { fingerprint: "", widthPx: 1400 } },
    ])
      expect(
        (
          await command(core, "surface.arrange", {
            ...malformed,
            idempotencyKey: key("malformed"),
            placements,
          })
        ).status,
      ).toBe(400);
  });
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
    const objectiveId = await draftObjective(core);
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
    const objectiveId = await draftObjective(core);
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
    const objectiveId = await draftObjective(core);
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
    const objectiveId = await draftObjective(core);
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

describe("thread and Presence panels", () => {
  it("rejects ambiguous owners in direct service calls before storing anything", async () => {
    const core = await freshCore();
    const objectiveId = await draftObjective(core);
    const context = {
      actorType: "user" as const,
      actorId: "local",
      correlationId: "0199a000-0000-7000-8000-000000000001",
    };
    for (const extra of [
      { threadId: "0199a000-0000-7000-8000-000000000002" },
      { presence: true as const },
    ]) {
      expect(() =>
        upsertSurfaceIntent(core.core.kernel, context, {
          idempotencyKey: key("direct"),
          objectiveId,
          ...extra,
          kind: "detail",
          role: "primary",
          persistence: "restorable",
          priority: 1,
          minSize: "compact",
          payloadVersion: 1,
          payload: {},
          sourceIds: [],
          artifactIds: [],
        }),
      ).toThrow();
      expect(() =>
        composeSurfaces(core.core.kernel, context, {
          idempotencyKey: key("direct-compose"),
          objectiveId,
          ...extra,
          clientId: CLIENT,
          display: { fingerprint: FINGERPRINT, widthPx: 3440 },
          attentionState: "active_canvas",
        }),
      ).toThrow();
    }
    expect(
      core.core.kernel.db.prepare("SELECT COUNT(*) AS count FROM surface_intents").get(),
    ).toEqual({ count: 0 });
    expect(
      core.core.kernel.db.prepare("SELECT COUNT(*) AS count FROM composition_snapshots").get(),
    ).toEqual({ count: 0 });
  });

  it("keeps three owners isolated and restores thread overrides and snapshots", async () => {
    const core = await freshCore();
    const objectiveId = await draftObjective(core);
    const createdThread = await command(core, "conversation.create_thread", {
      idempotencyKey: key("thread"),
      identityId: "vesper",
      title: "Panels",
    });
    expect(createdThread.status).toBe(200);
    const threadId = createdThread.body.id as string;
    const owners = [{ objectiveId }, { threadId }, { presence: true }];
    const paths = [
      surfacesPath(objectiveId),
      surfacesPath(objectiveId).replace(`/objectives/${objectiveId}`, `/threads/${threadId}`),
      surfacesPath(objectiveId).replace(`/objectives/${objectiveId}`, "/presence"),
    ];
    const intents: SurfaceIntent[] = [];
    for (const owner of owners) {
      const response = await command(core, "surface.upsert_intent", {
        idempotencyKey: key("owner"),
        ...owner,
        kind: "detail",
        role: "primary",
        persistence: "restorable",
        priority: 1,
        minSize: "compact",
        payloadVersion: 1,
        payload: { title: "Panel" },
      });
      expect(response.status).toBe(200);
      intents.push(response.body as unknown as SurfaceIntent);
      const composed = await command(core, "surface.compose", {
        idempotencyKey: key("owner-compose"),
        ...owner,
        clientId: CLIENT,
        display: { fingerprint: FINGERPRINT, widthPx: 3440 },
        attentionState: "active_canvas",
      });
      expect(composed.status).toBe(200);
    }
    expect(new Set(intents.map((intent) => intent.id)).size).toBe(3);
    for (const [index, path] of paths.entries()) {
      const response = await read(core, path);
      expect(response.status).toBe(200);
      expect((response.body.intents as SurfaceIntent[]).map((intent) => intent.id)).toEqual([
        intents[index]!.id,
      ]);
      expect(response.body.snapshot).not.toBeNull();
    }
    const surfaceId = intents[1]!.id;
    expect(
      (
        await command(core, "surface.set_override", {
          idempotencyKey: key("override"),
          surfaceId,
          clientId: CLIENT,
          displayFingerprint: FINGERPRINT,
          region: "left",
          size: "stage",
        })
      ).status,
    ).toBe(200);
    await core.core.close();
    running.splice(running.indexOf(core.core), 1);
    const restarted = await startAt(core.directory, 1000);
    const restored = await read(restarted, paths[1]!);
    expect((restored.body.plan as CompositionPlan).slots[0]?.region).toBe("left");
    expect((restored.body.overrides as Array<{ surfaceId: string }>)[0]?.surfaceId).toBe(surfaceId);
    expect(
      (
        await command(restarted, "surface.release_override", {
          idempotencyKey: key("release"),
          surfaceId,
          clientId: CLIENT,
          displayFingerprint: FINGERPRINT,
        })
      ).status,
    ).toBe(200);
    const released = await read(restarted, paths[1]!);
    expect(
      (released.body.overrides as Array<{ releasedAt?: string }>)[0]?.releasedAt,
    ).toBeDefined();
    expect(
      (await read(restarted, paths[1]!.replace(threadId, "0199a000-0000-7000-8000-000000000001")))
        .status,
    ).toBe(404);
    const events = (await read(restarted, "/events?after=0")).body.events as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;
    expect(
      events.some(
        (event) =>
          event.type === "surface.intent_upserted.v1" && event.payload.threadId === threadId,
      ),
    ).toBe(true);
  });
});
