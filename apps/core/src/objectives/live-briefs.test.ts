import { createIdFactory, fixedClock } from "@noctis/domain";
import type { OrchestrationEvent } from "@noctis/contracts";
import { LiveBriefPayloadSchema, PANEL_PROPOSABLE_KINDS } from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import type { Kernel } from "../kernel.js";
import { createLogger } from "../logging.js";
import { MIGRATIONS_DIRECTORY } from "../server.js";
import { reconcileLiveBriefs } from "./live-briefs.js";
import { proposeFor } from "./proposed-surfaces.js";
import { changeSurfaceLifecycle, listSurfaceIntents } from "./surface-intents.js";

const CLOCK = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));
const THREAD = "0199a000-0000-7000-8000-0000000000d1";
const JOB = "0199a000-0000-7000-8000-0000000000e1";
const CREATED = "2026-09-01T11:56:00.000Z";

let open: Kernel | undefined;

afterEach(() => {
  open?.db.close();
  open = undefined;
});

function createTestKernel(): Kernel {
  const db = openDatabase(":memory:");
  migrate(db, { directory: MIGRATIONS_DIRECTORY, clock: CLOCK });
  const kernel: Kernel = {
    db,
    clock: CLOCK,
    ids: createIdFactory(CLOCK),
    broker: createEventBroker(),
    logger: createLogger({ sink: () => undefined, clock: CLOCK }),
  };
  db.prepare(
    `INSERT INTO identity_threads (id, identity_id, kind, title, created_at, updated_at)
     VALUES (?, 'vesper', 'named', 'Nightly backup', ?, ?)`,
  ).run(THREAD, CREATED, CREATED);
  open = kernel;
  return kernel;
}

function insertJob(
  kernel: Kernel,
  status: string,
  { id = JOB, capability = "runtime.turn" }: { id?: string; capability?: string } = {},
): void {
  const payload =
    capability === "runtime.turn"
      ? {
          threadId: THREAD,
          identityId: "vesper",
          model: { providerId: "codex", model: "gpt-5", label: "Codex" },
          userMessageId: "0199a000-0000-7000-8000-0000000000f1",
          prompt: "my secret prompt text",
          primaryRootGrantId: "grant",
          objectiveActive: false,
        }
      : { grantId: "grant", relativePath: "notes.txt" };
  kernel.db
    .prepare(
      `INSERT INTO node_jobs (id, capability, status, idempotency_key, payload_version, payload_json,
                              created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(id, capability, status, `key-${id}`, JSON.stringify(payload), CREATED, CREATED);
}

function setStatus(kernel: Kernel, status: string, id = JOB): void {
  kernel.db.prepare("UPDATE node_jobs SET status = ? WHERE id = ?").run(status, id);
}

function jobEvent(kernel: Kernel, type: OrchestrationEvent["type"], id = JOB): void {
  proposeFor(
    { kernel },
    {
      id: kernel.ids.nextId(),
      sequence: 1,
      streamType: "node_job",
      streamId: id,
      type,
      actorType: "system",
      actorId: "core",
      payloadVersion: 1,
      correlationId: kernel.ids.nextId(),
      occurredAt: CLOCK.now().toString(),
      payload: {},
    },
  );
}

function briefs(kernel: Kernel) {
  return listSurfaceIntents(kernel.db, { presence: true }).filter(
    (intent) => intent.kind === "live_brief",
  );
}

function shown(kernel: Kernel) {
  return briefs(kernel).filter((intent) => intent.lifecycle !== "dismissed");
}

describe("live briefs", () => {
  it("is a core-only, bounded payload", () => {
    expect(PANEL_PROPOSABLE_KINDS.has("live_brief")).toBe(false);
    const valid = {
      title: "Vesper",
      runtime: "Codex",
      activity: "Nightly backup",
      status: "running",
      startedAt: CREATED,
    };
    expect(LiveBriefPayloadSchema.safeParse(valid).success).toBe(true);
    expect(LiveBriefPayloadSchema.safeParse({ ...valid, prompt: "x" }).success).toBe(false);
    expect(LiveBriefPayloadSchema.safeParse({ ...valid, activity: "x".repeat(201) }).success).toBe(
      false,
    );
    expect(LiveBriefPayloadSchema.safeParse({ ...valid, status: "succeeded" }).success).toBe(false);
  });

  it("a running agent turn becomes one Presence brief without its prompt", () => {
    const kernel = createTestKernel();
    insertJob(kernel, "running");
    jobEvent(kernel, "node.job_status_changed.v1");
    jobEvent(kernel, "node.job_status_changed.v1");

    const [brief, ...rest] = shown(kernel);
    expect(rest).toEqual([]);
    expect(brief).toMatchObject({
      presence: true,
      role: "supporting",
      minSize: "compact",
      preferredRegion: "bottom",
      sourceIds: [JOB],
      payload: {
        title: "Vesper",
        runtime: "Codex",
        activity: "Nightly backup",
        status: "running",
        startedAt: CREATED,
      },
    });
    expect(JSON.stringify(brief)).not.toContain("secret");
    expect(listSurfaceIntents(kernel.db, { threadId: THREAD })).toEqual([]);
  });

  it("a leased turn shows as starting, then running", () => {
    const kernel = createTestKernel();
    insertJob(kernel, "leased");
    jobEvent(kernel, "node.job_leased.v1");
    expect(shown(kernel)[0]?.payload).toMatchObject({ status: "starting" });
    setStatus(kernel, "running");
    jobEvent(kernel, "node.job_status_changed.v1");
    expect(shown(kernel)).toHaveLength(1);
    expect(shown(kernel)[0]?.payload).toMatchObject({ status: "running" });
  });

  it("ignores jobs that are not agent turns, and queued turns", () => {
    const kernel = createTestKernel();
    insertJob(kernel, "running", { capability: "file.read" });
    jobEvent(kernel, "node.job_status_changed.v1");
    insertJob(kernel, "queued", { id: "0199a000-0000-7000-8000-0000000000e2" });
    jobEvent(kernel, "node.job_queued.v1", "0199a000-0000-7000-8000-0000000000e2");
    jobEvent(kernel, "surface.intent_upserted.v1");
    expect(briefs(kernel)).toEqual([]);
  });

  it("a finished or requeued turn stops showing", () => {
    for (const end of ["succeeded", "failed", "cancelled", "queued"]) {
      const kernel = createTestKernel();
      insertJob(kernel, "running");
      jobEvent(kernel, "node.job_status_changed.v1");
      const [brief] = shown(kernel);
      for (const lifecycle of ["entering", "active"] as const) {
        changeSurfaceLifecycle(
          kernel,
          { correlationId: kernel.ids.nextId(), actorType: "user", actorId: "local" },
          { idempotencyKey: `show-${lifecycle}`, surfaceId: brief!.id, lifecycle },
        );
      }
      setStatus(kernel, end);
      jobEvent(kernel, end === "queued" ? "node.job_status_changed.v1" : "node.job_result.v1");
      expect(shown(kernel), end).toEqual([]);
      // The job record can rebuild a brief, so a finished one leaves no row behind.
      expect(briefs(kernel), end).toEqual([]);
      kernel.db.close();
      open = undefined;
    }
  });

  it("a brief the owner closed stays closed while the turn keeps running", () => {
    const kernel = createTestKernel();
    insertJob(kernel, "leased");
    jobEvent(kernel, "node.job_leased.v1");
    const [brief] = shown(kernel);
    changeSurfaceLifecycle(
      kernel,
      { correlationId: kernel.ids.nextId(), actorType: "user", actorId: "local" },
      { idempotencyKey: "close", surfaceId: brief!.id, lifecycle: "dismissed" },
    );
    setStatus(kernel, "running");
    jobEvent(kernel, "node.job_status_changed.v1");
    expect(shown(kernel)).toEqual([]);
    expect(briefs(kernel)).toHaveLength(1);
  });

  it("many finished turns leave Presence with no rows to read", () => {
    const kernel = createTestKernel();
    for (let index = 0; index < 5; index++) {
      const id = `0199a000-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`;
      insertJob(kernel, "running", { id });
      jobEvent(kernel, "node.job_status_changed.v1", id);
      setStatus(kernel, "succeeded", id);
      jobEvent(kernel, "node.job_result.v1", id);
    }
    expect(listSurfaceIntents(kernel.db, { presence: true })).toEqual([]);
  });

  it("a closed brief is cleared too once its turn ends", () => {
    const kernel = createTestKernel();
    insertJob(kernel, "running");
    jobEvent(kernel, "node.job_status_changed.v1");
    const [brief] = shown(kernel);
    changeSurfaceLifecycle(
      kernel,
      { correlationId: kernel.ids.nextId(), actorType: "user", actorId: "local" },
      { idempotencyKey: "close", surfaceId: brief!.id, lifecycle: "dismissed" },
    );
    setStatus(kernel, "succeeded");
    jobEvent(kernel, "node.job_result.v1");
    expect(briefs(kernel)).toEqual([]);
  });

  it("a brief whose job has gone is retired", () => {
    const kernel = createTestKernel();
    insertJob(kernel, "running");
    jobEvent(kernel, "node.job_status_changed.v1");
    kernel.db.prepare("DELETE FROM node_jobs WHERE id = ?").run(JOB);
    jobEvent(kernel, "node.job_result.v1");
    expect(briefs(kernel)).toEqual([]);
  });

  it("start-up rebuilds briefs for running turns and retires stale ones", () => {
    const kernel = createTestKernel();
    insertJob(kernel, "running");
    jobEvent(kernel, "node.job_status_changed.v1");
    setStatus(kernel, "succeeded");
    const other = "0199a000-0000-7000-8000-0000000000e3";
    insertJob(kernel, "running", { id: other });

    reconcileLiveBriefs({ kernel });
    reconcileLiveBriefs({ kernel });

    expect(shown(kernel).map((intent) => intent.sourceIds)).toEqual([[other]]);
  });
});
