import { createIdFactory } from "@noctis/domain";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import { createLogger } from "../logging.js";
import { completeJob, getJob, leaseJob, startJob } from "../nodes/jobs.js";
import { createLightsGateway } from "./gateway.js";

const NODE = "0199a000-0000-7000-8000-0000000000e1";
const owner = {
  correlationId: "0199a000-0000-7000-8000-0000000000c1",
  actorType: "user" as const,
  actorId: "local",
};
const nodeContext = {
  correlationId: "0199a000-0000-7000-8000-0000000000c2",
  actorType: "node" as const,
  actorId: NODE,
};
const LAMP_ON = {
  lights: [{ name: "Lamp", kind: "tapo", online: true, on: true, brightness: 60 }],
  scenes: ["cinema"],
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

function harness() {
  const clock = { now: () => Date.parse("2026-11-13T12:00:00.000Z") };
  const db = openDatabase(":memory:");
  migrate(db, { directory: "apps/core/migrations", clock });
  const kernel = {
    db,
    clock,
    ids: createIdFactory(clock),
    broker: createEventBroker(),
    logger: createLogger({ sink: () => undefined }),
  };
  const at = new Date(clock.now()).toISOString();
  db.prepare(
    "INSERT INTO nodes (id,host_id,status,fingerprint,agent_version,created_at,updated_at) VALUES (?,?,'online','fp','test',?,?)",
  ).run(NODE, "home", at, at);
  let online = true;
  const lights = createLightsGateway({
    kernel,
    dispatcher: { isConnected: () => online, pass: () => undefined },
  });
  cleanups.push(() => {
    lights.close();
    db.close();
  });
  const queued = (capability: string) =>
    db
      .prepare("SELECT id, payload_json FROM node_jobs WHERE capability = ? ORDER BY created_at")
      .all(capability) as { id: string; payload_json: string }[];
  // The node's side: lease, start, answer. Called once the job is queued.
  const answer = async (
    capability: string,
    outcome: "succeeded" | "failed",
    evidence: unknown = {},
  ) => {
    await Promise.resolve();
    const job = queued(capability).at(-1)!;
    expect(leaseJob(kernel, nodeContext, { jobId: job.id, nodeId: NODE, attempts: 0 }).ok).toBe(
      true,
    );
    expect(startJob(kernel, nodeContext, { jobId: job.id, nodeId: NODE }).ok).toBe(true);
    completeJob(kernel, nodeContext, {
      jobId: job.id,
      nodeId: NODE,
      outcome,
      evidence,
      ...(outcome === "failed" ? { failureReason: "no lights.json on this PC" } : {}),
    });
    return job;
  };
  return { db, lights, queued, answer, setOnline: (v: boolean) => (online = v) };
}

describe("lights gateway", () => {
  it("says lights are not set up until a PC is allowed", async () => {
    const h = harness();
    expect(await h.lights.status(owner)).toEqual({
      granted: false,
      nodeId: null,
      nodeOnline: false,
    });
  });

  it("asks the allowed PC for the lights and returns its answer", async () => {
    const h = harness();
    expect(h.lights.allow(owner, { idempotencyKey: "a", nodeId: NODE }).ok).toBe(true);
    const status = h.lights.status(owner);
    await h.answer("lights.state", "succeeded", LAMP_ON);
    expect(await status).toEqual({
      granted: true,
      nodeId: NODE,
      nodeOnline: true,
      lights: LAMP_ON,
    });
  });

  it("lets the owner switch a light without asking each time", async () => {
    const h = harness();
    h.lights.allow(owner, { idempotencyKey: "a", nodeId: NODE });
    const set = h.lights.set(owner, { idempotencyKey: "s", scene: "cinema" });
    const job = await h.answer("lights.set", "succeeded", LAMP_ON);
    expect(await set).toEqual(LAMP_ON);
    expect(JSON.parse(job.payload_json)).toEqual({ scene: "cinema" });
  });

  it("reports an offline PC and a refusal without hanging", async () => {
    const h = harness();
    h.lights.allow(owner, { idempotencyKey: "a", nodeId: NODE });
    h.setOnline(false);
    expect(await h.lights.status(owner)).toMatchObject({ granted: true, nodeOnline: false });
    await expect(
      h.lights.set(owner, { idempotencyKey: "s", changes: [{ light: "Lamp", on: false }] }),
    ).rejects.toThrow(/offline/);
    h.setOnline(true);
    const status = h.lights.status(owner);
    await h.answer("lights.state", "failed");
    expect(await status).toMatchObject({ nodeOnline: true, error: "no lights.json on this PC" });
  });

  it("stops every lights job once disallowed", async () => {
    const h = harness();
    h.lights.allow(owner, { idempotencyKey: "a", nodeId: NODE });
    expect(h.lights.disallow(owner, { idempotencyKey: "d", nodeId: NODE }).ok).toBe(true);
    expect((await h.lights.status(owner)).granted).toBe(false);
    await expect(h.lights.set(owner, { idempotencyKey: "s", scene: "cinema" })).rejects.toThrow(
      /not set up/,
    );
    expect(getJob(h.db, "x")).toBeUndefined();
  });
});
