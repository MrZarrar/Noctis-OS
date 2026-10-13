import { z } from "zod";

import { SurfaceLifecycleSchema, SurfacePersistenceSchema, SurfaceRoleSchema } from "./enums.js";
import { SchemaVersionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

/** Stored entity IDs are v7; deterministic file source identities are v8. */
export const SurfaceSourceIdSchema = z.union([UuidSchema, z.uuid({ version: "v8" })]);

export const SurfaceOwnerSchema = z
  .object({
    objectiveId: UuidSchema.optional(),
    threadId: UuidSchema.optional(),
    presence: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.objectiveId, value.threadId, value.presence].filter((field) => field !== undefined)
        .length === 1,
    { message: "exactly one of objectiveId, threadId and presence" },
  );
export type SurfaceOwner =
  | { objectiveId: string; threadId?: never; presence?: never }
  | { threadId: string; objectiveId?: never; presence?: never }
  | { presence: true; objectiveId?: never; threadId?: never };
export function ownerIdOf(value: {
  objectiveId?: string | undefined;
  threadId?: string | undefined;
  presence?: boolean | undefined;
}): string {
  const owner = SurfaceOwnerSchema.parse({
    objectiveId: value.objectiveId,
    threadId: value.threadId,
    presence: value.presence,
  });
  if (owner.objectiveId !== undefined) return "objective:" + owner.objectiveId;
  if (owner.threadId !== undefined) return "thread:" + owner.threadId;
  return "presence";
}

export const SurfaceSizeSchema = z.enum(["compact", "standard", "wide", "stage"]);
export const SurfaceRegionSchema = z.enum(["left", "centre", "right", "bottom", "overlay"]);
export const SurfacePlacementRegionSchema = z.enum([...SurfaceRegionSchema.options, "overflow"]);

/**
 * The whole of what composition may know about a display: which one, and how
 * wide. There is deliberately no rectangle, origin, or device pixel ratio here
 * — a field that could carry geometry is a field a model could eventually fill,
 * and Section 5.4 forbids that outright.
 */
export const SurfaceDisplaySchema = z
  .object({
    fingerprint: z.string().trim().min(1).max(200),
    widthPx: z.int().positive().max(100_000),
  })
  .strict();

export const SurfaceIntentSchema = z
  .object({
    id: UuidSchema,
    ...SurfaceOwnerSchema.shape,
    kind: z.string().trim().min(1),
    role: SurfaceRoleSchema,
    persistence: SurfacePersistenceSchema,
    lifecycle: SurfaceLifecycleSchema,
    priority: z.int(),
    minSize: SurfaceSizeSchema,
    preferredRegion: SurfaceRegionSchema.optional(),
    sourceIds: z.array(SurfaceSourceIdSchema),
    artifactIds: z.array(UuidSchema),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    requestedAt: UtcTimestampSchema,
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

export const SurfaceOverrideSchema = z
  .object({
    id: UuidSchema,
    surfaceId: UuidSchema,
    clientId: z.string().trim().min(1),
    displayFingerprint: z.string().trim().min(1),
    region: SurfacePlacementRegionSchema,
    size: SurfaceSizeSchema,
    order: z.int().nonnegative().optional(),
    createdAt: UtcTimestampSchema,
    releasedAt: UtcTimestampSchema.optional(),
  })
  .strict();

export const CompositionPlanSchema = z
  .object({
    ...SurfaceOwnerSchema.shape,
    layoutId: z.string().trim().min(1),
    displayFingerprint: z.string().trim().min(1),
    slots: z.array(
      z
        .object({
          surfaceId: UuidSchema,
          region: SurfaceRegionSchema,
          order: z.int().nonnegative(),
          size: SurfaceSizeSchema,
          layer: z.int().nonnegative(),
        })
        .strict(),
    ),
    overflowSurfaceIds: z.array(UuidSchema),
    reasonCodes: z.array(z.string().trim().min(1)),
    generatedAt: UtcTimestampSchema,
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

export type SurfaceSize = z.infer<typeof SurfaceSizeSchema>;
export type SurfaceRegion = z.infer<typeof SurfaceRegionSchema>;
export type SurfacePlacementRegion = z.infer<typeof SurfacePlacementRegionSchema>;
export type SurfaceDisplay = z.infer<typeof SurfaceDisplaySchema>;
export type SurfaceIntent = z.infer<typeof SurfaceIntentSchema>;
export type SurfaceOverride = z.infer<typeof SurfaceOverrideSchema>;
export type CompositionPlan = z.infer<typeof CompositionPlanSchema>;
