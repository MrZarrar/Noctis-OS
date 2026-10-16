import { z } from "zod";
import { UtcTimestampSchema, UuidSchema } from "./primitives.js";

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

/** Choice actions are messages, never executable commands or navigation. */
export const PanelActionSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(4000),
  })
  .strict();
const PanelActionsSchema = z.array(PanelActionSchema).max(8).optional();
export type PanelAction = z.infer<typeof PanelActionSchema>;

export const ListPayloadSchema = z
  .object({
    actions: PanelActionsSchema,
    items: z.array(
      z
        .object({ id: z.string().min(1), label: z.string().min(1), detail: z.string().optional() })
        .strict(),
    ),
  })
  .strict();

export const DetailPayloadSchema = z
  .object({
    actions: PanelActionsSchema,
    fields: z.array(z.object({ label: z.string().min(1), value: z.string() }).strict()),
  })
  .strict();

const FreshnessSchema = z.enum(["current", "stale", "unavailable", "unknown"]);

export const EvidencePayloadSchema = z
  .object({
    actions: PanelActionsSchema,
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
  .object({ headline: z.string().min(1), detail: z.string(), actions: PanelActionsSchema })
  .strict();

export const FileSourceSchema = z
  .object({
    from: z.literal("file"),
    nodeId: z.string().min(1).max(64),
    grantId: z.string().min(1).max(64),
    relativePath: z
      .string()
      .min(1)
      .max(1024)
      .refine((path) => !path.split(/[\\/]/).includes(".."), "no parent segments"),
  })
  .strict();

export const PAGE_PANEL_PAGES = [
  "Reminders",
  "To-dos",
  "Notes",
  "Health",
  "Files",
  "Vault",
  "Approvals",
  "Nodes",
  "Missions",
  "Artifacts",
  "Settings",
] as const;
export const PagePanelPayloadSchema = z
  .object({
    page: z.enum(PAGE_PANEL_PAGES),
    folder: FileSourceSchema.omit({ from: true })
      .extend({
        relativePath: z
          .string()
          .max(1024)
          .refine((path) => !path.split(/[\\/]/).includes(".."), "no parent segments"),
      })
      .strict()
      .optional(),
    focusId: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (payload) =>
      (payload.folder === undefined || payload.page === "Files") &&
      (payload.focusId === undefined || payload.page === "Vault"),
  );
export type PagePanelPayload = z.infer<typeof PagePanelPayloadSchema>;

export const MediaPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    mediaType: z.string().trim().min(1).max(128),
    source: z.discriminatedUnion("from", [
      z.object({ from: z.literal("attachment"), attachmentId: UuidSchema }).strict(),
      FileSourceSchema,
    ]),
  })
  .strict();

export const DocumentPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    format: z.enum(["markdown", "text"]),
    content: z.discriminatedUnion("from", [
      z.object({ from: z.literal("inline"), text: z.string().max(50_000) }).strict(),
      FileSourceSchema,
    ]),
    actions: PanelActionsSchema,
  })
  .strict();

/**
 * A file an agent shows by the path it is at: a page it built (visual), a
 * README it edited (document), a screenshot (media). The core finds the shared
 * folder that holds it, so the agent never names a node or a grant, and the
 * file's text never travels through the tool call.
 */
export const PathPanelProposalSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1).max(1024),
    actions: PanelActionsSchema,
  })
  .strict();

/** An interactive page, run sandboxed with no network, from a file in a shared folder. */
export const VisualPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    source: FileSourceSchema,
    actions: PanelActionsSchema,
  })
  .strict();

export type VisualPayload = z.infer<typeof VisualPayloadSchema>;
export type PathPanelProposal = z.infer<typeof PathPanelProposalSchema>;

export const TimelinePayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            start: z.string().max(32).optional(),
            end: z.string().max(32).optional(),
            label: z.string().min(1).max(200),
            detail: z.string().max(400).optional(),
            due: z.boolean().optional(),
          })
          .strict(),
      )
      .max(50),
    actions: PanelActionsSchema,
  })
  .strict();

export const VerificationPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            claim: z.string().min(1).max(300),
            status: z.enum(["verified", "partial", "required", "blocked"]),
            reason: z.string().max(120).optional(),
          })
          .strict(),
      )
      .max(50),
    actions: PanelActionsSchema,
  })
  .strict();

export type DocumentPayload = z.infer<typeof DocumentPayloadSchema>;
export type TimelinePayload = z.infer<typeof TimelinePayloadSchema>;
export type VerificationPayload = z.infer<typeof VerificationPayloadSchema>;

export const PANEL_PROPOSABLE_KINDS: ReadonlySet<string> = new Set([
  "document",
  "timeline",
  "verification",
  "list",
  "detail",
  "evidence",
  "attention",
  "visual",
  "media",
]);

/** What an agent is doing right now. Built by the core from the job, so it never carries the prompt. */
export const LiveBriefPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(64),
    runtime: z.string().trim().min(1).max(128),
    activity: z.string().trim().min(1).max(200),
    status: z.enum(["starting", "running"]),
    startedAt: UtcTimestampSchema,
  })
  .strict();

export type MediaPayload = z.infer<typeof MediaPayloadSchema>;
export type LiveBriefPayload = z.infer<typeof LiveBriefPayloadSchema>;
export type MediaSource = MediaPayload["source"];

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
  page: { payloadVersion: 1, schema: PagePanelPayloadSchema },
  conversation: { payloadVersion: 1, schema: ConversationPayloadSchema },
  document: { payloadVersion: 1, schema: DocumentPayloadSchema },
  timeline: { payloadVersion: 1, schema: TimelinePayloadSchema },
  verification: { payloadVersion: 1, schema: VerificationPayloadSchema },
  list: { payloadVersion: 1, schema: ListPayloadSchema },
  detail: { payloadVersion: 1, schema: DetailPayloadSchema },
  evidence: { payloadVersion: 1, schema: EvidencePayloadSchema },
  attention: { payloadVersion: 1, schema: AttentionPayloadSchema },
  media: { payloadVersion: 1, schema: MediaPayloadSchema },
  visual: { payloadVersion: 1, schema: VisualPayloadSchema },
  live_brief: { payloadVersion: 1, schema: LiveBriefPayloadSchema },
  approval: { payloadVersion: 1, schema: ApprovalPayloadSchema },
  artifact: { payloadVersion: 1, schema: ArtifactPayloadSchema },
  source_state: { payloadVersion: 1, schema: SourceStatePayloadSchema },
  vault_recall: { payloadVersion: 1, schema: VaultRecallPayloadSchema },
  native_application: { payloadVersion: 1, schema: NativeFocusPayloadSchema },
  external_tool: { payloadVersion: 1, schema: ExternalToolFocusPayloadSchema },
};
