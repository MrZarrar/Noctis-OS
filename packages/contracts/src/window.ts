import { z } from "zod";

import type { OperationClassSchema } from "./enums.js";
import { AuthorityOutcomeSchema } from "./authority.js";

/* -------------------------------------------------------------------------- */
/* Phase 9: native window orchestration.                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every capability the native window adapter may be asked for.
 *
 * These are deliberately *not* `NODE_CAPABILITIES`. A node capability runs in a
 * worker process; these run in the desktop shell, which is the only process
 * holding a Win32 message loop. The two lists staying separate is what stops a
 * node grant from reaching a window and vice versa.
 */
export const WINDOW_CAPABILITIES = ["window.discover", "window.place", "window.restore"] as const;

export const WindowCapabilitySchema = z.enum(WINDOW_CAPABILITIES);

export type WindowCapability = z.infer<typeof WindowCapabilitySchema>;

/**
 * The consequence class of each window capability, fixed here rather than
 * supplied by the caller, for the same reason `CAPABILITY_OPERATION_CLASS`
 * exists: the capability is the thing with consequences.
 *
 * `local_reversible_edit` rather than `external_write` is the honest reading.
 * Moving a window writes to no external system, and the previous
 * `WINDOWPLACEMENT` is captured before the move, so the operation is genuinely
 * reversible. It matters which one is chosen: `local_reversible_edit` is
 * eligible for a narrow standing permission and `external_write` is too, but
 * overstating the class would make focus mode demand a typed confirmation to
 * tidy an editor, and a confirmation nobody believes is a confirmation nobody
 * reads.
 */
export const WINDOW_CAPABILITY_OPERATION_CLASS = {
  "window.discover": "read_inspect",
  "window.place": "local_reversible_edit",
  "window.restore": "local_reversible_edit",
} as const satisfies Record<WindowCapability, z.infer<typeof OperationClassSchema>>;

/**
 * The `AuthorityTarget.type` every window request carries. The `id` beside it is
 * an `ApplicationTarget.id` — `vscode` — so a standing permission binds to one
 * application rather than to "windows".
 */
export const WINDOW_TARGET_TYPE = "window";

/**
 * Which display a region belongs to. A role, never an index: Win32 promises no
 * stable enumeration order, so an index is a coordinate wearing a disguise.
 */
export const MonitorRoleSchema = z.enum(["primary", "secondary"]);

/**
 * A horizontal band of a display's work area, always full height.
 *
 * The wire spelling matches the Rust enum in `crates/noctis-windows`, which is
 * the authority on what these mean. `left_two_thirds` and `right_third` share a
 * boundary exactly, so the pair tiles a display with no seam.
 */
export const RegionNameSchema = z.enum([
  "full",
  "left_half",
  "right_half",
  "left_two_thirds",
  "right_third",
]);

/** A window rectangle in virtual-screen physical pixels. */
export const PlacementSchema = z
  .object({
    // Signed, and never clamped to zero: a display to the left of the primary
    // has a negative x, and so does every window on it.
    x: z.int(),
    y: z.int(),
    width: z.int().positive(),
    height: z.int().positive(),
    maximized: z.boolean(),
  })
  .strict();

/**
 * A semantic placement request. It names a region and a display role; it cannot
 * name pixels, so a caller that should not be trusted with coordinates does not
 * have to be.
 */
export const WindowPlacementRequestSchema = z
  .object({
    /** An `ApplicationTarget.id`, the same string the authority target carries. */
    applicationId: z.string().trim().min(1).max(64),
    monitor: MonitorRoleSchema,
    region: RegionNameSchema,
  })
  .strict();

/**
 * Why the resolved rectangle is not simply the region that was asked for.
 *
 * Rendered rather than logged: a window that ends up somewhere unexpected with
 * no stated reason is what makes a user stop trusting focus mode.
 */
export const ResolutionNoteSchema = z.enum([
  "degraded_to_primary",
  "honoured_user_override",
  "clamped_to_work_area",
  "raised_to_minimum_size",
]);

export const WindowResolutionSchema = z
  .object({
    placement: PlacementSchema,
    monitorId: z.string().trim().min(1).max(128),
    notes: z.array(ResolutionNoteSchema),
  })
  .strict();

/**
 * One top-level window as Win32 described it.
 *
 * `handle` is the `HWND` as an opaque integer. It stays a JSON number because
 * Windows documents 64-bit handle values as significant in their low 32 bits for
 * interop purposes, so it cannot reach the range where a double loses precision.
 *
 * `executablePath` is nullable because reading it needs a handle to the owning
 * process and a higher-integrity process refuses. Absent is a weaker identity,
 * never a wildcard.
 */
export const WindowIdentitySchema = z
  .object({
    handle: z.int().nonnegative(),
    processId: z.int().nonnegative(),
    executablePath: z.string().min(1).max(1024).nullable(),
    className: z.string().max(256),
    title: z.string().max(1024),
    launchCorrelationId: z.string().trim().min(1).max(128).nullable(),
  })
  .strict();

/** Which identity signals lined up. Never a score — see the Rust crate. */
export const MatchEvidenceSchema = z
  .object({
    launchCorrelated: z.boolean(),
    executableMatched: z.boolean(),
    classMatched: z.boolean(),
    titleMatched: z.boolean(),
  })
  .strict();

/**
 * Why a window will not be touched. `protected` is the shell or the secure
 * desktop; `not_granted` is everything the grant list does not identify.
 */
export const WindowRefusalSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("protected"), detail: z.string().min(1).max(256) }).strict(),
  z.object({ reason: z.literal("not_granted") }).strict(),
]);

/**
 * What a completed placement records as the authority decision's execution
 * evidence.
 *
 * `previous` is the `WINDOWPLACEMENT` captured before the move. It is what makes
 * `window.place` honestly reversible, and therefore what justifies its operation
 * class — an evidence record without it would be a claim rather than a proof.
 */
export const WindowPlacementEvidenceSchema = z
  .object({
    applicationId: z.string().trim().min(1).max(64),
    handle: z.int().nonnegative(),
    identity: WindowIdentitySchema,
    match: MatchEvidenceSchema,
    previous: PlacementSchema,
    applied: PlacementSchema,
    monitorId: z.string().trim().min(1).max(128),
    notes: z.array(ResolutionNoteSchema),
    /** Wall-clock milliseconds the Win32 call took, for the timeout evidence. */
    elapsedMs: z.int().nonnegative(),
  })
  .strict();

/**
 * What Noctis currently knows about one native application it may arrange.
 *
 * The variant names match the desktop shell's `PlaceOutcome` on the wire, so the
 * bridge passes an outcome through almost verbatim rather than translating it —
 * a translation layer between two enums is where the two drift apart.
 *
 * `discovered` is the one the shell does not produce, because discovery is a
 * separate command from placement: it means "found, not yet placed", which is
 * the state a Place action is offered from.
 */
export const NativeApplicationStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("notRunning") }).strict(),
  z
    .object({
      kind: z.literal("discovered"),
      windowTitle: z.string().max(1024),
      handle: z.int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("placed"),
      monitorId: z.string().min(1).max(128),
      placement: PlacementSchema,
      /**
       * Where the window was before Noctis moved it. Carried so the Surface can
       * offer to put it back and say what "back" means — and because a placement
       * that cannot name its own previous state is not demonstrably reversible.
       */
      previous: PlacementSchema,
      notes: z.array(ResolutionNoteSchema),
      elapsedMs: z.int().nonnegative(),
      /** The approval that authorised this move, so the record is traceable. */
      requestId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("restored"),
      placement: PlacementSchema,
      applicationId: z.string().trim().min(1).max(64),
    })
    .strict(),
  /**
   * More than one window matched, and the candidates are carried so a person can
   * choose. Never resolved by picking the first: `EnumWindows` promises no order.
   */
  z
    .object({
      kind: z.literal("ambiguous"),
      candidates: z
        .array(z.object({ handle: z.int().nonnegative(), title: z.string().max(1024) }).strict())
        .min(2)
        .max(32),
    })
    .strict(),
  /** The consequence boundary. The Surface renders it; it does not cross it. */
  z
    .object({
      kind: z.literal("needsApproval"),
      requestId: z.string().min(1).max(128),
      outcome: AuthorityOutcomeSchema,
      consequenceSummary: z.string().min(1).max(2000),
      /**
       * `nullish`, not `optional`. Rust serializes `Option::None` as `null`, and
       * `optional` means "absent or a string" — so a decision that needs no
       * typed phrase failed to parse and surfaced as a raw zod error in the
       * Surface. Tolerating both is the right posture for a parser reading
       * another process's output.
       */
      confirmationPhrase: z.string().min(1).max(200).nullish(),
    })
    .strict(),
  /**
   * Section 11.2's degrade. Covers a window Windows would not move, an
   * application that is not responding, a display arrangement with nowhere to
   * put it, and a browser with no desktop shell behind it — all of which are
   * "Noctis cannot do this, and here is why" rather than a silent no-op.
   */
  z.object({ kind: z.literal("refused"), reason: z.string().min(1).max(500) }).strict(),
]);

/**
 * The `native_application` Surface payload.
 *
 * It carries the *intended* region beside the current state, because a Surface
 * showing only where a window is cannot say where it was meant to be — and the
 * gap between those two is exactly what a person needs to see when placement
 * degraded.
 */
export const NativeApplicationPayloadSchema = z
  .object({
    applicationId: z.string().trim().min(1).max(64),
    displayName: z.string().trim().min(1).max(200),
    intendedMonitor: MonitorRoleSchema,
    intendedRegion: RegionNameSchema,
    state: NativeApplicationStateSchema,
  })
  .strict();

/**
 * The `native_application` Surface payload: every native tool this piece of work
 * uses, in one Surface.
 *
 * One Surface rather than one per application, because a surface intent's
 * identity is `(objectiveId, kind, sourceIds)` — two intents of the same kind
 * with the same sources are the same intent, and the second upsert would
 * overwrite the first. It is also the better reading: "the tools for this work"
 * is one thing a person looks at, not one frame per executable.
 */
export const NativeFocusPayloadSchema = z
  .object({
    applications: z.array(NativeApplicationPayloadSchema).min(1).max(8),
  })
  .strict();

export type NativeApplicationState = z.infer<typeof NativeApplicationStateSchema>;
export type NativeApplicationPayload = z.infer<typeof NativeApplicationPayloadSchema>;
export type NativeFocusPayload = z.infer<typeof NativeFocusPayloadSchema>;
export type MonitorRole = z.infer<typeof MonitorRoleSchema>;
export type RegionName = z.infer<typeof RegionNameSchema>;
export type Placement = z.infer<typeof PlacementSchema>;
export type WindowPlacementRequest = z.infer<typeof WindowPlacementRequestSchema>;
export type ResolutionNote = z.infer<typeof ResolutionNoteSchema>;
export type WindowResolution = z.infer<typeof WindowResolutionSchema>;
export type WindowIdentity = z.infer<typeof WindowIdentitySchema>;
export type MatchEvidence = z.infer<typeof MatchEvidenceSchema>;
export type WindowRefusal = z.infer<typeof WindowRefusalSchema>;
export type WindowPlacementEvidence = z.infer<typeof WindowPlacementEvidenceSchema>;
