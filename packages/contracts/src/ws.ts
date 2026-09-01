import { z } from "zod";

import { OrchestrationEventSchema } from "./events.js";

/** Bumping this is a breaking protocol change; unknown versions fail closed. */
export const ENVELOPE_VERSION = 1;

const EnvelopeVersionSchema = z.literal(ENVELOPE_VERSION);

export const ClientFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("subscribe"),
      envelopeVersion: EnvelopeVersionSchema,
      afterSequence: z.int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("acknowledge"),
      envelopeVersion: EnvelopeVersionSchema,
      sequence: z.int().positive(),
    })
    .strict(),
]);

export const ServerFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("event"),
      envelopeVersion: EnvelopeVersionSchema,
      event: OrchestrationEventSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("gap"),
      envelopeVersion: EnvelopeVersionSchema,
      fromSequence: z.int().nonnegative(),
      toSequence: z.int().positive(),
    })
    .strict(),
]);

export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
