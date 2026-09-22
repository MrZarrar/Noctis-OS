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
  /**
   * Phase 6 appended these two. Section 4.3 reserves names "such as" the list
   * it gives, so it is a floor rather than a ceiling — but a release folded
   * into `override_set` would make every listener filtering for a set override
   * act on its removal, so the two stay distinguishable.
   */
  "surface.override_released.v1",
  "surface.lifecycle_changed.v1",
  "identity.activated.v1",
  "identity.message_added.v1",
  "authority.decision_recorded.v1",
  /**
   * Phase 8 appended these three. Section 4.3 names the decision and the
   * revocation; the consequence boundary needs the rest, because a decision, a
   * human confirming it, and the consequence actually happening are three
   * different facts. An audit that could not separate them could not answer
   * "was this approved before it ran".
   */
  "authority.confirmed.v1",
  "authority.executed.v1",
  "permission.granted.v1",
  "permission.revoked.v1",
  "node.paired.v1",
  "node.connected.v1",
  "node.status_changed.v1",
  "node.capability_granted.v1",
  "node.job_queued.v1",
  "node.job_leased.v1",
  "node.job_status_changed.v1",
  "node.job_result.v1",
  "source.registered.v1",
  "source.observed.v1",
  "artifact.recorded.v1",
  /** An import is not a second recording: it is a new local row with lineage. */
  "artifact.imported.v1",
  "vault.indexed.v1",
  "vault.recall_recorded.v1",
  "noir.hypothesis_added.v1",
  "noir.evidence_linked.v1",
  "noir.synthesis_updated.v1",
  /** Phase 10: a turn is three facts, and a decline is its own. */
  "identity.turn_started.v1",
  "identity.turn_item.v1",
  "identity.turn_completed.v1",
  "authority.declined.v1",
  "provider.decision_recorded.v1",
  "identity.default_model_set.v1",
  /**
   * Task 3.9: the core minted a Gateway token for a named host. The payload
   * names the host, destination and expiry, never the token (ADR-0035).
   */
  "remote.session_opened.v1",
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
  "vault",
  /**
   * Phase 8. A source and an artifact each have a life of their own — an
   * artifact outlives the Mission that produced it, and a source is observed
   * by many — so neither belongs under an Objective's stream.
   */
  "source",
  "artifact",
  /** Phase 10: which runtime was chosen, and why, is a fact about the provider. */
  "provider",
  /** Task 3.9: one stream per remote-desktop session, keyed by its association id. */
  "remote",
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
