import { z } from "zod";

import { SchemaVersionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

/**
 * The complete set of registered event names. An unregistered name or an unknown
 * version fails to parse, satisfying the fail-closed contract rule. Phase 2 and
 * Phase 3 only appended to it, so every Phase 1 event still parses.
 * See ADR-0009 and ADR-0011.
 */
export const EVENT_NAMES = [
  "objective.created.v1",
  "objective.activated.v1",
  "objective.status_changed.v1",
  "mission.created.v1",
  "mission.approval_requested.v1",
  "mission.dispatched.v1",
  "mission.status_changed.v1",
  "mission.verified.v1",
  "surface.intent_upserted.v1",
  "surface.composition_changed.v1",
  "surface.override_set.v1",
  "identity.activated.v1",
  "identity.message_added.v1",
  "authority.decision_recorded.v1",
  "permission.revoked.v1",
  "node.paired.v1",
  "node.connected.v1",
  "node.status_changed.v1",
  "node.capability_granted.v1",
  "node.job_queued.v1",
  "node.job_leased.v1",
  "node.job_status_changed.v1",
  "node.job_result.v1",
  "source.observed.v1",
  "artifact.recorded.v1",
  "noir.hypothesis_added.v1",
  "noir.evidence_linked.v1",
  "noir.synthesis_updated.v1",
] as const;

export const EventNameSchema = z.enum(EVENT_NAMES);

export const StreamTypeSchema = z.enum([
  "objective",
  "mission",
  "identity",
  "surface",
  "node",
  /**
   * A job's own stream. Deliberately not folded into `node`: a queued job has no
   * node yet, and keying job events by a job id under the `node` stream type would
   * make "read the stream for node X" return rows that are not about node X.
   */
  "node_job",
  "noir",
  "authority",
]);

export const ActorTypeSchema = z.enum(["user", "identity", "system", "node", "adapter"]);

export const OrchestrationEventSchema = z
  .object({
    id: UuidSchema,
    /** Global monotonic sequence. Monotonic, not guaranteed gapless. */
    sequence: z.int().positive(),
    streamType: StreamTypeSchema,
    streamId: UuidSchema,
    type: EventNameSchema,
    actorType: ActorTypeSchema,
    actorId: z.string().trim().min(1),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    correlationId: UuidSchema,
    causationId: UuidSchema.optional(),
    occurredAt: UtcTimestampSchema,
  })
  .strict();

export type EventName = z.infer<typeof EventNameSchema>;
export type StreamType = z.infer<typeof StreamTypeSchema>;
export type ActorType = z.infer<typeof ActorTypeSchema>;
export type OrchestrationEvent = z.infer<typeof OrchestrationEventSchema>;
