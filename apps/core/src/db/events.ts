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
