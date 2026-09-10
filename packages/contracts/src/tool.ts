import { z } from "zod";

import type { OperationClassSchema } from "./enums.js";
import { OperationClassSchema as OperationClass } from "./enums.js";
import { AuthorityOutcomeSchema } from "./authority.js";
import { UtcTimestampSchema } from "./primitives.js";

/* -------------------------------------------------------------------------- */
/* Phase 10: browser and specialist-tool orchestration.                       */
/* -------------------------------------------------------------------------- */

/**
 * Section 12.3's four integration routes, strongest first.
 *
 * The order is load-bearing, not presentational: `chooseRoute` walks this list
 * and takes the first route a tool declares, the environment can reach, and a
 * capability covers. `manual` is last and can never be unavailable, which is
 * what makes "failure degrades safely" a property of the list rather than a
 * branch somebody remembered to write.
 */
export const ROUTE_NAMES = [
  "official_cli",
  "isolated_browser",
  "visible_handoff",
  "manual",
] as const;

export const RouteNameSchema = z.enum(ROUTE_NAMES);

export type RouteName = z.infer<typeof RouteNameSchema>;

/**
 * Every capability the tool router may ask authority for.
 *
 * Separate from `WINDOW_CAPABILITIES` and from `NODE_CAPABILITIES` for the same
 * reason those two are separate from each other: a grant to arrange a window is
 * not a grant to start a process, and a list that merged them could not express
 * the difference.
 */
export const TOOL_CAPABILITIES = [
  "tool.inspect",
  "tool.launch",
  "tool.run_command",
  "browser.open_visible",
  "browser.automate_isolated",
  "browser.control_profile",
  "tool.register_descriptor",
] as const;

export const ToolCapabilitySchema = z.enum(TOOL_CAPABILITIES);

export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

/**
 * The consequence class of each tool capability, fixed here rather than supplied
 * by the caller — the same rule as `WINDOW_CAPABILITY_OPERATION_CLASS`, and for
 * the same reason: the capability is the thing with consequences.
 *
 * Three of these deserve their reasoning written down.
 *
 * `browser.open_visible` is `local_reversible_edit` because opening a tab in
 * somebody's own browser is not a write to anything — it is the handoff itself.
 * Under an active Objective that means no prompt, which is the behaviour a
 * person asking Noctis to "open the listing form" wants; a confirmation to open
 * a tab is a confirmation nobody reads.
 *
 * `browser.control_profile` is `external_write` because driving a signed-in
 * profile acts *as* the person. Section 12.3 requires it be separately granted
 * from isolated automation, and a different operation class is what makes that
 * separation real rather than a flag: the two cannot be covered by one grant,
 * because `covers` in `evaluate.ts` compares the class as well as the name.
 *
 * `tool.run_command` is a *floor*. A verb declares its own class, and
 * `raisedOperationClass` takes the stricter of the two — a descriptor may say a
 * command publishes or spends, and may never say it merely inspects.
 */
export const TOOL_CAPABILITY_OPERATION_CLASS = {
  "tool.inspect": "read_inspect",
  "tool.launch": "local_reversible_edit",
  "tool.run_command": "external_write",
  "browser.open_visible": "local_reversible_edit",
  "browser.automate_isolated": "local_reversible_edit",
  /**
   * Writing a descriptor names an executable and an origin allowlist, so it
   * widens what Noctis may reach. Section 9.1 puts `credential_security` beyond
   * every standing permission and beyond a model, and choosing it here is what
   * makes `evaluate.ts` enforce both without a line of new policy.
   */
  "browser.control_profile": "external_write",
  "tool.register_descriptor": "credential_security",
} as const satisfies Record<ToolCapability, z.infer<typeof OperationClassSchema>>;

/**
 * Which capability each route spends. A total table over the route union, so a
 * new route cannot be added without deciding what authorises it.
 */
export const ROUTE_CAPABILITY = {
  official_cli: "tool.run_command",
  isolated_browser: "browser.automate_isolated",
  visible_handoff: "browser.open_visible",
  /**
   * Rendering instructions reaches nothing, so it spends nothing. It is still
   * named here rather than left out, because a table with a hole is the shape
   * that hid three Phase 9 defects — and `tool.inspect` is the honest answer:
   * the manual route reports what it knows and touches nothing.
   */
  manual: "tool.inspect",
} as const satisfies Record<RouteName, ToolCapability>;

/**
 * The `AuthorityTarget.type` every tool request carries. The `id` beside it is a
 * `ToolDescriptor.id`, so a standing permission binds to one tool rather than to
 * "browsers" or "commands".
 *
 * Binding to the tool and not to the browser profile is the deliberate choice.
 * A grant over `{ type: "browser_profile", id: "default" }` would read "drive my
 * signed-in browser", which is a grant over somebody's whole signed-in life. A
 * grant over `{ type: "tool", id: "vinted" }` reads "drive my signed-in browser
 * on Vinted", and the descriptor's origin allowlist is what makes that narrow
 * reading true rather than nominal.
 */
export const TOOL_TARGET_TYPE = "tool";

/** No shell metacharacter may appear in a declared argument. */
const SAFE_ARGUMENT = /^[^&|;`$<>\n\r]*$/u;

/**
 * One thing a tool can be asked to do, and what it costs.
 *
 * `operationClass` sits on the verb rather than the route because the
 * consequence of running a command is a property of the command. `gh pr list`
 * and `gh pr merge` travel the same route and are not the same act.
 */
export const ToolVerbSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(200),
    /**
     * The complete argument list, declared. A caller sends a verb id and never
     * an argument, so there is no string for a model to extend — which is the
     * same rule `PlaceIntent` enforces by having nowhere to put a coordinate.
     */
    args: z.array(z.string().max(512).regex(SAFE_ARGUMENT)).max(32),
    operationClass: OperationClass,
  })
  .strict();

const HttpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) => {
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: "must be an http or https URL" },
  );

const OriginSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (value) => {
      try {
        const url = new URL(value);

        return ["http:", "https:"].includes(url.protocol) && url.origin === value;
      } catch {
        return false;
      }
    },
    { message: "must be a bare http or https origin" },
  );

/**
 * What a tool offers, one entry per route.
 *
 * A discriminated union rather than a bag of optional fields, so a route and the
 * facts it needs arrive together: a handoff cannot exist without an origin
 * allowlist and a CLI route cannot exist without an executable. The executor
 * therefore never asks "and what if this is missing", which is precisely where
 * an unconstrained URL would get in.
 */
export const ToolRouteSchema = z.discriminatedUnion("route", [
  z
    .object({
      route: z.literal("official_cli"),
      /** A command name or an absolute path. Resolved and pinned by the shell. */
      executable: z.string().trim().min(1).max(512),
      verbs: z.array(ToolVerbSchema).min(1).max(32),
      /**
       * Start it and leave it running, rather than run it and read its output.
       * The launch case — an editor, an emulator — which is what writes the
       * launch correlation Phase 9 left plumbed and unwritten.
       */
      detached: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      route: z.literal("isolated_browser"),
      url: HttpUrlSchema,
      origins: z.array(OriginSchema).min(1).max(16),
    })
    .strict(),
  z
    .object({
      route: z.literal("visible_handoff"),
      url: HttpUrlSchema,
      /**
       * Every origin this tool may reach in the person's own browser. The
       * executor refuses a URL outside it, which is what makes a per-tool grant
       * narrow in fact.
       */
      origins: z.array(OriginSchema).min(1).max(16),
    })
    .strict(),
  z
    .object({
      route: z.literal("manual"),
      steps: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    })
    .strict(),
]);

export type ToolRoute = z.infer<typeof ToolRouteSchema>;

/**
 * One tool, as data.
 *
 * Nothing in Phase 10 knows what Suno or Vinted is: a tool is a row, and adding
 * one is an edit to a file rather than a change to code. That is the whole test
 * of whether the router is general — if Phase 11 has to write an adapter, it
 * was not.
 */
export const ToolDescriptorSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/u),
    displayName: z.string().trim().min(1).max(200),
    /**
     * What to do by hand. Always present, because `manual` is the terminal
     * fallback and a fallback with nothing to say is not a fallback.
     */
    instructions: z.string().trim().min(1).max(2000),
    routes: z.array(ToolRouteSchema).max(4),
  })
  .strict()
  .superRefine((descriptor, ctx) => {
    const seen = new Set<RouteName>();

    for (const route of descriptor.routes) {
      if (seen.has(route.route)) {
        ctx.addIssue({
          code: "custom",
          message: `${route.route} is declared more than once`,
          path: ["routes"],
        });
      }

      seen.add(route.route);

      // A URL its own allowlist would refuse is a contradiction the executor
      // would hit every single time. Caught once, here, rather than at each
      // execution: a descriptor is written once and run many times.
      if (route.route === "visible_handoff" || route.route === "isolated_browser") {
        if (!route.origins.includes(new URL(route.url).origin)) {
          ctx.addIssue({
            code: "custom",
            message: `${route.url} is not covered by this route's origins`,
            path: ["routes"],
          });
        }
      }
    }
  });

export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

/**
 * What the page asks for: a tool and a verb.
 *
 * Not `.strict()`, deliberately, and the test says why. Stripping unknown keys
 * means a caller that tries to smuggle a `url`, an `executable`, or an `args`
 * array has them dropped rather than rejected — the request still works, and the
 * smuggled field simply never exists. Rejection would be equally safe; silently
 * having nowhere to put one is what makes the descriptor the allowlist rather
 * than advice.
 */
export const ToolIntentSchema = z.object({
  toolId: z.string().trim().min(1).max(64),
  verbId: z.string().trim().min(1).max(64),
  /**
   * The Objective this is part of. The core allows a reversible local edit
   * without asking while an Objective is active and decides that by looking the
   * Objective up, so a request naming none is one it treats as unscoped. Phase 9
   * shipped without this field and made the whole allow path unreachable.
   */
  objectiveId: z.string().trim().min(1).max(128).optional(),
});

export type ToolIntent = z.infer<typeof ToolIntentSchema>;

/**
 * Whether a route can actually be taken on this machine right now, as the shell
 * reports it. A reason, never a bare `false`: "not installed" and "not built
 * yet" send a person to different places.
 */
export const RouteAvailabilitySchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true) }).strict(),
  z.object({ available: z.literal(false), reason: z.string().min(1).max(300) }).strict(),
]);

export type RouteAvailability = z.infer<typeof RouteAvailabilitySchema>;

/**
 * Which session a route acted in. The field the isolation grant exists to ask
 * about, so evidence may not omit it.
 */
export const SessionKindSchema = z.enum(["none", "isolated_profile", "existing_profile"]);

/**
 * Phase 10: "Record source identity, host, session, and verification evidence."
 *
 * All four are required. Evidence that could omit which session it used cannot
 * answer the one question the separation between `browser.control_profile` and
 * `browser.automate_isolated` exists to ask.
 */
export const ToolRouteExecutionEvidenceSchema = z
  .object({
    toolId: z.string().trim().min(1).max(64),
    route: RouteNameSchema,
    capability: ToolCapabilitySchema,
    hostId: z.string().trim().min(1).max(128),
    sessionKind: SessionKindSchema,
    startedAt: UtcTimestampSchema,
    elapsedMs: z.int().nonnegative(),
    detail: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("launched"),
          processId: z.int().nonnegative(),
          /**
           * The id a placement can later match a window against. This is what
           * finally writes the correlation map Phase 9 left plumbed and empty,
           * and it is why launching belongs with tool routing rather than with
           * window placement.
           */
          launchCorrelationId: z.string().trim().min(1).max(128),
        })
        .strict(),
      z
        .object({
          kind: z.literal("ran"),
          exitCode: z.int(),
          /** Bounded, and never the whole of stdout: Section 9.2 forbids unbounded bodies in logs. */
          output: z.string().max(4000),
        })
        .strict(),
      z.object({ kind: z.literal("opened"), url: HttpUrlSchema }).strict(),
      z.object({ kind: z.literal("instructed") }).strict(),
    ]),
  })
  .strict();

export type ToolRouteExecutionEvidence = z.infer<typeof ToolRouteExecutionEvidenceSchema>;

/**
 * What Noctis currently knows about one external tool.
 *
 * The variant names match the shell's `ToolOutcome` on the wire, so the bridge
 * passes an outcome through rather than translating it — a translation layer
 * between two enums is where the two drift apart.
 */
export const ExternalToolStateSchema = z.discriminatedUnion("kind", [
  /** Nothing has been asked yet. The state a route action is offered from. */
  z.object({ kind: z.literal("ready") }).strict(),
  z
    .object({
      kind: z.literal("launched"),
      processId: z.int().nonnegative(),
      launchCorrelationId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ran"),
      exitCode: z.int(),
      output: z.string().max(4000),
    })
    .strict(),
  /**
   * Opened in the person's own browser. Section 9.1's preparation boundary: the
   * form is on screen and Noctis stopped there.
   */
  z.object({ kind: z.literal("handedOff"), url: HttpUrlSchema }).strict(),
  /** The terminal fallback. Always reachable, which is what makes degradation safe. */
  z
    .object({
      kind: z.literal("instructions"),
      steps: z.array(z.string().min(1).max(500)).min(1).max(20),
    })
    .strict(),
  /** The consequence boundary. The Surface renders it; it does not cross it. */
  z
    .object({
      kind: z.literal("needsApproval"),
      requestId: z.string().min(1).max(128),
      outcome: AuthorityOutcomeSchema,
      consequenceSummary: z.string().min(1).max(2000),
      /** `.nullish()`, not `.optional()`: Rust serialises `Option::None` as `null`. */
      confirmationPhrase: z.string().min(1).max(200).nullish(),
    })
    .strict(),
  /**
   * The route was chosen and cannot run here. Distinct from `refused`, because
   * this one is about the machine rather than about permission — and a person
   * reading "no isolated browser is built yet" needs a different next step from
   * one reading "authority denied it".
   */
  z
    .object({
      kind: z.literal("routeUnavailable"),
      route: RouteNameSchema,
      reason: z.string().min(1).max(300),
    })
    .strict(),
  z.object({ kind: z.literal("refused"), reason: z.string().min(1).max(500) }).strict(),
]);

export type ExternalToolState = z.infer<typeof ExternalToolStateSchema>;

/** One tool in the `external_tool` Surface. */
export const ExternalToolPayloadSchema = z
  .object({
    toolId: z.string().trim().min(1).max(64),
    displayName: z.string().trim().min(1).max(200),
    /** The route the router chose, so the Surface can say how Noctis intends to get there. */
    route: RouteNameSchema,
    /** Why that route and not a stronger one. Empty when the strongest was available. */
    degradedFrom: z.array(RouteNameSchema).max(4),
    verbs: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) }).strict()).max(32),
    state: ExternalToolStateSchema,
  })
  .strict();

/**
 * The `external_tool` Surface payload: every specialist tool this piece of work
 * uses, in one Surface.
 *
 * One Surface rather than one per tool, for the reason Phase 9 found the hard
 * way: a surface intent's identity is `(objectiveId, kind, sourceIds)`, so two
 * intents of the same kind with the same sources are the same intent and the
 * second upsert overwrites the first.
 */
export const ExternalToolFocusPayloadSchema = z
  .object({
    tools: z.array(ExternalToolPayloadSchema).min(1).max(8),
  })
  .strict();

export type ExternalToolPayload = z.infer<typeof ExternalToolPayloadSchema>;
export type ExternalToolFocusPayload = z.infer<typeof ExternalToolFocusPayloadSchema>;
export type ToolVerb = z.infer<typeof ToolVerbSchema>;
export type SessionKind = z.infer<typeof SessionKindSchema>;
