import type {
  ObserveSourceCommand,
  RegisterSourceCommand,
  SourceObservation,
  SourceRecord,
  SourceState,
  SourceStatus,
} from "@noctis/contracts";
import { SourceObservationSchema, SourceRecordSchema, SourceStateSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";

/**
 * Source truth (Section 12.1).
 *
 * The one rule that shapes everything here: an adapter reports what it saw and
 * when, and nothing else. It does not say whether that is current, because
 * currency is a function of the source's declared policy and the clock, and an
 * adapter that could assert it could assert it wrongly — which is how a system
 * ends up showing a day-old price as verified.
 *
 * So `status` is computed on read, every time. The column exists for the audit
 * trail of what was known at observation time; `sourceState` never trusts it.
 */

type SourceRow = {
  id: string;
  source_type: string;
  external_id: string;
  freshness_seconds: number;
  unavailable_semantics: string;
  created_at: string;
  updated_at: string;
};

type ObservationRow = {
  id: string;
  source_id: string;
  status: string;
  payload_version: number;
  payload_json: string;
  observed_at: string;
  expires_at: string | null;
};

const SOURCE_COLUMNS = `id, source_type, external_id, freshness_seconds, unavailable_semantics,
                        created_at, updated_at`;

const OBSERVATION_COLUMNS = `id, source_id, status, payload_version, payload_json, observed_at,
                             expires_at`;

function toSource(row: SourceRow): SourceRecord {
  return SourceRecordSchema.parse({
    id: row.id,
    sourceType: row.source_type,
    externalId: row.external_id,
    freshnessSeconds: row.freshness_seconds,
    unavailableSemantics: row.unavailable_semantics,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toObservation(row: ObservationRow): SourceObservation {
  return SourceObservationSchema.parse({
    id: row.id,
    sourceId: row.source_id,
    status: row.status,
    payloadVersion: row.payload_version,
    payload: JSON.parse(row.payload_json) as unknown,
    observedAt: row.observed_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  });
}

export function getSource(db: NoctisDatabase, id: string): SourceRecord | undefined {
  const row = db.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE id = ?`).get(id) as
    SourceRow | undefined;

  return row === undefined ? undefined : toSource(row);
}

export function listSources(db: NoctisDatabase, limit: number): SourceRecord[] {
  const rows = db
    .prepare(`SELECT ${SOURCE_COLUMNS} FROM sources ORDER BY source_type, external_id LIMIT ?`)
    .all(limit) as SourceRow[];

  return rows.map(toSource);
}

/**
 * The two most recent observations, newest first. Two rather than one because
 * Section 12.1 asks the UI to distinguish remembered from current, and that
 * needs both halves.
 */
function recentObservations(db: NoctisDatabase, sourceId: string): SourceObservation[] {
  const rows = db
    .prepare(
      `SELECT ${OBSERVATION_COLUMNS} FROM source_observations
        WHERE source_id = ? ORDER BY observed_at DESC, id DESC LIMIT 2`,
    )
    .all(sourceId) as ObservationRow[];

  return rows.map(toObservation);
}

/**
 * Normalizes one source against the clock.
 *
 * The four words are decided here and nowhere else:
 *
 * - `unknown` — nobody has looked, or the last look failed and the source says
 *   an unreachable answer is not an answer;
 * - `unavailable` — the last look failed and the last known value may stand;
 * - `stale` — the observation is older than the source's freshness policy;
 * - `current` — it is not.
 *
 * `unknown` and `unavailable` are never substituted for one another, which is
 * why `unavailableSemantics` is a source property rather than a caller's guess.
 */
export function sourceState(db: NoctisDatabase, source: SourceRecord, now: number): SourceState {
  const [observed, remembered] = recentObservations(db, source.id);

  if (observed === undefined) {
    return SourceStateSchema.parse({ source, status: "unknown", conflicted: false });
  }

  const ageSeconds = Math.max(0, (now - Date.parse(observed.observedAt)) / 1000);

  const status: SourceStatus =
    observed.status === "unavailable"
      ? source.unavailableSemantics === "last_known"
        ? "unavailable"
        : "unknown"
      : ageSeconds > source.freshnessSeconds
        ? "stale"
        : "current";

  // Compared as canonical JSON rather than by reference: two observations of
  // the same live state must not read as a conflict just because they are two
  // rows. Key order comes from the same serializer both times.
  const conflicted =
    remembered !== undefined &&
    observed.status !== "unavailable" &&
    remembered.status !== "unavailable" &&
    JSON.stringify(observed.payload) !== JSON.stringify(remembered.payload);

  return SourceStateSchema.parse({
    source,
    status,
    observed,
    ...(remembered === undefined ? {} : { remembered }),
    conflicted,
    ageSeconds,
  });
}

export function registerSource(
  kernel: Kernel,
  context: CommandContext,
  command: RegisterSourceCommand,
): Result<SourceRecord> {
  const id = kernel.ids.nextId();
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<SourceRecord>(
    kernel,
    { scope: "source.register", key: command.idempotencyKey, resultId: id },
    (tx) => {
      const existing = tx
        .prepare(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE source_type = ? AND external_id = ?`)
        .get(command.sourceType, command.externalId) as SourceRow | undefined;

      if (existing !== undefined) {
        // Registering the same source twice is how an adapter starts up, not an
        // error. The row it already has is returned unchanged — re-registering
        // is deliberately not a way to edit a freshness policy.
        return ok({ value: toSource(existing), events: [] });
      }

      tx.prepare(
        `INSERT INTO sources
           (id, source_type, external_id, freshness_seconds, unavailable_semantics,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        command.sourceType,
        command.externalId,
        command.freshnessSeconds,
        command.unavailableSemantics,
        now,
        now,
      );

      const source = getSource(tx, id);

      if (source === undefined) {
        throw new Error(`Source ${id} vanished mid-transaction`);
      }

      return ok({
        value: source,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "source",
            streamId: id,
            type: "source.registered.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              sourceId: id,
              sourceType: command.sourceType,
              freshnessSeconds: command.freshnessSeconds,
              unavailableSemantics: command.unavailableSemantics,
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

export function observeSource(
  kernel: Kernel,
  context: CommandContext,
  command: ObserveSourceCommand,
): Result<SourceState> {
  const id = kernel.ids.nextId();
  const now = kernel.clock.now();
  const nowIso = new Date(now).toISOString();

  return runCommand<SourceState>(
    kernel,
    { scope: "source.observe", key: command.idempotencyKey, resultId: id },
    (tx) => {
      const source = getSource(tx, command.sourceId);

      if (source === undefined) {
        return conflict({ kind: "not_found", entity: "source", id: command.sourceId });
      }

      // What the row records is what the adapter could establish: it either
      // reached the source or it did not. Everything else is computed on read.
      const recorded = command.reachable ? "current" : "unavailable";
      const expiresAt = new Date(now + source.freshnessSeconds * 1000).toISOString();

      tx.prepare(
        `INSERT INTO source_observations
           (id, source_id, status, payload_version, payload_json, observed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        command.sourceId,
        recorded,
        command.payloadVersion,
        JSON.stringify(command.payload ?? null),
        nowIso,
        expiresAt,
      );

      tx.prepare("UPDATE sources SET updated_at = ? WHERE id = ?").run(nowIso, command.sourceId);

      const state = sourceState(tx, source, now);

      return ok({
        value: state,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "source",
            streamId: command.sourceId,
            type: "source.observed.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              sourceId: command.sourceId,
              observationId: id,
              reachable: command.reachable,
              status: state.status,
              conflicted: state.conflicted,
              // Never the payload. A source payload may carry anything the
              // adapter read, and Section 9.2 keeps sensitive source payloads
              // out of the log.
            },
            correlationId: context.correlationId,
            occurredAt: nowIso,
          },
        ],
      });
    },
  );
}

export function getSourceState(
  db: NoctisDatabase,
  id: string,
  now: number,
): SourceState | undefined {
  const source = getSource(db, id);

  return source === undefined ? undefined : sourceState(db, source, now);
}
