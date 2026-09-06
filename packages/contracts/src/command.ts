import { z } from "zod";

import { AuthorityTargetSchema, ReversibilitySchema } from "./authority.js";
import {
  AttentionStateSchema,
  ConversationalIdentityIdSchema,
  MissionStatusSchema,
  ObjectiveStatusSchema,
  OperationClassSchema,
  ProtocolIdSchema,
  SurfaceLifecycleSchema,
  SurfacePersistenceSchema,
  SurfaceRoleSchema,
} from "./enums.js";
import { MissionHostPolicySchema } from "./mission.js";
import { NodeCapabilitySchema } from "./node.js";
import {
  IdempotencyKeySchema,
  RevisionSchema,
  SchemaVersionSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./primitives.js";
import { SurfaceDisplaySchema, SurfaceRegionSchema, SurfaceSizeSchema } from "./surface.js";

/**
 * Every command carries an idempotency key. It is not optional: the core claims
 * it inside the same transaction as the write, which is what makes an HTTP
 * retry safe. A command with no key would have no safe retry.
 */
const CommandBase = { idempotencyKey: IdempotencyKeySchema };

/** The only statuses an Objective may be born in. Everything else is a transition. */
export const InitialObjectiveStatusSchema = z.enum(["suggested", "draft"]);

export const CreateObjectiveCommandSchema = z
  .object({
    ...CommandBase,
    title: z.string().trim().min(1).max(200),
    intent: z.string().trim().min(1).max(4000),
    status: InitialObjectiveStatusSchema,
    identityId: ConversationalIdentityIdSchema,
    protocolIds: z.array(ProtocolIdSchema).default([]),
  })
  .strict();

export const ChangeObjectiveStatusCommandSchema = z
  .object({
    ...CommandBase,
    objectiveId: UuidSchema,
    expectedRevision: RevisionSchema,
    status: ObjectiveStatusSchema,
  })
  .strict();

export const CreateMissionCommandSchema = z
  .object({
    ...CommandBase,
    objectiveId: UuidSchema,
    title: z.string().trim().min(1).max(200),
    operationClass: OperationClassSchema,
    hostPolicy: MissionHostPolicySchema,
    hostId: z.string().trim().min(1).optional(),
  })
  .strict()
  // A named-host Mission with no host names nothing. Caught at the boundary so
  // the service never has to invent a refusal for input the contract can reject.
  .refine((command) => command.hostPolicy !== "named_host" || command.hostId !== undefined, {
    message: "hostId is required when hostPolicy is named_host",
    path: ["hostId"],
  });

export const ChangeMissionStatusCommandSchema = z
  .object({
    ...CommandBase,
    missionId: UuidSchema,
    expectedRevision: RevisionSchema,
    status: MissionStatusSchema,
  })
  .strict();

/**
 * The exact activation commands named in the master plan: `VESPER` and
 * `JESTER` switch the active identity. There is no implicit switch — every
 * change to which identity is active goes through this one command.
 */
export const ActivateIdentityCommandSchema = z
  .object({
    ...CommandBase,
    identityId: ConversationalIdentityIdSchema,
  })
  .strict();

export const RequestAuthorityCommandSchema = z
  .object({
    ...CommandBase,
    objectiveId: UuidSchema.optional(),
    missionId: UuidSchema.optional(),
    actorId: z.string().trim().min(1),
    operationClass: OperationClassSchema,
    capability: z.string().trim().min(1),
    target: AuthorityTargetSchema,
    consequenceSummary: z.string().trim().min(1).max(2000),
    reversibility: ReversibilitySchema,
    estimatedCostGbp: z.number().nonnegative().optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Phase 6: Surface intents, user overrides, and composition.                 */
/* -------------------------------------------------------------------------- */

/**
 * Note what a caller cannot say here: no id, no `requestedAt`, no `lifecycle`,
 * and — the point of Section 5.4 — no x, y, width, height, z-index, monitor, or
 * duration. The only spatial word available is `preferredRegion`, and it is an
 * enum of five names the compositor is free to ignore. A model that one day
 * emits this command is bounded by the same schema the UI is.
 */
export const UpsertSurfaceIntentCommandSchema = z
  .object({
    ...CommandBase,
    objectiveId: UuidSchema,
    kind: z.string().trim().min(1).max(64),
    role: SurfaceRoleSchema,
    persistence: SurfacePersistenceSchema,
    priority: z.int().min(-1000).max(1000),
    minSize: SurfaceSizeSchema,
    preferredRegion: SurfaceRegionSchema.optional(),
    sourceIds: z.array(UuidSchema).max(50).default([]),
    artifactIds: z.array(UuidSchema).max(50).default([]),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
  })
  .strict();

export const ChangeSurfaceLifecycleCommandSchema = z
  .object({ ...CommandBase, surfaceId: UuidSchema, lifecycle: SurfaceLifecycleSchema })
  .strict();

const OverrideScope = {
  surfaceId: UuidSchema,
  clientId: z.string().trim().min(1).max(200),
  displayFingerprint: z.string().trim().min(1).max(200),
};

/**
 * An override is scoped to one client on one display. The same Surface arranged
 * on a laptop screen therefore says nothing about where it belongs on a docked
 * three-monitor desk, which is why the fingerprint is part of the key rather
 * than metadata hanging off it.
 */
export const SetSurfaceOverrideCommandSchema = z
  .object({
    ...CommandBase,
    ...OverrideScope,
    region: SurfaceRegionSchema,
    size: SurfaceSizeSchema,
  })
  .strict();

export const ReleaseSurfaceOverrideCommandSchema = z
  .object({ ...CommandBase, ...OverrideScope })
  .strict();

export const ComposeSurfacesCommandSchema = z
  .object({
    ...CommandBase,
    objectiveId: UuidSchema,
    clientId: z.string().trim().min(1).max(200),
    display: SurfaceDisplaySchema,
    attentionState: AttentionStateSchema,
    focusedSurfaceId: UuidSchema.optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Phase 7: Vault indexing and focused recall.                                */
/* -------------------------------------------------------------------------- */

/**
 * Reindexing takes no path. The root comes from configuration and is refused if
 * it looks like a live Vault, so no caller — a client, a model, a replayed
 * command — can aim indexing at a directory of its choosing.
 */
export const ReindexVaultCommandSchema = z.object({ ...CommandBase }).strict();

export const RecallVaultCommandSchema = z
  .object({
    ...CommandBase,
    query: z.string().trim().min(1).max(500),
    objectiveId: UuidSchema.optional(),
    /** Focused, not exhaustive: a recall opens a subgraph, never the whole Vault. */
    limit: z.int().positive().max(50).optional(),
  })
  .strict();

export const COMMAND_NAMES = [
  "objective.create",
  "objective.change_status",
  "mission.create",
  "mission.change_status",
  "identity.activate",
  "authority.request",
  "surface.upsert_intent",
  "surface.change_lifecycle",
  "surface.set_override",
  "surface.release_override",
  "surface.compose",
  "vault.reindex",
  "vault.recall",
  "node.issue_pairing_code",
  "node.revoke",
  "node.grant_capability",
  "node.job_enqueue",
  "node.job_cancel",
] as const;

export const CommandNameSchema = z.enum(COMMAND_NAMES);

export type InitialObjectiveStatus = z.infer<typeof InitialObjectiveStatusSchema>;
export type CreateObjectiveCommand = z.infer<typeof CreateObjectiveCommandSchema>;
export type ChangeObjectiveStatusCommand = z.infer<typeof ChangeObjectiveStatusCommandSchema>;
export type CreateMissionCommand = z.infer<typeof CreateMissionCommandSchema>;
export type ChangeMissionStatusCommand = z.infer<typeof ChangeMissionStatusCommandSchema>;
export type ActivateIdentityCommand = z.infer<typeof ActivateIdentityCommandSchema>;
export type RequestAuthorityCommand = z.infer<typeof RequestAuthorityCommandSchema>;
export type UpsertSurfaceIntentCommand = z.infer<typeof UpsertSurfaceIntentCommandSchema>;
export type ChangeSurfaceLifecycleCommand = z.infer<typeof ChangeSurfaceLifecycleCommandSchema>;
export type SetSurfaceOverrideCommand = z.infer<typeof SetSurfaceOverrideCommandSchema>;
export type ReleaseSurfaceOverrideCommand = z.infer<typeof ReleaseSurfaceOverrideCommandSchema>;
export type ComposeSurfacesCommand = z.infer<typeof ComposeSurfacesCommandSchema>;
export type ReindexVaultCommand = z.infer<typeof ReindexVaultCommandSchema>;
export type RecallVaultCommand = z.infer<typeof RecallVaultCommandSchema>;
export type CommandName = z.infer<typeof CommandNameSchema>;

/* -------------------------------------------------------------------------- */
/* Phase 3: node lifecycle and job dispatch.                                  */
/* -------------------------------------------------------------------------- */

export const IssueNodePairingCodeCommandSchema = z
  .object({ ...CommandBase, hostId: z.string().trim().min(1).max(200) })
  .strict();

export const RevokeNodeCommandSchema = z.object({ ...CommandBase, nodeId: UuidSchema }).strict();

/**
 * No `operationClass` field: it is derived from the capability through
 * `CAPABILITY_OPERATION_CLASS`, so a grant cannot understate what it permits.
 */
export const GrantNodeCapabilityCommandSchema = z
  .object({
    ...CommandBase,
    nodeId: UuidSchema,
    capability: NodeCapabilitySchema,
    constraints: z.unknown(),
    expiresAt: UtcTimestampSchema.optional(),
  })
  .strict();

export const EnqueueNodeJobCommandSchema = z
  .object({
    ...CommandBase,
    missionId: UuidSchema.optional(),
    capability: NodeCapabilitySchema,
    payload: z.unknown(),
  })
  .strict();

export const CancelNodeJobCommandSchema = z.object({ ...CommandBase, jobId: UuidSchema }).strict();

export type IssueNodePairingCodeCommand = z.infer<typeof IssueNodePairingCodeCommandSchema>;
export type RevokeNodeCommand = z.infer<typeof RevokeNodeCommandSchema>;
export type GrantNodeCapabilityCommand = z.infer<typeof GrantNodeCapabilityCommandSchema>;
export type EnqueueNodeJobCommand = z.infer<typeof EnqueueNodeJobCommandSchema>;
export type CancelNodeJobCommand = z.infer<typeof CancelNodeJobCommandSchema>;

/**
 * The pairing request a node agent posts to `/node/pair`. It is the one request
 * that does not carry the core bearer token — a node has no way to hold one —
 * so the one-time code is the entire credential, and the core treats it as such.
 */
export const PairNodeRequestSchema = z
  .object({
    code: z.string().trim().min(16).max(128),
    hostId: z.string().trim().min(1).max(200),
    fingerprint: z.string().trim().min(1).max(200),
    agentVersion: z.string().trim().min(1).max(64),
  })
  .strict();

export type PairNodeRequest = z.infer<typeof PairNodeRequestSchema>;
