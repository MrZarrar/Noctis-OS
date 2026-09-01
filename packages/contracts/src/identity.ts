import { z } from "zod";

import { ConversationalIdentityIdSchema, ProtocolIdSchema } from "./enums.js";
import { RevisionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

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
export type IdentityMessage = z.infer<typeof IdentityMessageSchema>;
