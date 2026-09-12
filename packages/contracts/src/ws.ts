import { z } from "zod";

import { OrchestrationEventSchema } from "./events.js";
import { UuidSchema } from "./primitives.js";

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
  /** A token delta. Ephemeral: no sequence, never replayed, never in the event log. */
  z
    .object({
      kind: z.literal("runtime_delta"),
      envelopeVersion: EnvelopeVersionSchema,
      threadId: UuidSchema,
      jobId: UuidSchema,
      itemId: z.string().trim().min(1).max(128),
      text: z.string().min(1).max(2000),
    })
    .strict(),
]);

export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
