import type { LiveBriefPayload, MediaPayload, SurfaceSize } from "@noctis/contracts";
import {
  ApprovalPayloadSchema,
  ArtifactPayloadSchema,
  AttentionPayloadSchema,
  ConversationPayloadSchema,
  DetailPayloadSchema,
  DocumentPayloadSchema,
  EvidencePayloadSchema,
  ExternalToolFocusPayloadSchema,
  ListPayloadSchema,
  LiveBriefPayloadSchema,
  MediaPayloadSchema,
  NativeFocusPayloadSchema,
  SourceStatePayloadSchema,
  TimelinePayloadSchema,
  VerificationPayloadSchema,
  VaultRecallPayloadSchema,
} from "@noctis/contracts";
import type { z } from "zod";

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
 *
 * The payload schemas live in `@noctis/contracts` (surface-payloads.ts) so the
 * core can validate a runtime's proposal against the same shape this renders.
 */

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
  document: {
    payloadVersion: 1,
    schema: DocumentPayloadSchema,
    sizes: ALL_SIZES,
    title: "Document",
  },
  timeline: {
    payloadVersion: 1,
    schema: TimelinePayloadSchema,
    sizes: ALL_SIZES,
    title: "Timeline",
  },
  verification: {
    payloadVersion: 1,
    schema: VerificationPayloadSchema,
    sizes: ALL_SIZES,
    title: "Verification",
  },
  media: {
    payloadVersion: 1,
    schema: MediaPayloadSchema,
    sizes: ALL_SIZES,
    title: "Media",
  },
  live_brief: {
    payloadVersion: 1,
    schema: LiveBriefPayloadSchema,
    sizes: ALL_SIZES,
    title: "Live brief",
  },
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
  external_tool: {
    payloadVersion: 1,
    schema: ExternalToolFocusPayloadSchema,
    // Never compact. The chosen route, what it degraded from, and the state are
    // three lines that all have to be readable at once — and the one that would
    // be dropped first is "in your own signed-in browser", which is the line
    // somebody most needs to see before agreeing.
    sizes: ["standard", "wide", "stage"],
    title: "External tool",
    /**
     * Reaching a tool is a consequence, so a caller without `tool.inspect` sees
     * the fallback rather than a Surface whose buttons the shell would refuse.
     *
     * `tool.inspect` rather than a stronger capability, because that is what the
     * *Surface* needs: it renders what the survey found. Which route may
     * actually be taken is decided per route by the router and per act by the
     * core, neither of which this gate can stand in for.
     */
    requires: "tool.inspect",
    /**
     * A payload describing which programs are installed is a snapshot, and it
     * goes stale the moment somebody installs one. Phase 9 learned this the
     * expensive way with a Surface reporting an editor as closed while it sat
     * open on the next display.
     */
    sourceRefresh: true,
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

  return {
    status: "ok",
    kind: kind as SurfaceKind,
    title:
      kind === "media" ||
      kind === "live_brief" ||
      kind === "document" ||
      kind === "timeline" ||
      kind === "verification"
        ? (parsed.data as MediaPayload | LiveBriefPayload).title
        : entry.title,
    payload: parsed.data,
  };
}
