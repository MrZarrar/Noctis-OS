import type {
  AttentionState,
  ChangeSurfaceLifecycleCommand,
  ComposeSurfacesCommand,
  CompositionPlan,
  ReleaseSurfaceOverrideCommand,
  SetSurfaceOverrideCommand,
  SurfaceIntent,
  SurfaceOverride,
  UpsertSurfaceIntentCommand,
} from "@noctis/contracts";
import {
  CompositionPlanSchema,
  SurfaceIntentSchema,
  SurfaceOverrideSchema,
} from "@noctis/contracts";
import type { DisplayFacts, Result } from "@noctis/domain";
import {
  compose,
  compositionSignature,
  conflict,
  ok,
  transitionSurfaceLifecycle,
} from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";

type IntentRow = {
  id: string;
  objective_id: string;
  kind: string;
  role: string;
  persistence: string;
  lifecycle: string;
  priority: number;
  min_size: string;
  preferred_region: string | null;
  source_ids_json: string;
  artifact_ids_json: string;
  payload_version: number;
  payload_json: string;
  requested_at: string;
};

type OverrideRow = {
  id: string;
  surface_id: string;
  client_id: string;
  display_fingerprint: string;
  region: string;
  size: string;
  created_at: string;
  released_at: string | null;
};

type SnapshotRow = {
  id: string;
  objective_id: string;
  layout_id: string;
  display_fingerprint: string;
  plan_json: string;
  reason_codes_json: string;
  generated_at: string;
};

const INTENT_COLUMNS = `id, objective_id, kind, role, persistence, lifecycle, priority, min_size,
                        preferred_region, source_ids_json, artifact_ids_json, payload_version,
                        payload_json, requested_at`;

const OVERRIDE_COLUMNS = `id, surface_id, client_id, display_fingerprint, region, size,
                          created_at, released_at`;

const SNAPSHOT_COLUMNS = `id, objective_id, layout_id, display_fingerprint, plan_json,
                          reason_codes_json, generated_at`;

/**
 * The stored form of "which Surface is this". Sorting is part of the identity,
 * not a formatting choice: two intents naming the same sources in a different
 * order are the same Surface, and the unique index in migration 0003 can only
 * see that if the column is canonical.
 */
function sourceIdentity(sourceIds: readonly string[]): string {
  return JSON.stringify([...sourceIds].sort());
}

function toIntent(row: IntentRow): SurfaceIntent {
  return SurfaceIntentSchema.parse({
    id: row.id,
    objectiveId: row.objective_id,
    kind: row.kind,
    role: row.role,
    persistence: row.persistence,
    lifecycle: row.lifecycle,
    priority: row.priority,
    minSize: row.min_size,
    ...(row.preferred_region === null ? {} : { preferredRegion: row.preferred_region }),
    sourceIds: JSON.parse(row.source_ids_json) as unknown,
    artifactIds: JSON.parse(row.artifact_ids_json) as unknown,
    payloadVersion: row.payload_version,
    payload: JSON.parse(row.payload_json) as unknown,
    requestedAt: row.requested_at,
  });
}

function toOverride(row: OverrideRow): SurfaceOverride {
  return SurfaceOverrideSchema.parse({
    id: row.id,
    surfaceId: row.surface_id,
    clientId: row.client_id,
    displayFingerprint: row.display_fingerprint,
    region: row.region,
    size: row.size,
    createdAt: row.created_at,
    ...(row.released_at === null ? {} : { releasedAt: row.released_at }),
  });
}

export function getSurfaceIntent(db: NoctisDatabase, id: string): SurfaceIntent | undefined {
  const row = db.prepare(`SELECT ${INTENT_COLUMNS} FROM surface_intents WHERE id = ?`).get(id) as
    IntentRow | undefined;

  return row === undefined ? undefined : toIntent(row);
}

export function listSurfaceIntents(db: NoctisDatabase, objectiveId: string): SurfaceIntent[] {
  const rows = db
    .prepare(`SELECT ${INTENT_COLUMNS} FROM surface_intents WHERE objective_id = ? ORDER BY id`)
    .all(objectiveId) as IntentRow[];

  return rows.map(toIntent);
}

/** Every override this client holds on this display, released ones included. */
export function listSurfaceOverrides(
  db: NoctisDatabase,
  objectiveId: string,
  clientId: string,
  displayFingerprint: string,
): SurfaceOverride[] {
  const rows = db
    .prepare(
      `SELECT o.id, o.surface_id, o.client_id, o.display_fingerprint, o.region, o.size,
              o.created_at, o.released_at
         FROM surface_overrides o
         JOIN surface_intents i ON i.id = o.surface_id
        WHERE i.objective_id = ? AND o.client_id = ? AND o.display_fingerprint = ?
        ORDER BY o.id`,
    )
    .all(objectiveId, clientId, displayFingerprint) as OverrideRow[];

  return rows.map(toOverride);
}

export interface CompositionSnapshot {
  id: string;
  plan: CompositionPlan;
}

export function getSnapshot(db: NoctisDatabase, id: string): CompositionSnapshot | undefined {
  const row = db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM composition_snapshots WHERE id = ?`)
    .get(id) as SnapshotRow | undefined;

  return row === undefined
    ? undefined
    : { id: row.id, plan: CompositionPlanSchema.parse(JSON.parse(row.plan_json)) };
}

export function getSnapshotForDisplay(
  db: NoctisDatabase,
  objectiveId: string,
  displayFingerprint: string,
): CompositionSnapshot | undefined {
  const row = db
    .prepare(
      `SELECT ${SNAPSHOT_COLUMNS} FROM composition_snapshots
        WHERE objective_id = ? AND display_fingerprint = ?`,
    )
    .get(objectiveId, displayFingerprint) as SnapshotRow | undefined;

  return row === undefined
    ? undefined
    : { id: row.id, plan: CompositionPlanSchema.parse(JSON.parse(row.plan_json)) };
}

function findByIdentity(
  db: NoctisDatabase,
  objectiveId: string,
  kind: string,
  identity: string,
): IntentRow | undefined {
  return db
    .prepare(
      `SELECT ${INTENT_COLUMNS} FROM surface_intents
        WHERE objective_id = ? AND kind = ? AND source_ids_json = ?`,
    )
    .get(objectiveId, kind, identity) as IntentRow | undefined;
}

/**
 * Upserts by Surface identity, so a Surface proposed twice is updated rather
 * than duplicated.
 *
 * The pre-read that resolves the row id runs immediately before `runCommand`,
 * in the same synchronous stretch: `runCommand` never awaits, and the core is
 * one process with a synchronous driver, so nothing can insert a rival row in
 * between. The unique index added by migration 0003 is the backstop if that
 * ever stops being true.
 */
export function upsertSurfaceIntent(
  kernel: Kernel,
  context: CommandContext,
  command: UpsertSurfaceIntentCommand,
): Result<SurfaceIntent> {
  const now = new Date(kernel.clock.now()).toISOString();
  const identity = sourceIdentity(command.sourceIds);
  const existing = findByIdentity(kernel.db, command.objectiveId, command.kind, identity);
  const id = existing?.id ?? kernel.ids.nextId();

  const record = SurfaceIntentSchema.parse({
    id,
    objectiveId: command.objectiveId,
    kind: command.kind,
    role: command.role,
    persistence: command.persistence,
    // A re-proposed Surface keeps the lifecycle it reached. Only
    // `surface.change_lifecycle` moves it, and only along the state machine.
    lifecycle: existing?.lifecycle ?? "proposed",
    priority: command.priority,
    minSize: command.minSize,
    ...(command.preferredRegion === undefined ? {} : { preferredRegion: command.preferredRegion }),
    sourceIds: JSON.parse(identity) as unknown,
    artifactIds: command.artifactIds,
    payloadVersion: command.payloadVersion,
    payload: command.payload ?? null,
    requestedAt: now,
  });

  return runCommand<SurfaceIntent>(
    kernel,
    { scope: "surface.upsert_intent", key: command.idempotencyKey, resultId: id },
    (tx) => {
      tx.prepare(
        `INSERT INTO surface_intents
           (id, objective_id, kind, role, persistence, lifecycle, priority, min_size,
            preferred_region, source_ids_json, artifact_ids_json, payload_version,
            payload_json, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           role = excluded.role,
           persistence = excluded.persistence,
           priority = excluded.priority,
           min_size = excluded.min_size,
           preferred_region = excluded.preferred_region,
           artifact_ids_json = excluded.artifact_ids_json,
           payload_version = excluded.payload_version,
           payload_json = excluded.payload_json,
           requested_at = excluded.requested_at`,
      ).run(
        record.id,
        record.objectiveId,
        record.kind,
        record.role,
        record.persistence,
        record.lifecycle,
        record.priority,
        record.minSize,
        record.preferredRegion ?? null,
        identity,
        JSON.stringify(record.artifactIds),
        record.payloadVersion,
        JSON.stringify(record.payload ?? null),
        record.requestedAt,
      );

      return ok({
        value: record,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "surface",
            streamId: record.id,
            type: "surface.intent_upserted.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              objectiveId: record.objectiveId,
              kind: record.kind,
              role: record.role,
              created: existing === undefined,
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

export function changeSurfaceLifecycle(
  kernel: Kernel,
  context: CommandContext,
  command: ChangeSurfaceLifecycleCommand,
): Result<SurfaceIntent> {
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<SurfaceIntent>(
    kernel,
    { scope: "surface.change_lifecycle", key: command.idempotencyKey, resultId: command.surfaceId },
    (tx) => {
      const current = getSurfaceIntent(tx, command.surfaceId);

      if (current === undefined) {
        return conflict({ kind: "not_found", entity: "surface_intent", id: command.surfaceId });
      }

      const transition = transitionSurfaceLifecycle(current.lifecycle, command.lifecycle);

      if (!transition.ok) {
        return conflict(transition.conflict);
      }

      tx.prepare(`UPDATE surface_intents SET lifecycle = ? WHERE id = ?`).run(
        command.lifecycle,
        command.surfaceId,
      );

      return ok({
        value: { ...current, lifecycle: command.lifecycle },
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "surface",
            streamId: command.surfaceId,
            type: "surface.lifecycle_changed.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              objectiveId: current.objectiveId,
              from: current.lifecycle,
              to: command.lifecycle,
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

function liveOverride(
  db: NoctisDatabase,
  command: { surfaceId: string; clientId: string; displayFingerprint: string },
): OverrideRow | undefined {
  return db
    .prepare(
      `SELECT ${OVERRIDE_COLUMNS} FROM surface_overrides
        WHERE surface_id = ? AND client_id = ? AND display_fingerprint = ?
          AND released_at IS NULL`,
    )
    .get(command.surfaceId, command.clientId, command.displayFingerprint) as
    OverrideRow | undefined;
}

export function getSurfaceOverride(db: NoctisDatabase, id: string): SurfaceOverride | undefined {
  const row = db
    .prepare(`SELECT ${OVERRIDE_COLUMNS} FROM surface_overrides WHERE id = ?`)
    .get(id) as OverrideRow | undefined;

  return row === undefined ? undefined : toOverride(row);
}

export function setSurfaceOverride(
  kernel: Kernel,
  context: CommandContext,
  command: SetSurfaceOverrideCommand,
): Result<SurfaceOverride> {
  const now = new Date(kernel.clock.now()).toISOString();
  const existing = liveOverride(kernel.db, command);
  const id = existing?.id ?? kernel.ids.nextId();

  return runCommand<SurfaceOverride>(
    kernel,
    { scope: "surface.set_override", key: command.idempotencyKey, resultId: id },
    (tx) => {
      const intent = getSurfaceIntent(tx, command.surfaceId);

      if (intent === undefined) {
        return conflict({ kind: "not_found", entity: "surface_intent", id: command.surfaceId });
      }

      tx.prepare(
        `INSERT INTO surface_overrides
           (id, surface_id, client_id, display_fingerprint, region, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           region = excluded.region,
           size = excluded.size,
           created_at = excluded.created_at`,
      ).run(
        id,
        command.surfaceId,
        command.clientId,
        command.displayFingerprint,
        command.region,
        command.size,
        now,
      );

      const record = SurfaceOverrideSchema.parse({
        id,
        surfaceId: command.surfaceId,
        clientId: command.clientId,
        displayFingerprint: command.displayFingerprint,
        region: command.region,
        size: command.size,
        createdAt: now,
      });

      return ok({
        value: record,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "surface",
            streamId: command.surfaceId,
            type: "surface.override_set.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              objectiveId: intent.objectiveId,
              displayFingerprint: command.displayFingerprint,
              region: command.region,
              size: command.size,
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

export function releaseSurfaceOverride(
  kernel: Kernel,
  context: CommandContext,
  command: ReleaseSurfaceOverrideCommand,
): Result<SurfaceOverride> {
  const now = new Date(kernel.clock.now()).toISOString();
  const existing = liveOverride(kernel.db, command);

  if (existing === undefined) {
    return conflict({ kind: "not_found", entity: "surface_override", id: command.surfaceId });
  }

  return runCommand<SurfaceOverride>(
    kernel,
    { scope: "surface.release_override", key: command.idempotencyKey, resultId: existing.id },
    (tx) => {
      tx.prepare(`UPDATE surface_overrides SET released_at = ? WHERE id = ?`).run(now, existing.id);

      return ok({
        value: toOverride({ ...existing, released_at: now }),
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "surface",
            streamId: command.surfaceId,
            type: "surface.override_released.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: { displayFingerprint: command.displayFingerprint },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

export interface Composition {
  plan: CompositionPlan;
  /** False when the recomputed plan is identical to the committed one. */
  changed: boolean;
}

/**
 * Composes without writing. The compositor is pure, so this reproduces exactly
 * what `composeSurfaces` would commit — which is what makes restore-after-restart
 * work without the client having to trust a stale snapshot.
 */
export function planFor(
  db: NoctisDatabase,
  request: {
    objectiveId: string;
    clientId: string;
    display: DisplayFacts;
    attentionState: AttentionState;
    focusedSurfaceId?: string;
    generatedAt: string;
  },
): CompositionPlan {
  return compose({
    objectiveId: request.objectiveId,
    intents: listSurfaceIntents(db, request.objectiveId),
    overrides: listSurfaceOverrides(
      db,
      request.objectiveId,
      request.clientId,
      request.display.fingerprint,
    ),
    display: request.display,
    attentionState: request.attentionState,
    ...(request.focusedSurfaceId === undefined
      ? {}
      : { focusedSurfaceId: request.focusedSurfaceId }),
    generatedAt: request.generatedAt,
  }).plan;
}

/**
 * Commits a composition.
 *
 * Section 5.4 step 10: the snapshot is persisted only after the transition
 * commits, and only when the plan actually changed — a resize that lands on the
 * same composition is not a new arrangement and does not deserve an event that
 * tells every other client something moved.
 */
export function composeSurfaces(
  kernel: Kernel,
  context: CommandContext,
  command: ComposeSurfacesCommand,
): Result<Composition> {
  const now = new Date(kernel.clock.now()).toISOString();
  const existing = getSnapshotForDisplay(
    kernel.db,
    command.objectiveId,
    command.display.fingerprint,
  );
  const id = existing?.id ?? kernel.ids.nextId();

  return runCommand<Composition>(
    kernel,
    { scope: "surface.compose", key: command.idempotencyKey, resultId: id },
    (tx) => {
      const plan = planFor(tx, {
        objectiveId: command.objectiveId,
        clientId: command.clientId,
        display: command.display,
        attentionState: command.attentionState,
        ...(command.focusedSurfaceId === undefined
          ? {}
          : { focusedSurfaceId: command.focusedSurfaceId }),
        generatedAt: now,
      });

      const changed =
        existing === undefined ||
        compositionSignature(existing.plan) !== compositionSignature(plan);

      if (!changed) {
        return ok({ value: { plan: existing.plan, changed }, events: [] });
      }

      tx.prepare(
        `INSERT INTO composition_snapshots
           (id, objective_id, layout_id, display_fingerprint, plan_json, reason_codes_json,
            generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           layout_id = excluded.layout_id,
           plan_json = excluded.plan_json,
           reason_codes_json = excluded.reason_codes_json,
           generated_at = excluded.generated_at`,
      ).run(
        id,
        plan.objectiveId,
        plan.layoutId,
        plan.displayFingerprint,
        JSON.stringify(plan),
        JSON.stringify(plan.reasonCodes),
        plan.generatedAt,
      );

      return ok({
        value: { plan, changed },
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "surface",
            streamId: command.objectiveId,
            type: "surface.composition_changed.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              layoutId: plan.layoutId,
              displayFingerprint: plan.displayFingerprint,
              reasonCodes: plan.reasonCodes,
              slotCount: plan.slots.length,
              overflowCount: plan.overflowSurfaceIds.length,
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

/** Replay body for a repeated `surface.compose`: the plan that call committed. */
export function replayComposition(db: NoctisDatabase, id: string): Composition | undefined {
  const snapshot = getSnapshot(db, id);

  return snapshot === undefined ? undefined : { plan: snapshot.plan, changed: false };
}
