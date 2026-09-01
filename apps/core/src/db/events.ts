import type { OrchestrationEvent } from "@noctis/contracts";
import { OrchestrationEventSchema } from "@noctis/contracts";

import { inTransaction, type NoctisDatabase } from "./connection.js";

/** An event before the core assigns its global sequence. */
export type EventDraft = Omit<OrchestrationEvent, "sequence">;

/**
 * Appends one event and returns the sequence SQLite assigned. Must be called
 * inside an open transaction so the event and its state change commit together.
 */
export function appendEvent(db: NoctisDatabase, draft: EventDraft): OrchestrationEvent {
  if (!inTransaction(db)) {
    throw new Error("appendEvent must run inside an open transaction");
  }

  const payloadJson = JSON.stringify(draft.payload ?? null);

  const inserted = db
    .prepare(
      `INSERT INTO orchestration_events
         (id, stream_type, stream_id, type, actor_type, actor_id,
          payload_version, payload_json, correlation_id, causation_id, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING sequence`,
    )
    .get(
      draft.id,
      draft.streamType,
      draft.streamId,
      draft.type,
      draft.actorType,
      draft.actorId,
      draft.payloadVersion,
      payloadJson,
      draft.correlationId,
      draft.causationId ?? null,
      draft.occurredAt,
    ) as { sequence: number };

  // Validates the event and normalises the payload to what a replay will read back
  // (the same JSON string just written), so live delivery and replay never disagree.
  return OrchestrationEventSchema.parse({
    ...draft,
    payload: JSON.parse(payloadJson) as unknown,
    sequence: inserted.sequence,
  });
}

export function latestSequence(db: NoctisDatabase): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events")
    .get() as { sequence: number };

  return row.sequence;
}

type EventRow = {
  sequence: number;
  id: string;
  stream_type: string;
  stream_id: string;
  type: string;
  actor_type: string;
  actor_id: string;
  payload_version: number;
  payload_json: string;
  correlation_id: string;
  causation_id: string | null;
  occurred_at: string;
};

/**
 * Replay window for a resuming client. Every row is re-validated: a row that no
 * longer parses is corruption or tampering, and delivering it would let a
 * client act on something the contract does not describe.
 */
export function readEventsAfter(
  db: NoctisDatabase,
  afterSequence: number,
  limit: number,
): OrchestrationEvent[] {
  const rows = db
    .prepare(
      `SELECT sequence, id, stream_type, stream_id, type, actor_type, actor_id,
              payload_version, payload_json, correlation_id, causation_id, occurred_at
         FROM orchestration_events
        WHERE sequence > ?
        ORDER BY sequence
        LIMIT ?`,
    )
    .all(afterSequence, limit) as EventRow[];

  return rows.map((row) =>
    OrchestrationEventSchema.parse({
      id: row.id,
      sequence: row.sequence,
      streamType: row.stream_type,
      streamId: row.stream_id,
      type: row.type,
      actorType: row.actor_type,
      actorId: row.actor_id,
      payloadVersion: row.payload_version,
      payload: JSON.parse(row.payload_json) as unknown,
      correlationId: row.correlation_id,
      ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
      occurredAt: row.occurred_at,
    }),
  );
}
