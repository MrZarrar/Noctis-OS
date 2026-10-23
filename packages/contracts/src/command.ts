import { z } from "zod";

import { ArtifactKindSchema } from "./artifact.js";
import {
  AuthorityConstraintSchema,
  AuthorityTargetSchema,
  ReversibilitySchema,
} from "./authority.js";
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
import { ModelRefSchema, RuntimeProviderIdSchema } from "./runtime.js";
import { SETTING_VALUE_SCHEMAS, SettingKeySchema } from "./settings.js";
import type { SettingKey } from "./settings.js";
import { UnavailableSemanticsSchema } from "./source.js";
import {
  SurfaceOwnerSchema,
  SurfaceDisplaySchema,
  SurfaceRegionSchema,
  SurfacePlacementRegionSchema,
  SurfaceSizeSchema,
  SurfaceSourceIdSchema,
} from "./surface.js";

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
    taskId: UuidSchema.optional(),
    ...CommandBase,
    objectiveId: UuidSchema.optional(),
    missionId: UuidSchema.optional(),
    actorId: z.string().trim().min(1),
    operationClass: OperationClassSchema,
    capability: z.string().trim().min(1),
    target: AuthorityTargetSchema,
    consequenceSummary: z.string().trim().min(1).max(2000),
    consequenceDetail: z.string().max(4000).optional(),
    reversibility: ReversibilitySchema,
    estimatedCostGbp: z.number().nonnegative().optional(),
    /** Set when a runtime ask raised the request, so the answer can find its way back. */
    nodeJobId: UuidSchema.optional(),
    askId: UuidSchema.optional(),
    /** The agent's own permission system asked; policy alone never answers it. */
    askedByRuntime: z.boolean().optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Phase 10: conversational turns on spawned runtimes.                        */
/* -------------------------------------------------------------------------- */

/**
 * Continue a session an agent keeps on a PC — started in VS Code, a terminal or
 * anywhere else — as a Noctis thread. The thread runs there and nowhere else:
 * that PC, that shared folder, that agent.
 */
export const AdoptRuntimeSessionCommandSchema = z
  .object({
    ...CommandBase,
    identityId: ConversationalIdentityIdSchema,
    nodeId: UuidSchema,
    rootGrantId: z.string().trim().min(1).max(128),
    providerId: RuntimeProviderIdSchema,
    sessionRef: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
  })
  .strict();

/** A new conversation beside the identity's free one. The agent and PC are chosen per message, as in free chat. */
export const CreateConversationThreadCommandSchema = z
  .object({
    ...CommandBase,
    identityId: ConversationalIdentityIdSchema,
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** Names a conversation the owner opened. Free chat keeps its name. */
export const RenameConversationThreadCommandSchema = z
  .object({
    ...CommandBase,
    threadId: UuidSchema,
    title: z.string().trim().min(1).max(200),
  })
  .strict();

/** Moves a conversation off the list (`archived: true`) or back onto it. Nothing is deleted. */
export const ArchiveConversationThreadCommandSchema = z
  .object({
    ...CommandBase,
    threadId: UuidSchema,
    archived: z.boolean(),
  })
  .strict();

/**
 * Free chat starts again: the current free thread joins the list as an ordinary
 * conversation, sessions and all, and the next message opens a new one.
 */
export const StartFreshConversationCommandSchema = z
  .object({ ...CommandBase, identityId: ConversationalIdentityIdSchema })
  .strict();

export const SendConversationMessageCommandSchema = z
  .object({
    ...CommandBase,
    identityId: ConversationalIdentityIdSchema,
    /** Not trimmed: the user's whitespace is the user's. */
    text: z.string().min(1).max(20_000),
    /** Absent means the identity's default model. */
    model: ModelRefSchema.optional(),
    objectiveId: UuidSchema.optional(),
    /**
     * Continue this thread rather than the identity's free or Objective one.
     * How the owner picks up a thread an agent delegated.
     */
    threadId: UuidSchema.optional(),
    /** A grant id the turn must run inside. Absent means the chosen node's first writable root. */
    rootGrantId: z.string().trim().min(1).max(128).optional(),
    /**
     * Files already uploaded through `POST /attachments`, in the order the
     * prompt should name them. Ids rather than bytes: a command is a small JSON
     * body that is retried on idempotency, and re-uploading 10 MB on a retry is
     * not a thing a phone on a train should be asked to do.
     */
    attachmentIds: z.array(UuidSchema).max(8).optional(),
  })
  .strict();

export const CancelConversationTurnCommandSchema = z
  .object({ ...CommandBase, jobId: UuidSchema })
  .strict();

/** The human says no. Separate from `deny`: a policy denies, a person declines. */
export const DeclineAuthorityCommandSchema = z
  .object({
    ...CommandBase,
    requestId: UuidSchema,
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const SetIdentityDefaultModelCommandSchema = z
  .object({ ...CommandBase, identityId: ConversationalIdentityIdSchema, model: ModelRefSchema })
  .strict();

export type SendConversationMessageCommand = z.infer<typeof SendConversationMessageCommandSchema>;
export type AdoptRuntimeSessionCommand = z.infer<typeof AdoptRuntimeSessionCommandSchema>;
export type CreateConversationThreadCommand = z.infer<typeof CreateConversationThreadCommandSchema>;
export type RenameConversationThreadCommand = z.infer<typeof RenameConversationThreadCommandSchema>;
export type ArchiveConversationThreadCommand = z.infer<
  typeof ArchiveConversationThreadCommandSchema
>;
export type StartFreshConversationCommand = z.infer<typeof StartFreshConversationCommandSchema>;
export type CancelConversationTurnCommand = z.infer<typeof CancelConversationTurnCommandSchema>;
export type DeclineAuthorityCommand = z.infer<typeof DeclineAuthorityCommandSchema>;
export type SetIdentityDefaultModelCommand = z.infer<typeof SetIdentityDefaultModelCommandSchema>;

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
    ...SurfaceOwnerSchema.shape,
    kind: z.string().trim().min(1).max(64),
    role: SurfaceRoleSchema,
    persistence: SurfacePersistenceSchema,
    priority: z.int().min(-1000).max(1000),
    minSize: SurfaceSizeSchema,
    preferredRegion: SurfaceRegionSchema.optional(),
    sourceIds: z.array(SurfaceSourceIdSchema).max(50).default([]),
    artifactIds: z.array(UuidSchema).max(50).default([]),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
  })
  .strict()
  .refine(
    (value) =>
      SurfaceOwnerSchema.safeParse({
        objectiveId: value.objectiveId,
        threadId: value.threadId,
        presence: value.presence,
      }).success,
    { message: "exactly one of objectiveId, threadId and presence" },
  );

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

export const ArrangeSurfacesCommandSchema = z
  .object({
    ...CommandBase,
    ...SurfaceOwnerSchema.shape,
    clientId: z.string().trim().min(1).max(200),
    display: SurfaceDisplaySchema,
    attentionState: AttentionStateSchema,
    placements: z
      .array(
        z
          .object({
            surfaceId: UuidSchema,
            region: SurfacePlacementRegionSchema,
            size: SurfaceSizeSchema,
            order: z.int().nonnegative().max(100).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .refine(
    (value) =>
      SurfaceOwnerSchema.safeParse({
        objectiveId: value.objectiveId,
        threadId: value.threadId,
        presence: value.presence,
      }).success,
    { message: "exactly one owner" },
  )
  .refine(
    (value) =>
      new Set(value.placements.map((entry) => entry.surfaceId)).size === value.placements.length,
    { message: "unique panels" },
  );
export type ArrangeSurfacesCommand = z.infer<typeof ArrangeSurfacesCommandSchema>;

export const ComposeSurfacesCommandSchema = z
  .object({
    ...CommandBase,
    ...SurfaceOwnerSchema.shape,
    clientId: z.string().trim().min(1).max(200),
    display: SurfaceDisplaySchema,
    attentionState: AttentionStateSchema,
    focusedSurfaceId: UuidSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      SurfaceOwnerSchema.safeParse({
        objectiveId: value.objectiveId,
        threadId: value.threadId,
        presence: value.presence,
      }).success,
    { message: "exactly one of objectiveId, threadId and presence" },
  );

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

/** Give Vesper the next batch of unfiled inbox notes now, not at the nightly time. */
export const PromoteVaultCommandSchema = z.object({ ...CommandBase }).strict();

/** Undo a promoted edit, or apply or decline a revision that waits for the owner. */
export const VaultEditCommandSchema = z.object({ ...CommandBase, editId: UuidSchema }).strict();

/* -------------------------------------------------------------------------- */
/* Phase 8: confirmation, execution, permissions, sources, and artifacts.     */
/* -------------------------------------------------------------------------- */

/**
 * The confirmation half of the prepare/commit boundary.
 *
 * Separate from `authority.request` on purpose: a request is a question and
 * this is the answer, and collapsing them would mean the same call that asks
 * whether something may happen also says that it may. `typedConfirmation` is
 * required exactly when the decision demanded one, and it is compared against a
 * phrase the core derived — never one the caller proposed.
 */
export const ConfirmAuthorityCommandSchema = z
  .object({
    ...CommandBase,
    requestId: UuidSchema,
    typedConfirmation: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * The commit half. Recording an execution is what makes the consequence
 * irreversible in Noctis's own terms, so it happens once and carries the
 * evidence the external system returned.
 */
export const ExecuteAuthorityCommandSchema = z
  .object({
    ...CommandBase,
    requestId: UuidSchema,
    evidenceVersion: SchemaVersionSchema,
    evidence: z.unknown(),
  })
  .strict();

/**
 * A standing permission is granted with its constraints, never widened later.
 * There is no `update`: changing scope means revoking and granting again, so
 * the audit trail shows a new grant rather than a mutated one.
 */
export const GrantStandingPermissionCommandSchema = z
  .object({
    taskId: UuidSchema.optional(),
    ...CommandBase,
    actorId: z.string().trim().min(1).max(200),
    capability: z.string().trim().min(1).max(200),
    operationClass: OperationClassSchema,
    constraints: AuthorityConstraintSchema,
    expiresAt: UtcTimestampSchema.optional(),
  })
  .strict();

export const RevokeStandingPermissionCommandSchema = z
  .object({
    ...CommandBase,
    permissionId: UuidSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** Registering a source declares its freshness policy and unavailable semantics up front. */
export const RegisterSourceCommandSchema = z
  .object({
    ...CommandBase,
    sourceType: z.string().trim().min(1).max(100),
    externalId: z.string().trim().min(1).max(500),
    freshnessSeconds: z.int().positive().max(31_536_000),
    unavailableSemantics: UnavailableSemanticsSchema,
  })
  .strict();

/**
 * One normalized live observation. The adapter says what it saw and when; it
 * does not say whether that is current, because currency is a function of the
 * source's policy and the clock, and an adapter that could assert it could
 * assert it wrongly.
 */
export const ObserveSourceCommandSchema = z
  .object({
    ...CommandBase,
    sourceId: UuidSchema,
    reachable: z.boolean(),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
  })
  .strict();

export const RecordArtifactCommandSchema = z
  .object({
    ...CommandBase,
    kind: ArtifactKindSchema,
    title: z.string().trim().min(1).max(200),
    uri: z.string().trim().min(1).max(2000),
    mediaType: z.string().trim().min(1).max(200).optional(),
    objectiveId: UuidSchema.optional(),
    missionId: UuidSchema.optional(),
    sourceId: UuidSchema.optional(),
    hostId: z.string().trim().min(1).max(200).optional(),
    checksum: z.string().trim().min(1).max(200).optional(),
    provenanceVersion: SchemaVersionSchema,
    provenance: z.unknown(),
  })
  .strict()
  .refine(
    (command) =>
      command.kind !== "local_artifact" ||
      (command.hostId !== undefined && command.checksum !== undefined),
    {
      message: "a local_artifact must name the host that holds it and the checksum of its bytes",
      path: ["checksum"],
    },
  );

/**
 * The import that turns an external reference into a local artifact.
 *
 * It creates a second row rather than changing the first, because Section 12.2
 * asks for lineage: after an import the Vault can still say "this file came
 * from that remote thing", which a mutated row could not.
 */
export const ImportArtifactCommandSchema = z
  .object({
    ...CommandBase,
    artifactId: UuidSchema,
    hostId: z.string().trim().min(1).max(200),
    uri: z.string().trim().min(1).max(2000),
    checksum: z.string().trim().min(1).max(200),
    mediaType: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type ConfirmAuthorityCommand = z.infer<typeof ConfirmAuthorityCommandSchema>;
export type ExecuteAuthorityCommand = z.infer<typeof ExecuteAuthorityCommandSchema>;
export type GrantStandingPermissionCommand = z.infer<typeof GrantStandingPermissionCommandSchema>;
export type RevokeStandingPermissionCommand = z.infer<typeof RevokeStandingPermissionCommandSchema>;
export type RegisterSourceCommand = z.infer<typeof RegisterSourceCommandSchema>;
export type ObserveSourceCommand = z.infer<typeof ObserveSourceCommandSchema>;
export type RecordArtifactCommand = z.infer<typeof RecordArtifactCommandSchema>;
export type ImportArtifactCommand = z.infer<typeof ImportArtifactCommandSchema>;

/**
 * Wakes an agent before the owner sends: the node chosen as a send would choose
 * it loads the model and starts the runtime. Nothing is said and no turn is made.
 */
export const WarmConversationCommandSchema = z
  .object({
    ...CommandBase,
    identityId: ConversationalIdentityIdSchema,
    model: ModelRefSchema.optional(),
    objectiveId: UuidSchema.optional(),
    threadId: UuidSchema.optional(),
    rootGrantId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export type WarmConversationCommand = z.infer<typeof WarmConversationCommandSchema>;

/** One setting set on the Settings page, checked against that setting's own schema. */
export const SetSettingCommandSchema = z.discriminatedUnion(
  "key",
  (Object.keys(SETTING_VALUE_SCHEMAS) as SettingKey[]).map((key) =>
    z.object({ ...CommandBase, key: z.literal(key), value: SETTING_VALUE_SCHEMAS[key] }).strict(),
  ) as unknown as readonly [z.ZodObject, ...z.ZodObject[]],
);

/** Forgets the owner's value, so the start-up value or the default answers again. */
export const ResetSettingCommandSchema = z
  .object({ ...CommandBase, key: SettingKeySchema })
  .strict();

export type SetSettingCommand = {
  [K in SettingKey]: {
    idempotencyKey: string;
    key: K;
    value: z.infer<(typeof SETTING_VALUE_SCHEMAS)[K]>;
  };
}[SettingKey];
export type ResetSettingCommand = z.infer<typeof ResetSettingCommandSchema>;

export const COMMAND_NAMES = [
  "objective.create",
  "objective.change_status",
  "mission.create",
  "mission.change_status",
  "identity.activate",
  "authority.request",
  "authority.confirm",
  "authority.execute",
  "authority.grant_permission",
  "authority.revoke_permission",
  "source.register",
  "source.observe",
  "artifact.record",
  "artifact.import",
  "surface.upsert_intent",
  "surface.change_lifecycle",
  "surface.set_override",
  "surface.release_override",
  "surface.compose",
  "vault.reindex",
  "vault.recall",
  "vault.promote_now",
  "vault.undo_edit",
  "vault.apply_revision",
  "vault.decline_revision",
  "settings.set",
  "settings.reset",
  "node.issue_pairing_code",
  "node.revoke",
  "node.grant_capability",
  "node.job_enqueue",
  "node.job_cancel",
  "conversation.send",
  "conversation.warm",
  "conversation.cancel",
  "authority.decline",
  "identity.set_default_model",
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
export type PromoteVaultCommand = z.infer<typeof PromoteVaultCommandSchema>;
export type VaultEditCommand = z.infer<typeof VaultEditCommandSchema>;
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

/**
 * Stops sharing one folder. Every live grant naming it is revoked, and a grant
 * that named other folders too is granted again without it, so the rest stay.
 */
export const UnshareNodeFolderCommandSchema = z
  .object({ ...CommandBase, nodeId: UuidSchema, rootGrantId: z.string().trim().min(1).max(128) })
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
export type UnshareNodeFolderCommand = z.infer<typeof UnshareNodeFolderCommandSchema>;
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
