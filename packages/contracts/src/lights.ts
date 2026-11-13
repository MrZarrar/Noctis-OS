import { z } from "zod";

import { IdempotencyKeySchema, UuidSchema } from "./primitives.js";

/**
 * The owner's smart lights, driven by the PC that can reach them: Tuya (Smart
 * Life) through Tuya's cloud and Tapo bulbs over the home network. The node's
 * lights.json lists them; the logins stay encrypted on that PC and never cross
 * the wire.
 */

export const LIGHTS_CAPABILITIES = ["lights.state", "lights.set"] as const;

export const LightNameSchema = z.string().trim().min(1).max(64);
export const LightKindSchema = z.enum(["tuya", "tapo"]);

const Percent = z.int().min(1).max(100);
const Hue = z.int().min(0).max(360);
const Saturation = z.int().min(0).max(100);
const Kelvin = z.int().min(2500).max(6500);

export const LightChangeSchema = z
  .object({
    light: LightNameSchema,
    on: z.boolean().optional(),
    brightness: Percent.optional(),
    colorTempK: Kelvin.optional(),
    hue: Hue.optional(),
    saturation: Saturation.optional(),
  })
  .strict()
  .refine(
    (c) =>
      c.on !== undefined ||
      c.brightness !== undefined ||
      c.colorTempK !== undefined ||
      c.hue !== undefined,
    { message: "a change must change something" },
  )
  .refine((c) => (c.hue === undefined) === (c.saturation === undefined), {
    message: "hue and saturation go together",
  })
  .refine((c) => c.hue === undefined || c.colorTempK === undefined, {
    message: "a colour or a white temperature, not both",
  });
export type LightChange = z.infer<typeof LightChangeSchema>;

export const SceneNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{0,31}$/);

export const LightStateSchema = z
  .object({
    name: LightNameSchema,
    kind: LightKindSchema,
    online: z.boolean(),
    on: z.boolean().optional(),
    brightness: Percent.optional(),
    mode: z.enum(["white", "colour"]).optional(),
    colorTempK: Kelvin.optional(),
    hue: Hue.optional(),
    saturation: Saturation.optional(),
    /** Why this light could not be read or changed; the others still answer. */
    error: z.string().max(300).optional(),
  })
  .strict();
export type LightState = z.infer<typeof LightStateSchema>;

export const LightsStatePayloadSchema = z.object({}).strict();
export const LightsSetPayloadSchema = z.union([
  z.object({ changes: z.array(LightChangeSchema).min(1).max(16) }).strict(),
  z.object({ scene: SceneNameSchema }).strict(),
]);
export type LightsSetPayload = z.infer<typeof LightsSetPayloadSchema>;

/** Both jobs answer with every light as it is afterwards, and the scenes there are. */
export const LightsEvidenceSchema = z
  .object({
    lights: z.array(LightStateSchema).max(32),
    scenes: z.array(SceneNameSchema).max(16),
  })
  .strict();
export type LightsEvidence = z.infer<typeof LightsEvidenceSchema>;

/** `~/.noctis/lights.json` on the node. Strict, so a password put here is refused, not carried. */
export const LightsConfigSchema = z
  .object({
    tuyaEndpoint: z.url().default("https://openapi.tuyaeu.com"),
    lights: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              name: LightNameSchema,
              kind: z.literal("tuya"),
              id: z.string().min(1).max(64),
            })
            .strict(),
          z
            .object({
              name: LightNameSchema,
              kind: z.literal("tapo"),
              host: z.string().min(1).max(253),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(32),
    scenes: z.record(SceneNameSchema, z.array(LightChangeSchema).min(1).max(16)).default({}),
    /** Whether agents on this PC may use the lights tool. Off unless the owner turns it on. */
    agents: z.boolean().default(false),
    /** The DPAPI-protected logins (PowerShell Export-Clixml). Defaults under %LOCALAPPDATA%\noctis-secrets. */
    secrets: z
      .object({ tuya: z.string().min(1), tapo: z.string().min(1) })
      .partial()
      .strict()
      .default({}),
  })
  .strict();
export type LightsConfig = z.infer<typeof LightsConfigSchema>;

/* ---- the core API ---- */

export const LightsStatusSchema = z
  .object({
    granted: z.boolean(),
    nodeId: UuidSchema.nullable(),
    nodeOnline: z.boolean(),
    /** Present when the PC answered. */
    lights: LightsEvidenceSchema.optional(),
    error: z.string().max(300).optional(),
  })
  .strict();
export type LightsStatus = z.infer<typeof LightsStatusSchema>;

export const LightsSetCommandSchema = z.union([
  z
    .object({
      idempotencyKey: IdempotencyKeySchema,
      changes: z.array(LightChangeSchema).min(1).max(16),
    })
    .strict(),
  z.object({ idempotencyKey: IdempotencyKeySchema, scene: SceneNameSchema }).strict(),
]);
export type LightsSetCommand = z.infer<typeof LightsSetCommandSchema>;

export const AllowLightsCommandSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema, nodeId: UuidSchema })
  .strict();
export type AllowLightsCommand = z.infer<typeof AllowLightsCommandSchema>;
