import type { SurfaceSize } from "@noctis/contracts";
import { z } from "zod";

/**
 * The Surface registry (Section 5.3).
 *
 * A `kind` is a string on the wire, so every entry declares the schema its
 * payload must satisfy and nothing renders until the payload has passed it. An
 * adapter may compose these primitives; it may not add a `kind` that skips this
 * table, because `resolveSurface` is the only way the workbench turns a kind
 * into something renderable.
 *
 * Two fields Section 5.3 lists are deliberately absent until the phase that can
 * enforce them: capability/authority requirements (Phase 8 owns the authority
 * model — a `requires` array nothing checks would be false comfort) and the
 * optional source refresh action (Phase 7 owns sources). Both are additive.
 */

const MessageSchema = z
  .object({ id: z.string().min(1), author: z.string().min(1), text: z.string() })
  .strict();

const ConversationPayloadSchema = z.object({ messages: z.array(MessageSchema) }).strict();

const ListPayloadSchema = z
  .object({
    items: z.array(
      z
        .object({ id: z.string().min(1), label: z.string().min(1), detail: z.string().optional() })
        .strict(),
    ),
  })
  .strict();

const DetailPayloadSchema = z
  .object({
    fields: z.array(z.object({ label: z.string().min(1), value: z.string() }).strict()),
  })
  .strict();

const EvidencePayloadSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().min(1),
          claim: z.string().min(1),
          source: z.string().min(1),
          status: z.enum(["current", "stale", "unavailable", "unknown"]),
        })
        .strict(),
    ),
  })
  .strict();

const AttentionPayloadSchema = z
  .object({ headline: z.string().min(1), detail: z.string() })
  .strict();

/** Section 7's focused recall, as a Surface payload. */
const VaultRecallPayloadSchema = z
  .object({
    query: z.string().min(1),
    freshness: z.enum(["current", "stale", "unavailable", "unknown"]),
    evidence: z.array(
      z
        .object({
          itemId: z.string().min(1),
          entityId: z.string().min(1),
          path: z.string().min(1),
          quote: z.string(),
          freshness: z.enum(["current", "stale", "unavailable", "unknown"]),
        })
        .strict(),
    ),
  })
  .strict();

export type SurfaceKind = keyof typeof REGISTRY;

export interface SurfaceRegistryEntry {
  /** Bumped when a payload shape changes; persisted intents carry their own. */
  payloadVersion: number;
  schema: z.ZodType;
  sizes: readonly SurfaceSize[];
  /** The accessible name for the Surface's frame, derived from its payload. */
  title: string;
}

const ALL_SIZES: readonly SurfaceSize[] = ["compact", "standard", "wide", "stage"];

export const REGISTRY = {
  conversation: {
    payloadVersion: 1,
    schema: ConversationPayloadSchema,
    sizes: ["standard", "wide", "stage"],
    title: "Conversation",
  },
  list: {
    payloadVersion: 1,
    schema: ListPayloadSchema,
    sizes: ALL_SIZES,
    title: "Choices",
  },
  detail: {
    payloadVersion: 1,
    schema: DetailPayloadSchema,
    sizes: ALL_SIZES,
    title: "Detail",
  },
  evidence: {
    payloadVersion: 1,
    schema: EvidencePayloadSchema,
    sizes: ["standard", "wide", "stage"],
    title: "Evidence",
  },
  attention: {
    payloadVersion: 1,
    schema: AttentionPayloadSchema,
    sizes: ["compact", "standard"],
    title: "Needs attention",
  },
  vault_recall: {
    payloadVersion: 1,
    schema: VaultRecallPayloadSchema,
    sizes: ["compact", "standard", "wide", "stage"],
    title: "From the Vault",
  },
} as const satisfies Record<string, SurfaceRegistryEntry>;

export type Resolved =
  | { status: "ok"; kind: SurfaceKind; title: string; payload: unknown }
  | { status: "fallback"; kind: string; reason: string };

/**
 * The single gate between a stored intent and a rendered Surface.
 *
 * Every refusal returns a fallback rather than throwing: one Surface whose
 * payload drifted from its schema must not take the whole composition down
 * with it, which is the difference between a degraded canvas and a blank one.
 */
export function resolveSurface(
  kind: string,
  payloadVersion: number,
  payload: unknown,
  size: SurfaceSize,
): Resolved {
  if (!Object.hasOwn(REGISTRY, kind)) {
    return { status: "fallback", kind, reason: "no renderer is registered for this kind" };
  }

  const entry = REGISTRY[kind as SurfaceKind];

  if (payloadVersion !== entry.payloadVersion) {
    return {
      status: "fallback",
      kind,
      reason: `payload version ${String(payloadVersion)} is not version ${String(entry.payloadVersion)}`,
    };
  }

  if (!(entry.sizes as readonly SurfaceSize[]).includes(size)) {
    return { status: "fallback", kind, reason: `this Surface does not support the ${size} size` };
  }

  const parsed = entry.schema.safeParse(payload);

  if (!parsed.success) {
    return { status: "fallback", kind, reason: "the payload did not match its schema" };
  }

  return { status: "ok", kind: kind as SurfaceKind, title: entry.title, payload: parsed.data };
}
