import { z } from "zod";

import { AuthorityTargetSchema, ReversibilitySchema } from "./authority.js";
import {
  ConversationalIdentityIdSchema,
  MissionStatusSchema,
  ObjectiveStatusSchema,
  OperationClassSchema,
  ProtocolIdSchema,
} from "./enums.js";
import { MissionHostPolicySchema } from "./mission.js";
import { NodeCapabilitySchema } from "./node.js";
import {
  IdempotencyKeySchema,
  RevisionSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./primitives.js";

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

export const COMMAND_NAMES = [
  "objective.create",
  "objective.change_status",
  "mission.create",
  "mission.change_status",
  "identity.activate",
  "authority.request",
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
