import { z } from "zod";

import { SchemaVersionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

export const ArtifactRecordSchema = z
  .object({
    id: UuidSchema,
    kind: z.enum(["local_artifact", "external_reference"]),
    title: z.string().trim().min(1),
    uri: z.string().trim().min(1),
    mediaType: z.string().trim().min(1).optional(),
    objectiveId: UuidSchema.optional(),
    missionId: UuidSchema.optional(),
    sourceId: UuidSchema.optional(),
    hostId: z.string().trim().min(1).optional(),
    checksum: z.string().trim().min(1).optional(),
    provenanceVersion: SchemaVersionSchema,
    provenance: z.unknown(),
    createdAt: UtcTimestampSchema,
  })
  .strict();

export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
