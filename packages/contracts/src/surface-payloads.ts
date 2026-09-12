import { z } from "zod";

import { ExternalToolFocusPayloadSchema } from "./tool.js";
import { NativeFocusPayloadSchema } from "./window.js";

/**
 * The payload each Surface kind must satisfy. Moved here from the web registry
 * so the core can validate a runtime's surface proposal against the same
 * schema the renderer will apply, rather than trusting the model's shape.
 */

const MessageSchema = z
  .object({ id: z.string().min(1), author: z.string().min(1), text: z.string() })
  .strict();

export const ConversationPayloadSchema = z.object({ messages: z.array(MessageSchema) }).strict();

export const ListPayloadSchema = z
  .object({
    items: z.array(
      z
        .object({ id: z.string().min(1), label: z.string().min(1), detail: z.string().optional() })
        .strict(),
    ),
  })
  .strict();

export const DetailPayloadSchema = z
  .object({
    fields: z.array(z.object({ label: z.string().min(1), value: z.string() }).strict()),
  })
  .strict();

const FreshnessSchema = z.enum(["current", "stale", "unavailable", "unknown"]);

export const EvidencePayloadSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().min(1),
          claim: z.string().min(1),
          source: z.string().min(1),
          status: FreshnessSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const AttentionPayloadSchema = z
  .object({ headline: z.string().min(1), detail: z.string() })
  .strict();

export const ApprovalPayloadSchema = z
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
    declinedAt: z.string().min(1).optional(),
  })
  .strict();

export const ArtifactPayloadSchema = z
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

export const SourceStatePayloadSchema = z
  .object({
    /** Carried so the refresh action has something to name. */
    sourceId: z.string().min(1),
    sourceType: z.string().min(1),
    externalId: z.string().min(1),
    status: FreshnessSchema,
    ageSeconds: z.number().nonnegative().optional(),
    conflicted: z.boolean(),
    observed: z.string().optional(),
    remembered: z.string().optional(),
  })
  .strict();

/** Section 7's focused recall, as a Surface payload. */
export const VaultRecallPayloadSchema = z
  .object({
    query: z.string().min(1),
    freshness: FreshnessSchema,
    evidence: z.array(
      z
        .object({
          itemId: z.string().min(1),
          entityId: z.string().min(1),
          path: z.string().min(1),
          quote: z.string(),
          freshness: FreshnessSchema,
        })
        .strict(),
    ),
  })
  .strict();

/** Keyed by Surface kind. The web registry adds sizes, titles and gates on top. */
export const SURFACE_PAYLOAD_SCHEMAS: Record<
  string,
  { payloadVersion: number; schema: z.ZodType }
> = {
  conversation: { payloadVersion: 1, schema: ConversationPayloadSchema },
  list: { payloadVersion: 1, schema: ListPayloadSchema },
  detail: { payloadVersion: 1, schema: DetailPayloadSchema },
  evidence: { payloadVersion: 1, schema: EvidencePayloadSchema },
  attention: { payloadVersion: 1, schema: AttentionPayloadSchema },
  approval: { payloadVersion: 1, schema: ApprovalPayloadSchema },
  artifact: { payloadVersion: 1, schema: ArtifactPayloadSchema },
  source_state: { payloadVersion: 1, schema: SourceStatePayloadSchema },
  vault_recall: { payloadVersion: 1, schema: VaultRecallPayloadSchema },
  native_application: { payloadVersion: 1, schema: NativeFocusPayloadSchema },
  external_tool: { payloadVersion: 1, schema: ExternalToolFocusPayloadSchema },
};
