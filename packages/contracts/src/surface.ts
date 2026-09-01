import { z } from "zod";

import { SurfaceLifecycleSchema, SurfacePersistenceSchema, SurfaceRoleSchema } from "./enums.js";
import { SchemaVersionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

export const SurfaceSizeSchema = z.enum(["compact", "standard", "wide", "stage"]);
export const SurfaceRegionSchema = z.enum(["left", "centre", "right", "bottom", "overlay"]);

export const SurfaceIntentSchema = z
  .object({
    id: UuidSchema,
    objectiveId: UuidSchema,
    kind: z.string().trim().min(1),
    role: SurfaceRoleSchema,
    persistence: SurfacePersistenceSchema,
    lifecycle: SurfaceLifecycleSchema,
    priority: z.int(),
    minSize: SurfaceSizeSchema,
    preferredRegion: SurfaceRegionSchema.optional(),
    sourceIds: z.array(UuidSchema),
    artifactIds: z.array(UuidSchema),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    requestedAt: UtcTimestampSchema,
  })
  .strict();

export const SurfaceOverrideSchema = z
  .object({
    id: UuidSchema,
    surfaceId: UuidSchema,
    clientId: z.string().trim().min(1),
    displayFingerprint: z.string().trim().min(1),
    region: SurfaceRegionSchema,
    size: SurfaceSizeSchema,
    createdAt: UtcTimestampSchema,
    releasedAt: UtcTimestampSchema.optional(),
  })
  .strict();

export const CompositionPlanSchema = z
  .object({
    objectiveId: UuidSchema,
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
  .strict();

export type SurfaceSize = z.infer<typeof SurfaceSizeSchema>;
export type SurfaceRegion = z.infer<typeof SurfaceRegionSchema>;
export type SurfaceIntent = z.infer<typeof SurfaceIntentSchema>;
export type SurfaceOverride = z.infer<typeof SurfaceOverrideSchema>;
export type CompositionPlan = z.infer<typeof CompositionPlanSchema>;
