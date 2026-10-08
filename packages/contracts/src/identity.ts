import { z } from "zod";

import { ConversationalIdentityIdSchema, ProtocolIdSchema } from "./enums.js";
import { RevisionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";
import { RuntimeProviderIdSchema } from "./runtime.js";

export const IdentityProfileSchema = z
  .object({
    id: ConversationalIdentityIdSchema,
    displayName: z.string().trim().min(1),
    activationCommand: z.string().trim().min(1),
  })
  .strict();

export const ConversationThreadSchema = z
  .object({
    id: UuidSchema,
    identityId: ConversationalIdentityIdSchema,
    /** 0.12: absent on the identity's one free-chat thread; set on its thread for one Objective. */
    objectiveId: UuidSchema.optional(),
    /** Set on a thread another agent started with `noctis_delegate`, and on nothing else. */
    parentThreadId: UuidSchema.optional(),
    parentTurnId: UuidSchema.optional(),
    /**
     * `free` is the identity's one free-chat thread (and an Objective's, and a
     * delegated child). `named` is one the owner opened: a new conversation, or
     * a session started outside Noctis and continued here.
     */
    kind: z.enum(["free", "named"]).default("free"),
    title: z.string().max(200).optional(),
    /** Where a named thread runs. Absent means chosen per message, as before. */
    nodeId: UuidSchema.optional(),
    rootGrantId: z.string().trim().min(1).max(128).optional(),
    providerId: RuntimeProviderIdSchema.optional(),
    /** The session a pinned thread continues, as adopted: where its history before Noctis is read. */
    adoptedSessionRef: z.string().trim().min(1).max(200).optional(),
    /** Off the conversation list until restored. Only a named thread is ever archived. */
    archivedAt: UtcTimestampSchema.optional(),
    activeObjectiveId: UuidSchema.optional(),
    revision: RevisionSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const IdentityMessageSchema = z
  .object({
    id: UuidSchema,
    threadId: UuidSchema,
    role: z.enum(["user", "identity", "system"]),
    protocolId: ProtocolIdSchema.optional(),
    contentRef: z.string().trim().min(1),
    createdAt: UtcTimestampSchema,
  })
  .strict();

export type IdentityProfile = z.infer<typeof IdentityProfileSchema>;
export type ConversationThread = z.infer<typeof ConversationThreadSchema>;

/** One conversation as the thread list shows it: when it last moved, and what was said last. */
export const ConversationSummarySchema = ConversationThreadSchema.extend({
  lastActiveAt: UtcTimestampSchema,
  /** The newest message, cut short. Absent until anything has been said. */
  preview: z.string().max(200).optional(),
}).strict();

export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type IdentityMessage = z.infer<typeof IdentityMessageSchema>;
