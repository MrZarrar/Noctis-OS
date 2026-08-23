import { z } from "zod";

export const ObjectiveStatusSchema = z.enum([
  "suggested",
  "draft",
  "active",
  "paused",
  "completed",
  "abandoned",
]);

export type ObjectiveStatus = z.infer<typeof ObjectiveStatusSchema>;

const UtcTimestampSchema = z.iso.datetime({ offset: true });

export const ObjectiveRecordSchema = z
  .object({
    id: z.uuid(),
    title: z.string().trim().min(1),
    intent: z.string().trim().min(1),
    status: ObjectiveStatusSchema,
    identityId: z.enum(["vesper", "jester"]),
    protocolIds: z.array(z.literal("noir")),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    activatedAt: UtcTimestampSchema.optional(),
    completedAt: UtcTimestampSchema.optional(),
    revision: z.int().nonnegative(),
  })
  .strict();

export type ObjectiveRecord = z.infer<typeof ObjectiveRecordSchema>;
