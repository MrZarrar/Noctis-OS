import { z } from "zod";

import { SchemaVersionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

/**
 * Section 12.2: "An external reference is not a local artifact."
 *
 * A selected Suno song, a Vinted draft, a GitHub PR, a browser tab, or a remote
 * document stays an `external_reference` until an explicit import produces a
 * `local_artifact` with a host, a path, and a checksum. The two kinds are one
 * table because the import has to be able to point back at what it came from,
 * and one row that changed kind in place would erase that lineage.
 */
export const ArtifactKindSchema = z.enum(["local_artifact", "external_reference"]);

export const ArtifactRecordSchema = z
  .object({
    id: UuidSchema,
    kind: ArtifactKindSchema,
    title: z.string().trim().min(1),
    uri: z.string().trim().min(1),
    mediaType: z.string().trim().min(1).optional(),
    objectiveId: UuidSchema.optional(),
    missionId: UuidSchema.optional(),
    sourceId: UuidSchema.optional(),
    /** Which machine holds the bytes. A local artifact without one is not local anywhere. */
    hostId: z.string().trim().min(1).optional(),
    checksum: z.string().trim().min(1).optional(),
    /** Lineage: the artifact this one was imported or derived from. */
    derivedFromArtifactId: UuidSchema.optional(),
    provenanceVersion: SchemaVersionSchema,
    provenance: z.unknown(),
    createdAt: UtcTimestampSchema,
  })
  .strict()
  // Enforced at the boundary rather than in a service, so no code path can
  // record a "local" artifact that names no host and no bytes.
  .refine(
    (artifact) =>
      artifact.kind !== "local_artifact" ||
      (artifact.hostId !== undefined && artifact.checksum !== undefined),
    {
      message: "a local_artifact must name the host that holds it and the checksum of its bytes",
      path: ["checksum"],
    },
  );

export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
