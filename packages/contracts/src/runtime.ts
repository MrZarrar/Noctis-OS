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
import { TriggerSchema } from "./trigger.js";

/* -------------------------------------------------------------------------- */
/* The runtime vocabulary. Imports nothing from node.ts; node.ts imports this. */
/* -------------------------------------------------------------------------- */

/**
 * The only runtimes a node may spawn. No metered API adapter is ever registered.
 * `local` is a model served on the node itself, over loopback (v1 S3).
 */
export const RUNTIME_PROVIDERS = ["codex", "claude", "hermes", "local"] as const;

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
    // Unlike $, this end check also rejects a final newline.
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}(?![\s\S])/),
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

/**
 * Core-derived: the PCs, shared folders and scheduled tasks the owner's words
 * can name, so a model proposing a task never invents an id.
 */
export const RuntimeTargetsSchema = z
  .object({
    pcs: z
      .array(
        z
          .object({
            nodeId: UuidSchema,
            hostId: z.string().min(1).max(253),
            current: z.boolean(),
            online: z.boolean(),
            /** The owner is using this PC now, so "my PC" means it. */
            ownerPresent: z.boolean().optional(),
          })
          .strict(),
      )
      .max(32),
    folders: z
      .array(
        z
          .object({ grantId: ShortId, nodeId: UuidSchema, path: z.string().min(1).max(1024) })
          .strict(),
      )
      .max(128),
    tasks: z
      .array(
        z
          .object({ taskId: UuidSchema, name: z.string().min(1).max(200), paused: z.boolean() })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type RuntimeTargets = z.infer<typeof RuntimeTargetsSchema>;

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
    /** Core-derived reservation marker; API and model input never set it. */
    scheduledTaskId: UuidSchema.optional(),
    targets: RuntimeTargetsSchema.optional(),
    /** The core's owner clock zone; workers may run in a different zone. */
    ownerTimeZone: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      })
      .optional(),
    /**
     * Files the node fetches from the core before the runtime starts. Resolved
     * by the core from `attachmentIds`, so a node never sees an id the core did
     * not confirm exists — and never sees a path, because it makes its own.
     */
    attachments: z.array(AttachmentRefSchema).max(8).optional(),
  })
  .strict();

/**
 * What a wake carries: a turn's payload with nothing said in it, so the node
 * readies the same runtime, model, folder and session the next turn will use.
 */
export const RuntimeWarmPayloadSchema = RuntimeTurnPayloadSchema.omit({
  prompt: true,
  userMessageId: true,
  attachments: true,
}).strict();

export type RuntimeWarmPayload = z.infer<typeof RuntimeWarmPayloadSchema>;

/** Whether there was anything to warm: Claude and Codex start fast and have nothing. */
export const RuntimeWarmEvidenceSchema = z.object({ warmed: z.boolean() }).strict();

export const RuntimeItemStatusSchema = z.enum(["in_progress", "completed", "failed", "declined"]);

/** Where promotion may write: the structured folders, never inbox/, agent/ or daily/. */
export const VaultEditPathSchema = z
  .string()
  .trim()
  .max(300)
  .regex(/^(people|reference|projects)\/[^\\:]+\.md$/)
  .refine((path) => !path.split("/").includes(".."), "may not leave its folder");

const InboxSourceSchema = z
  .string()
  .trim()
  .max(300)
  .regex(/^inbox\/[^\\:]+\.md$/);

/** What a runtime may propose. Proposals are data until the core turns them into commands. */
export const RuntimeProposalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task_action"),
      taskId: UuidSchema,
      action: z.enum(["run_now", "pause"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reminder"),
      text: z.string().trim().min(1).max(2000),
      note: z.string().max(20_000).optional(),
      trigger: TriggerSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("note"),
      title: z.string().trim().min(1).max(200),
      body: z.string().max(100_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      taskId: UuidSchema.optional(),
      name: z.string().trim().min(1).max(200),
      prompt: z.string().min(1).max(20_000),
      model: ModelRefSchema,
      nodeId: UuidSchema,
      rootGrantId: z.string().trim().min(1).max(128),
      trigger: TriggerSchema.refine((trigger) => trigger !== null),
      threadMode: z.enum(["new", "continue"]).default("new"),
      maxRunMinutes: z.int().min(1).max(1440).default(30),
    })
    .strict(),
  z
    .object({
      kind: z.literal("surface"),
      surfaceKind: z.string().trim().min(1).max(64),
      /**
       * The agent's own name for a panel it keeps updating. Without one a
       * panel belongs to the turn that proposed it, and the next turn's is new.
       */
      panelId: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
        .optional(),
      /** The file a panel showed by path is gone, so the panel closes. */
      withdrawn: z.literal(true).optional(),
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
  /** A durable fact for the MindVault inbox. The core writes it; the promoter files it later. */
  z
    .object({
      kind: z.literal("inbox_note"),
      title: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(8000),
    })
    .strict(),
  /** One line added to a note's Noctis block. Add-only, so it applies without asking. */
  z
    .object({
      kind: z.literal("vault_fact"),
      path: VaultEditPathSchema,
      fact: z.string().trim().min(3).max(500),
      source: InboxSourceSchema,
    })
    .strict(),
  /** A Vault note that does not exist yet. Refused if it does. */
  z
    .object({
      kind: z.literal("vault_note"),
      path: VaultEditPathSchema,
      title: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(8000),
      source: InboxSourceSchema,
    })
    .strict(),
  /** A change to the owner's own words. Never applied without the owner. */
  z
    .object({
      kind: z.literal("vault_revision"),
      path: VaultEditPathSchema,
      find: z.string().min(1).max(2000),
      replace: z.string().max(2000),
      reason: z.string().trim().min(3).max(500),
      source: InboxSourceSchema,
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

const ItemBase = {
  itemId: ShortId,
  status: RuntimeItemStatusSchema,
  /** The sub-agent whose step this is; absent for the main agent's own. */
  parentItemId: ShortId.optional(),
};

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
      /** What the agent said the command is for, when it said. */
      description: z.string().max(500).optional(),
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
  z
    .object({
      ...ItemBase,
      kind: z.literal("proposal"),
      proposal: RuntimeProposalSchema,
      appliedRecordId: UuidSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...ItemBase,
      kind: z.literal("sub_agent"),
      label: z.string().max(200),
      /** What a running sub-agent is doing now, in a line. */
      activity: z.string().max(200).optional(),
      /** What it was asked to do. */
      task: z.string().max(2000).optional(),
      /** What it reported back when it finished. */
      report: z.string().max(4000).optional(),
      tokens: z.int().nonnegative().optional(),
      toolUses: z.int().nonnegative().optional(),
      durationMs: z.int().nonnegative().optional(),
    })
    .strict(),
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
