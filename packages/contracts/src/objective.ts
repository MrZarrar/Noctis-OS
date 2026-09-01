import { z } from "zod";

import {
  ConversationalIdentityIdSchema,
  ObjectiveStatusSchema,
  ProtocolIdSchema,
} from "./enums.js";
import { RevisionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

export const ObjectiveRecordSchema = z
  .object({
    id: UuidSchema,
    title: z.string().trim().min(1),
    intent: z.string().trim().min(1),
    status: ObjectiveStatusSchema,
    identityId: ConversationalIdentityIdSchema,
    protocolIds: z.array(ProtocolIdSchema),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    activatedAt: UtcTimestampSchema.optional(),
    completedAt: UtcTimestampSchema.optional(),
    revision: RevisionSchema,
  })
  .strict();

export type ObjectiveRecord = z.infer<typeof ObjectiveRecordSchema>;

export const ObjectiveLinkSchema = z
  .object({
    objectiveId: UuidSchema,
    relatedType: z.enum(["mission", "surface", "artifact", "source", "noir_case"]),
    relatedId: UuidSchema,
    relation: z.string().trim().min(1),
    createdAt: UtcTimestampSchema,
  })
  .strict();

export type ObjectiveLink = z.infer<typeof ObjectiveLinkSchema>;
