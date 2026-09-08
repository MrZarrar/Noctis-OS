import type { SurfaceSize } from "@noctis/contracts";
import { NativeFocusPayloadSchema } from "@noctis/contracts";
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
 * `requires` and `sourceRefresh` are the two fields Section 5.3 lists that
 * earlier phases left out because nothing could enforce them. Phase 8 built
 * both halves, so they are here now: `requires` names the capability a Surface
 * needs, and `resolveSurface` refuses to render one whose capability the caller
 * does not hold — a `requires` array nothing checked would be worse than none.
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

const ApprovalPayloadSchema = z
  .object({
    id: z.string().min(1),
    consequenceSummary: z.string().min(1),
    operationClass: z.string().min(1),
    capability: z.string().min(1),
    targetType: z.string().min(1),
    targetId: z.string().min(1),
    reversibility: z.enum(["reversible", "partially_reversible", "irreversible"]),
    outcome: z.enum(["allow", "deny", "require_confirmation", "require_typed_confirmation"]),
    reasonCodes: z.array(z.string().min(1)),
    estimatedCostGbp: z.number().nonnegative().optional(),
    confirmationPhrase: z.string().min(1).optional(),
    confirmedAt: z.string().min(1).optional(),
    executedAt: z.string().min(1).optional(),
  })
  .strict();

const ArtifactPayloadSchema = z
  .object({
    kind: z.enum(["local_artifact", "external_reference"]),
    title: z.string().min(1),
    uri: z.string().min(1),
    mediaType: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
    checksum: z.string().min(1).optional(),
    derivedFromArtifactId: z.string().min(1).optional(),
    importedAs: z.string().min(1).optional(),
  })
  .strict();

const SourceStatePayloadSchema = z
  .object({
    /** Carried so the refresh action has something to name. */
    sourceId: z.string().min(1),
    sourceType: z.string().min(1),
    externalId: z.string().min(1),
    status: z.enum(["current", "stale", "unavailable", "unknown"]),
    ageSeconds: z.number().nonnegative().optional(),
    conflicted: z.boolean(),
    observed: z.string().optional(),
    remembered: z.string().optional(),
  })
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
  /**
   * The capability a caller must hold to see this Surface at all. Section 5.3.
   * Absent means the Surface carries nothing the authority model gates —
   * which is a claim about the payload, not a shortcut.
   */
  requires?: string;
  /** Whether the workbench should offer this Surface a "check the source now" action. */
  sourceRefresh?: boolean;
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
  approval: {
    payloadVersion: 1,
    schema: ApprovalPayloadSchema,
    // Never compact. This is the screen where an irreversible thing is agreed
    // to, and a Surface too small to show the target is a Surface that gets
    // approved without being read.
    sizes: ["standard", "wide", "stage"],
    title: "Needs your approval",
    requires: "authority.approve",
  },
  artifact: {
    payloadVersion: 1,
    schema: ArtifactPayloadSchema,
    sizes: ALL_SIZES,
    title: "Artifact",
  },
  native_application: {
    payloadVersion: 1,
    schema: NativeFocusPayloadSchema,
    // Never compact. The intended region, the current state, and the reason
    // they differ are three lines that all have to be readable at once, and a
    // Surface that dropped the reason would be the one that gets distrusted.
    sizes: ["standard", "wide", "stage"],
    title: "Native application",
    /**
     * Placing another application's window is a consequence, so a caller
     * without `window.place` sees the fallback rather than a Surface whose
     * buttons would be refused by the shell anyway.
     */
    requires: "window.place",
  },
  source_state: {
    payloadVersion: 1,
    schema: SourceStatePayloadSchema,
    sizes: ALL_SIZES,
    title: "Source",
    /**
     * Section 5.3's "optional source refresh action". It is a handoff the
     * workbench provides, not something the Surface may do for itself: a
     * refresh reaches an external system, and reaching one is authority's to
     * decide, not a renderer's.
     */
    sourceRefresh: true,
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
  capabilities: readonly string[] = [],
): Resolved {
  if (!Object.hasOwn(REGISTRY, kind)) {
    return { status: "fallback", kind, reason: "no renderer is registered for this kind" };
  }

  const entry: SurfaceRegistryEntry = REGISTRY[kind as SurfaceKind];

  if (entry.requires !== undefined && !capabilities.includes(entry.requires)) {
    // A fallback rather than nothing: a Surface the caller may not see is a
    // fact about the caller, and hiding it silently makes a missing grant look
    // like a missing feature.
    return {
      status: "fallback",
      kind,
      reason: `this Surface requires the ${entry.requires} capability`,
    };
  }

  if (payloadVersion !== entry.payloadVersion) {
    return {
      status: "fallback",
      kind,
      reason: `payload version ${String(payloadVersion)} is not version ${String(entry.payloadVersion)}`,
    };
  }

  if (!entry.sizes.includes(size)) {
    return { status: "fallback", kind, reason: `this Surface does not support the ${size} size` };
  }

  const parsed = entry.schema.safeParse(payload);

  if (!parsed.success) {
    return { status: "fallback", kind, reason: "the payload did not match its schema" };
  }

  return { status: "ok", kind: kind as SurfaceKind, title: entry.title, payload: parsed.data };
}
