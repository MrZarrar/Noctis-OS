import type { LiveBriefPayload, SurfaceIntent, SurfaceLifecycle } from "@noctis/contracts";
import { LiveBriefPayloadSchema, RuntimeTurnPayloadSchema } from "@noctis/contracts";

import { getThread } from "../conversation/threads.js";
import { ok } from "@noctis/domain";

import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import { getJob } from "../nodes/jobs.js";
import {
  changeSurfaceLifecycle,
  listSurfaceIntents,
  upsertSurfaceIntent,
} from "./surface-intents.js";

/**
 * Presence's side panels for agents at work: one brief per runtime turn while a
 * node holds it. Made from the job record by rule, never by a model, so it keeps
 * working with no model usage left. Other capabilities are the owner browsing
 * files, not an agent doing something, and would only make Presence flicker.
 *
 * ponytail: runtime turns only. Scheduled task runs join once they have a store.
 */

const SHOWN: Partial<Record<string, LiveBriefPayload["status"]>> = {
  leased: "starting",
  running: "running",
};

export interface LiveBriefDeps {
  kernel: Kernel;
}

function context(kernel: Kernel): CommandContext {
  return { correlationId: kernel.ids.nextId(), actorType: "system", actorId: "core" };
}

function briefsFor(kernel: Kernel, jobId?: string): SurfaceIntent[] {
  return listSurfaceIntents(kernel.db, { presence: true }).filter(
    (intent) =>
      intent.kind === "live_brief" && (jobId === undefined || intent.sourceIds[0] === jobId),
  );
}

// The lifecycle machine has no direct path from a shown panel to dismissed.
const RETIRE_PATH: Record<SurfaceLifecycle, SurfaceLifecycle[]> = {
  proposed: ["dismissed"],
  entering: ["dismissed"],
  active: ["exiting", "dismissed"],
  background: ["exiting", "dismissed"],
  exiting: ["dismissed"],
  dismissed: [],
};

function retire(kernel: Kernel, brief: SurfaceIntent): void {
  for (const lifecycle of RETIRE_PATH[brief.lifecycle]) {
    const changed = changeSurfaceLifecycle(kernel, context(kernel), {
      idempotencyKey: `brief-end:${brief.id}:${lifecycle}`,
      surfaceId: brief.id,
      lifecycle,
    });
    if (!changed.ok && changed.conflict.kind !== "idempotent_replay") {
      kernel.logger.log("warn", "live brief not retired", { reason: changed.conflict.kind });
      return;
    }
  }
  // The dismissal is what tells open pages. After it the row is dead weight: the
  // job can rebuild a brief, and Presence reads every row it owns on each refresh.
  runCommand<undefined>(
    kernel,
    { scope: "surface.purge_brief", key: `brief-purge:${brief.id}`, resultId: brief.id },
    (tx) => {
      tx.prepare(`DELETE FROM surface_intents WHERE id = ? AND lifecycle = 'dismissed'`).run(
        brief.id,
      );
      return ok({ value: undefined, events: [] });
    },
  );
}

/** Brings the brief for one job in line with what the job record says now. */
export function placeLiveBrief(deps: LiveBriefDeps, jobId: string): void {
  const { kernel } = deps;
  const record = getJob(kernel.db, jobId);
  if (record !== undefined && record.job.capability !== "runtime.turn") return;

  const status = record === undefined ? undefined : SHOWN[record.job.status];
  if (record === undefined || status === undefined) {
    for (const brief of briefsFor(kernel, jobId)) retire(kernel, brief);
    return;
  }

  const turn = RuntimeTurnPayloadSchema.safeParse(record.job.payload);
  if (!turn.success) return;
  const { identityId, model, threadId } = turn.data;
  const thread = getThread(kernel.db, threadId);
  const payload = LiveBriefPayloadSchema.parse({
    title: identityId.charAt(0).toUpperCase() + identityId.slice(1),
    runtime: model.label ?? model.model,
    activity:
      thread?.title?.trim().slice(0, 200) ||
      (thread?.parentThreadId === undefined ? "A conversation" : "A delegated task"),
    status,
    // When the owner asked, so elapsed time does not restart as the job changes hands.
    startedAt: record.job.createdAt,
  });

  const upserted = upsertSurfaceIntent(kernel, context(kernel), {
    idempotencyKey: `brief:${jobId}:${status}`,
    presence: true,
    kind: "live_brief",
    role: "supporting",
    persistence: "ephemeral",
    priority: 50,
    minSize: "compact",
    // A phone has no side column, and a supporting panel with nowhere to go
    // lands in overflow. The bottom strip exists at every width.
    // ponytail: a second brief at once still overflows on a phone.
    preferredRegion: "bottom",
    sourceIds: [jobId],
    artifactIds: [],
    payloadVersion: 1,
    payload,
  });
  if (!upserted.ok && upserted.conflict.kind !== "idempotent_replay") {
    kernel.logger.log("warn", "live brief not placed", { reason: upserted.conflict.kind });
  }
}

/** Catches up on events the core missed while it was down. */
export function reconcileLiveBriefs(deps: LiveBriefDeps): void {
  const running = deps.kernel.db
    .prepare(
      `SELECT id FROM node_jobs
        WHERE capability = 'runtime.turn' AND status IN ('leased', 'running') ORDER BY id`,
    )
    .all() as Array<{ id: string }>;
  const ids = new Set(running.map((row) => row.id));
  const stale = briefsFor(deps.kernel)
    .map((brief) => brief.sourceIds[0])
    .filter((jobId): jobId is string => jobId !== undefined && !ids.has(jobId));
  for (const jobId of [...stale, ...ids]) {
    // One unreadable job should not leave every other brief out of date.
    try {
      placeLiveBrief(deps, jobId);
    } catch (error) {
      deps.kernel.logger.log("warn", "live brief not reconciled", {
        jobId,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}
