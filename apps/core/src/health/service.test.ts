import { grantCapability } from "../nodes/registry.js";
import { revokeStandingPermission } from "../authority/service.js";
import { healthReportFixture, HealthStatusSchema } from "@noctis/contracts";
import { createIdFactory } from "@noctis/domain";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import { createLogger } from "../logging.js";
import { completeJob, getJob, startJob, leaseJob } from "../nodes/jobs.js";
import { createHealthService } from "./service.js";

const NODE = "0199a000-0000-7000-8000-0000000000e1";
const owner = {
  correlationId: "0199a000-0000-7000-8000-0000000000c1",
  actorType: "user" as const,
  actorId: "local",
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

function harness(start = "2026-10-18T19:00:00.000Z") {
  let now = Date.parse(start);
  const logged: string[] = [];
  const clock = { now: () => now };
  const db = openDatabase(":memory:");
  migrate(db, { directory: "apps/core/migrations", clock });
  const kernel = {
    db,
    clock,
    ids: createIdFactory(clock),
    broker: createEventBroker(),
    logger: createLogger({ sink: (line) => logged.push(line) }),
  };
  const at = new Date(now).toISOString();
  db.prepare(
    "INSERT INTO nodes (id,host_id,status,fingerprint,agent_version,created_at,updated_at) VALUES (?,?,'online','fp','test',?,?)",
  ).run(NODE, "home", at, at);
  const sent: { title: string; body: string }[] = [];
  let online = true;
  let weeklyAt = "20:00";
  const health = createHealthService({
    kernel,
    dispatcher: { isConnected: () => online, pass: () => undefined, sendGrants: () => true },
    notifier: {
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
    weeklyAt: () => weeklyAt,
    timeZone: "Europe/London",
  });
  cleanups.push(() => {
    health.close();
    db.close();
  });
  const allowed = health.allow(owner, {
    idempotencyKey: "allow",
    nodeId: NODE,
    repo: "C:\\glycolens",
  });
  expect(allowed.ok).toBe(true);
  return {
    logged,
    health,
    db,
    kernel,
    sent,
    advance: (ms: number) => {
      now += ms;
    },
    setOnline: (value: boolean) => {
      online = value;
    },
    setWeekly: (value: string) => {
      weeklyAt = value;
    },
    jobs: (capability: string) =>
      db
        .prepare("SELECT id, status FROM node_jobs WHERE capability = ? ORDER BY created_at")
        .all(capability) as { id: string; status: string }[],
    finish: (jobId: string, outcome: "succeeded" | "failed", evidence?: unknown) => {
      if (getJob(db, jobId)?.job.status === "queued") startJobFor({ kernel }, jobId);
      completeJob(
        kernel,
        { correlationId: "0199a000-0000-7000-8000-0000000000c2", actorType: "node", actorId: NODE },
        {
          jobId,
          nodeId: NODE,
          outcome,
          evidence: evidence ?? {},
          ...(outcome === "failed" ? { failureReason: "boom" } : {}),
        },
      );
    },
  };
}

describe("weekly run", () => {
  it("queues nothing before Sunday 20:00 and one job after it", () => {
    const h = harness("2026-10-18T18:59:00.000Z"); // 19:59 BST
    const previous = h.health.runNow(owner, { idempotencyKey: "previous" });
    if (!previous.ok) throw new Error("run refused");
    h.finish(previous.value.job.id, "succeeded", { outcome: "no_login", report: "missing" });
    h.db
      .prepare("INSERT INTO health_runs (occurrence, job_id, created_at) VALUES (?, ?, ?)")
      .run("2026-10-11T19:00:00.000Z", previous.value.job.id, "2026-10-11T19:00:00.000Z");
    h.health.pass();
    expect(h.jobs("health.run")).toHaveLength(1);
    h.advance(120_000);
    h.health.pass();
    h.health.pass();
    expect(h.jobs("health.run")).toHaveLength(2);
  });

  it("catches up once after three missed Sundays, and not again once it finished", () => {
    const h = harness("2026-11-04T09:00:00.000Z"); // Wednesday, three Sundays later
    h.health.pass();
    const [job] = h.jobs("health.run");
    expect(job).toBeDefined();
    h.finish(job!.id, "succeeded", { outcome: "no_login", report: "missing" });
    h.advance(60_000);
    h.health.pass();
    expect(h.jobs("health.run")).toHaveLength(1);
  });

  it("waits while the PC is off and retries a job that expired", () => {
    const h = harness();
    h.setOnline(false);
    h.advance(3_600_000);
    h.health.pass();
    expect(h.jobs("health.run")).toEqual([]);
    h.setOnline(true);
    h.health.pass();
    const [job] = h.jobs("health.run");
    h.db.prepare("UPDATE node_jobs SET status = 'expired' WHERE id = ?").run(job!.id);
    h.health.pass();
    expect(h.jobs("health.run")).toHaveLength(2);
  });

  it("does nothing when the setting is empty", () => {
    const h = harness();
    h.setWeekly("");
    h.advance(3_600_000);
    h.health.pass();
    expect(h.jobs("health.run")).toEqual([]);
  });
});

describe("owner commands", () => {
  it("refuses a decision while a run is queued, and lets one through after", () => {
    const h = harness("2026-10-16T12:00:00.000Z");
    const run = h.health.runNow(owner, { idempotencyKey: "r" });
    expect(run.ok).toBe(true);
    const early = h.health.decide(owner, {
      idempotencyKey: "d1",
      id: "2026-W41-breakfast-carb_ratio",
      action: "mark-applied",
    });
    expect(early.ok ? "ok" : early.conflict).toMatchObject({
      kind: "unavailable",
      reason: "run_in_progress",
    });
    if (run.ok) h.finish(run.value.job.id, "succeeded", { outcome: "written", report: "sent" });
    expect(
      h.health.decide(owner, {
        idempotencyKey: "d2",
        id: "2026-W41-breakfast-carb_ratio",
        action: "mark-applied",
      }).ok,
    ).toBe(true);
  });

  it("refuses everything once disallowed", () => {
    const h = harness("2026-10-16T12:00:00.000Z");
    expect(h.health.disallow(owner, { idempotencyKey: "x", nodeId: NODE }).ok).toBe(true);
    expect(h.health.runNow(owner, { idempotencyKey: "r" }).ok).toBe(false);
    expect(h.health.status().granted).toBe(false);
  });
});

describe("stream and status", () => {
  it("stores a streamed report, counts proposals and pushes only new ones after a run", async () => {
    const h = harness("2026-10-16T12:00:00.000Z");
    const run = h.health.runNow(owner, { idempotencyKey: "r" });
    if (!run.ok) throw new Error("run refused");
    startJobFor(h, run.value.job.id);
    const body = Buffer.from(
      JSON.stringify({ ...healthReportFixture(), padding: "x".repeat(1024 * 1024) }),
    );
    expect(await h.health.accept(NODE, run.value.job.id, stream(body))).toBe(true);
    expect(h.sent).toEqual([
      { title: "Health", body: "1 new health suggestion", url: "/", tag: "health" },
    ]);
    const status = HealthStatusSchema.parse(h.health.status());
    expect(status).toMatchObject({
      granted: true,
      nodeOnline: true,
      proposed: 1,
      report: { state: "ok" },
    });

    h.finish(run.value.job.id, "succeeded", { outcome: "written", report: "sent" });
    const again = h.health.runNow(owner, { idempotencyKey: "r2" });
    if (!again.ok) throw new Error("second run refused");
    startJobFor(h, again.value.job.id);
    await h.health.accept(NODE, again.value.job.id, stream(body));
    expect(h.sent).toHaveLength(1);
  });

  it("refuses a stream from another node or for a non-health job, and over 4 MB", async () => {
    const h = harness("2026-10-16T12:00:00.000Z");
    const run = h.health.runNow(owner, { idempotencyKey: "r" });
    if (!run.ok) throw new Error("run refused");
    startJobFor(h, run.value.job.id);
    expect(
      await h.health.accept(
        "0199a000-0000-7000-8000-0000000000ff",
        run.value.job.id,
        stream(Buffer.from("{}")),
      ),
    ).toBe(false);
    expect(
      await h.health.accept(NODE, run.value.job.id, stream(Buffer.alloc(4 * 1024 * 1024 + 1))),
    ).toBe(false);
  });

  it("marks a report unreadable or missing, never throwing", async () => {
    const h = harness("2026-10-16T12:00:00.000Z");
    const run = h.health.refresh(owner, { idempotencyKey: "f" });
    if (!run.ok) throw new Error("refresh refused");
    startJobFor(h, run.value.job.id);
    await h.health.accept(NODE, run.value.job.id, stream(Buffer.from("{nope")));
    expect(h.health.status().report).toMatchObject({
      state: "unreadable",
      reason: "report.json is not JSON",
    });
    h.finish(run.value.job.id, "succeeded", { report: "sent" });
    const second = h.health.refresh(owner, { idempotencyKey: "f2" });
    if (second.ok) h.finish(second.value.job.id, "succeeded", { report: "missing" });
    expect(h.health.status().report).toMatchObject({ state: "missing" });
  });
});

async function* stream(body: Buffer) {
  yield await Promise.resolve(body);
}
function startJobFor(h: { kernel: ReturnType<typeof harness>["kernel"] }, jobId: string) {
  const context = {
    correlationId: "0199a000-0000-7000-8000-0000000000c2",
    actorType: "node" as const,
    actorId: NODE,
  };
  expect(leaseJob(h.kernel, context, { jobId, nodeId: NODE, attempts: 0 }).ok).toBe(true);
  expect(startJob(h.kernel, context, { jobId, nodeId: NODE }).ok).toBe(true);
}

it("replays completed allow and stop without changing newer permission state", () => {
  const h = harness();
  expect(
    h.health.allow(owner, { idempotencyKey: "allow", nodeId: NODE, repo: "C:\\glycolens" }).ok,
  ).toBe(true);
  expect(h.health.disallow(owner, { idempotencyKey: "stop", nodeId: NODE }).ok).toBe(true);
  h.health.allow(owner, { idempotencyKey: "allow", nodeId: NODE, repo: "C:\\glycolens" });
  expect(
    h.db.prepare("SELECT count(*) n FROM standing_permissions WHERE revoked_at IS NULL").get(),
  ).toEqual({ n: 0 });
  expect(
    h.health.allow(owner, { idempotencyKey: "new", nodeId: NODE, repo: "C:\\glycolens" }).ok,
  ).toBe(true);
  h.health.disallow(owner, { idempotencyKey: "stop", nodeId: NODE });
  expect(
    h.db.prepare("SELECT count(*) n FROM standing_permissions WHERE revoked_at IS NULL").get(),
  ).toEqual({ n: 3 });
  expect(h.health.runNow(owner, { idempotencyKey: "now" }).ok).toBe(true);
});

it.each(["expired", "cancelled", "lost"])("retries a weekly job that was %s", (state) => {
  const h = harness();
  h.health.pass();
  const first = h.jobs("health.run")[0]!;
  if (state === "lost") h.db.prepare("UPDATE health_runs SET job_id = 'missing'").run();
  else h.db.prepare("UPDATE node_jobs SET status = ? WHERE id = ?").run(state, first.id);
  if (state === "lost")
    h.db.prepare("UPDATE node_jobs SET status = 'cancelled' WHERE id = ?").run(first.id);
  h.health.pass();
  expect(h.jobs("health.run")).toHaveLength(2);
});
it("closes the week after a failed run", () => {
  const h = harness();
  h.health.pass();
  h.finish(h.jobs("health.run")[0]!.id, "failed", {});
  h.health.pass();
  expect(h.jobs("health.run")).toHaveLength(1);
});
it.each(["expiry", "complete", "revoke", "re-lease"])(
  "rejects an upload after mid-stream %s",
  async (change) => {
    const h = harness();
    const run = h.health.runNow(owner, { idempotencyKey: "r" });
    if (!run.ok) throw new Error("refused");
    const id = run.value.job.id;
    startJobFor(h, id);
    async function* changing() {
      await Promise.resolve();
      yield Buffer.from(JSON.stringify(healthReportFixture()));
      if (change === "expiry") h.advance(31_000);
      if (change === "complete") h.finish(id, "succeeded", { outcome: "written", report: "sent" });
      if (change === "revoke") h.health.disallow(owner, { idempotencyKey: "stop", nodeId: NODE });
      if (change === "re-lease")
        h.db.prepare("UPDATE node_jobs SET attempts = attempts + 1 WHERE id = ?").run(id);
    }
    expect(await h.health.accept(NODE, id, changing())).toBe(false);
    expect(h.health.status().report).toEqual({ state: "none" });
    expect(h.sent).toEqual([]);
  },
);
it("rejects uploads for another capability", async () => {
  const h = harness();
  const r = h.health.runNow(owner, { idempotencyKey: "r" });
  if (!r.ok) throw new Error("refused");
  startJobFor(h, r.value.job.id);
  h.db.prepare("UPDATE node_jobs SET capability = 'file.read' WHERE id = ?").run(r.value.job.id);
  expect(await h.health.accept(NODE, r.value.job.id, stream(Buffer.from("{}")))).toBe(false);
});

it("tells the owner why a run went wrong, and never logs it", () => {
  const h = harness();
  const r = h.health.runNow(owner, { idempotencyKey: "privacy" });
  if (!r.ok) throw new Error("refused");
  h.finish(r.value.job.id, "succeeded", {
    outcome: "stale",
    report: "missing",
    reason: "PRIVATE_HEALTH_SENTINEL 7.2 mmol",
  });
  expect(h.health.status().lastRun).toMatchObject({
    outcome: "stale",
    reason: "PRIVATE_HEALTH_SENTINEL 7.2 mmol",
  });
  h.health.pass();
  expect(h.logged.join(" ")).not.toContain("PRIVATE_HEALTH_SENTINEL");
});

it("finishes partially completed allow and disallow component commands", () => {
  const h = harness();
  h.health.disallow(owner, { idempotencyKey: "stop", nodeId: NODE });
  expect(
    grantCapability(h.kernel, owner, {
      idempotencyKey: "partial:health.report",
      nodeId: NODE,
      capability: "health.report",
      constraints: { repo: "C:\\glycolens" },
    }).ok,
  ).toBe(true);
  expect(
    h.health.allow(owner, { idempotencyKey: "partial", nodeId: NODE, repo: "C:\\glycolens" }).ok,
  ).toBe(true);
  expect(
    h.db.prepare("SELECT count(*) n FROM node_capabilities WHERE revoked_at IS NULL").get(),
  ).toEqual({ n: 3 });
  const permission = h.db
    .prepare("SELECT id FROM standing_permissions WHERE revoked_at IS NULL LIMIT 1")
    .get() as { id: string };
  expect(
    revokeStandingPermission(h.kernel, owner, {
      idempotencyKey: `partial-stop:${permission.id}`,
      permissionId: permission.id,
      reason: "health disallowed",
    }).ok,
  ).toBe(true);
  expect(h.health.disallow(owner, { idempotencyKey: "partial-stop", nodeId: NODE }).ok).toBe(true);
  expect(
    h.db.prepare("SELECT count(*) n FROM standing_permissions WHERE revoked_at IS NULL").get(),
  ).toEqual({ n: 0 });
  expect(h.health.status().granted).toBe(false);
});
