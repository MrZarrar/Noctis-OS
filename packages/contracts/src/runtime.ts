import { z } from "zod";

import { AttachmentRefSchema } from "./attachment.js";
import { AuthorityTargetSchema, ReversibilitySchema } from "./authority.js";
import {
  ConversationalIdentityIdSchema,
  OperationClassSchema,
  SurfacePersistenceSchema,
  SurfaceRoleSchema,
} from "./enums.js";
import { SchemaVersionSchema, UuidSchema } from "./primitives.js";

/* -------------------------------------------------------------------------- */
/* The runtime vocabulary. Imports nothing from node.ts; node.ts imports this. */
/* -------------------------------------------------------------------------- */

/** The only runtimes a node may spawn. No metered API adapter is ever registered. */
export const RUNTIME_PROVIDERS = ["codex", "claude", "hermes"] as const;

export const RuntimeProviderIdSchema = z.enum(RUNTIME_PROVIDERS);

export type RuntimeProviderId = z.infer<typeof RuntimeProviderIdSchema>;

/** A mode string, never a token. */
export const RuntimeAuthModeSchema = z.enum([
  "chatgpt",
  "claude_ai",
  "local",
  "api_key",
  "unknown",
]);

export type RuntimeAuthMode = z.infer<typeof RuntimeAuthModeSchema>;

/** Dispatch refuses any other mode: `api_key` is metered and `unknown` is unproven. */
export const ELIGIBLE_AUTH_MODES: ReadonlySet<RuntimeAuthMode> = new Set<RuntimeAuthMode>([
  "chatgpt",
  "claude_ai",
  "local",
]);

const ShortId = z.string().trim().min(1).max(128);

/** A model is data: which provider, which model name, and what to call it. */
export const ModelRefSchema = z
  .object({
    providerId: RuntimeProviderIdSchema,
    model: ShortId,
    label: ShortId.optional(),
  })
  .strict();

/** What a node found out about one provider at start-up. Reported in `hello`. */
export const RuntimeProbeSchema = z
  .object({
    providerId: RuntimeProviderIdSchema,
    available: z.boolean(),
    authMode: RuntimeAuthModeSchema,
    version: z.string().max(64).optional(),
    reason: z.string().max(500).optional(),
    models: z.array(ModelRefSchema).max(64).default([]),
  })
  .strict();

/** A root the operator granted. Requesters name the grant id, never the path. */
export const RuntimeRootSchema = z
  .object({
    grantId: ShortId,
    path: z.string().trim().min(1),
    mode: z.enum(["read", "write"]),
    /** A root that never leaves this machine — no remote node may be routed to it. */
    localOnly: z.boolean().default(false),
  })
  .strict();

export const RuntimeGrantConstraintsSchema = z
  .object({
    providers: z.array(RuntimeProviderIdSchema).min(1).max(RUNTIME_PROVIDERS.length),
    roots: z.array(RuntimeRootSchema).min(1).max(16),
  })
  .strict();

/** The payload of a `runtime.turn` job. */
export const RuntimeTurnPayloadSchema = z
  .object({
    threadId: UuidSchema,
    identityId: ConversationalIdentityIdSchema,
    model: ModelRefSchema,
    userMessageId: UuidSchema,
    /** Not trimmed: whitespace the user typed is part of what the model sees. */
    prompt: z.string().min(1).max(20_000),
    primaryRootGrantId: ShortId,
    sessionRef: z.string().trim().min(1).max(512).optional(),
    /**
     * Continue from `sessionRef` in a copy rather than in it: set on the first
     * turn of a session started outside Noctis, which may still be open in
     * VS Code or a terminal, so Noctis never writes into it.
     */
    forkSession: z.boolean().optional(),
    objectiveId: UuidSchema.optional(),
    objectiveActive: z.boolean(),
    /**
     * Files the node fetches from the core before the runtime starts. Resolved
     * by the core from `attachmentIds`, so a node never sees an id the core did
     * not confirm exists — and never sees a path, because it makes its own.
     */
    attachments: z.array(AttachmentRefSchema).max(8).optional(),
  })
  .strict();

export const RuntimeItemStatusSchema = z.enum(["in_progress", "completed", "failed", "declined"]);

/** What a runtime may propose. Proposals are data until the core turns them into commands. */
export const RuntimeProposalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("surface"),
      surfaceKind: z.string().trim().min(1).max(64),
      role: SurfaceRoleSchema,
      persistence: SurfacePersistenceSchema,
      priority: z.int().min(-1000).max(1000),
      payloadVersion: SchemaVersionSchema,
      payload: z.unknown(),
      objectiveId: UuidSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("objective"),
      title: z.string().trim().min(1).max(200),
      intent: z.string().trim().min(1).max(4000),
    })
    .strict(),
  /**
   * One durable thing learned about how to work with the owner, for the Agent
   * Brain (`agent/brain.md` in the Vault). A proposal like every other kind
   * here: the runtime says it, the core applies the rules and writes the file —
   * or refuses, when writes are off, the brain is full, or it is already there.
   *
   * Capped at one bullet's worth of text. A paragraph in a file whose whole
   * value is that it stays short is how that file stops being read.
   */
  z
    .object({
      kind: z.literal("preference"),
      bullet: z.string().trim().min(8).max(300),
    })
    .strict(),
]);

/**
 * A file a turn produced that the owner can open: an image Codex generated,
 * say. `attachmentId` is set once the node has handed the bytes to the core;
 * `path` is where the file sits on the node that made it.
 */
export const RuntimeOutputSchema = z
  .object({
    mediaType: z.string().trim().min(1).max(128),
    path: z.string().max(1024).optional(),
    attachmentId: UuidSchema.optional(),
  })
  .strict();

/**
 * One agent handing work to another through Noctis. The core creates or
 * continues the child thread; `threadId` names a child thread the same parent
 * already started, and `node` a node id or host name to run it on.
 */
export const RuntimeDelegationSchema = z
  .object({
    delegationId: UuidSchema,
    runtime: RuntimeProviderIdSchema,
    prompt: z.string().min(1).max(20_000),
    threadId: UuidSchema.optional(),
    node: ShortId.optional(),
  })
  .strict();

export const RuntimeDelegationResultSchema = z
  .object({
    delegationId: UuidSchema,
    outcome: z.enum(["completed", "failed", "refused"]),
    threadId: UuidSchema.optional(),
    reply: z.string().max(20_000).optional(),
    outputs: z.array(RuntimeOutputSchema).max(50).default([]),
    reason: z.string().max(500).optional(),
  })
  .strict();

const ItemBase = { itemId: ShortId, status: RuntimeItemStatusSchema };

/** One thing the runtime did during a turn, bounded so a node cannot flood the core. */
export const RuntimeItemSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...ItemBase, kind: z.literal("agent_message"), text: z.string().max(20_000) })
    .strict(),
  z
    .object({
      ...ItemBase,
      kind: z.literal("command"),
      command: z.string().max(4000),
      cwd: z.string().max(1024).optional(),
      output: z.string().max(4000).optional(),
      exitCode: z.int().optional(),
    })
    .strict(),
  z
    .object({
      ...ItemBase,
      kind: z.literal("file_change"),
      paths: z.array(z.string().max(1024)).max(200),
      summary: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      ...ItemBase,
      kind: z.literal("tool_call"),
      tool: z.string().max(128),
      input: z.unknown().optional(),
      output: z.string().max(4000).optional(),
    })
    .strict(),
  z.object({ ...ItemBase, kind: z.literal("proposal"), proposal: RuntimeProposalSchema }).strict(),
  z.object({ ...ItemBase, kind: z.literal("sub_agent"), label: z.string().max(200) }).strict(),
  z.object({ ...ItemBase, kind: z.literal("output"), ...RuntimeOutputSchema.shape }).strict(),
]);

/** A token delta. The one ephemeral channel; never written to `orchestration_events`. */
export const RuntimeDeltaSchema = z
  .object({ itemId: ShortId, text: z.string().min(1).max(2000) })
  .strict();

/** The runtime wants to do something consequential. It waits until the core answers. */
export const RuntimeAskSchema = z
  .object({
    askId: UuidSchema,
    itemId: ShortId,
    kind: z.enum(["command", "file_change", "permission", "tool_call"]),
    summary: z.string().trim().min(1).max(2000),
    operationClass: OperationClassSchema,
    reversibility: ReversibilitySchema,
    capability: ShortId,
    target: AuthorityTargetSchema,
    detail: z
      .object({
        command: z.string().max(4000).optional(),
        cwd: z.string().max(1024).optional(),
        paths: z.array(z.string().max(1024)).max(200).optional(),
        tool: z.string().max(128).optional(),
      })
      .strict()
      .optional(),
    /**
     * `runtime`: the agent's own permission system asked, so a person answers.
     * `noctis` (or absent, from an older node): Noctis stopped a confirm-level
     * action before it ran, and policy decides.
     */
    askedBy: z.enum(["runtime", "noctis"]).optional(),
  })
  .strict();

/** The core's answer. Always carries the approval it was recorded under. */
export const RuntimeAnswerSchema = z
  .object({
    askId: UuidSchema,
    decision: z.enum(["allow", "deny"]),
    approvalId: UuidSchema,
    reason: z.string().max(500).optional(),
  })
  .strict();

export const RuntimeTurnEvidenceSchema = z
  .object({
    model: ModelRefSchema,
    sessionRef: z.string().max(512).optional(),
    itemCount: z.int().nonnegative(),
    finalText: z.string().max(20_000).optional(),
    usage: z
      .object({
        inputTokens: z.int().nonnegative().optional(),
        outputTokens: z.int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    stoppedReason: z.enum(["completed", "cancelled", "failed", "declined"]),
  })
  .strict();

export type ModelRef = z.infer<typeof ModelRefSchema>;
export type RuntimeProbe = z.infer<typeof RuntimeProbeSchema>;
export type RuntimeRoot = z.infer<typeof RuntimeRootSchema>;
export type RuntimeGrantConstraints = z.infer<typeof RuntimeGrantConstraintsSchema>;
export type RuntimeTurnPayload = z.infer<typeof RuntimeTurnPayloadSchema>;
export type RuntimeItemStatus = z.infer<typeof RuntimeItemStatusSchema>;
export type RuntimeProposal = z.infer<typeof RuntimeProposalSchema>;
export type RuntimeItem = z.infer<typeof RuntimeItemSchema>;
export type RuntimeDelta = z.infer<typeof RuntimeDeltaSchema>;
export type RuntimeAsk = z.infer<typeof RuntimeAskSchema>;
export type RuntimeAnswer = z.infer<typeof RuntimeAnswerSchema>;
export type RuntimeTurnEvidence = z.infer<typeof RuntimeTurnEvidenceSchema>;
export type RuntimeOutput = z.infer<typeof RuntimeOutputSchema>;
export type RuntimeDelegation = z.infer<typeof RuntimeDelegationSchema>;
export type RuntimeDelegationResult = z.infer<typeof RuntimeDelegationResultSchema>;
