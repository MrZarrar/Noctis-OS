import { z } from "zod";
import { UtcTimestampSchema, UuidSchema } from "./primitives.js";

const TimeZone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "valid time zone");
export const TriggerSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("at"), at: UtcTimestampSchema }).strict(),
    z
      .object({
        kind: z.literal("repeat"),
        rule: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("weekly"),
              daysOfWeek: z
                .array(z.int().min(0).max(6))
                .min(1)
                .max(7)
                .refine((days) => new Set(days).size === days.length),
              timeOfDay: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
              timeZone: TimeZone,
            })
            .strict(),
          z.object({ kind: z.literal("interval"), hours: z.number().min(1).max(8760) }).strict(),
        ]),
      })
      .strict(),
    z
      .object({ kind: z.literal("at_pc"), nodeId: UuidSchema, repeat: z.boolean().default(false) })
      .strict(),
  ])
  .nullable();
export type Trigger = z.infer<typeof TriggerSchema>;
