import type {
  OperationClass,
  RouteAvailability,
  RouteName,
  ToolCapability,
  ToolVerb,
} from "@noctis/contracts";
import { ROUTE_CAPABILITY, ROUTE_NAMES, TOOL_CAPABILITY_OPERATION_CLASS } from "@noctis/contracts";

/**
 * Section 12.3's route decision, as one pure total function.
 *
 * Deterministic code owns routing (AGENTS.md). A model may propose which tool
 * and what for; which route that becomes is decided here, from declared facts
 * only — what the tool offers, what the machine can reach, and what a capability
 * covers.
 */

/**
 * The answer for a route whose executor Phase 10 deliberately did not build.
 *
 * A named constant rather than a string at each call site, because it is the
 * sentence a person reads when isolated automation is skipped, and it should say
 * "not built" rather than "unavailable" — the two send somebody to different
 * places.
 */
export const UNAVAILABLE_UNBUILT: RouteAvailability = {
  available: false,
  reason: "Noctis has no executor for this route yet, so it was passed over.",
};

/**
 * What the shell reports about one tool: which routes it declares, and which
 * verbs it has.
 *
 * Deliberately not the `ToolDescriptor`. Executable paths, URLs, and origin
 * allowlists stay in the shell, because a page that held them is a page that can
 * disagree with the allowlist rather than merely name a tool in it. That is
 * Phase 9's `window_survey` lesson a layer up: report per target, never hand
 * over the grant list.
 */
export interface ToolSummary {
  toolId: string;
  declaredRoutes: readonly RouteName[];
  /** Only `official_cli` has verbs, so an empty list is the ordinary case. */
  verbs: readonly ToolVerb[];
}

/**
 * Severity, strictest last. Total over `OperationClass`, and a `Record` so a
 * class added to the enum without a rank fails to compile rather than comparing
 * as equal to everything and silently understating a consequence.
 */
const SEVERITY: Readonly<Record<OperationClass, number>> = {
  read_inspect: 0,
  local_reversible_edit: 1,
  external_write: 2,
  message_send: 3,
  publish: 4,
  spend: 5,
  destructive: 6,
  production_deploy: 7,
  credential_security: 8,
};

/**
 * The class of one act: the capability's floor, raised by the verb, never
 * lowered by it.
 *
 * Section 9.1's commit boundary lives here. A descriptor may declare that a
 * command publishes or spends, and the request that goes to authority carries
 * that stricter class — but a descriptor claiming a `tool.run_command` merely
 * inspects cannot talk its way below the floor. Reaching an external tool with a
 * command is an external act even when the command reads, and a floor that could
 * be argued down would make the whole table advisory.
 */
export function raisedOperationClass(
  capability: ToolCapability,
  verbClass: OperationClass | undefined,
): OperationClass {
  const floor = TOOL_CAPABILITY_OPERATION_CLASS[capability];

  if (verbClass === undefined) {
    return floor;
  }

  return SEVERITY[verbClass] > SEVERITY[floor] ? verbClass : floor;
}

export interface RouteChoiceInput {
  summary: ToolSummary;
  /** The capabilities the caller holds. Not an authority decision — an eligibility filter. */
  granted: ReadonlySet<ToolCapability>;
  /**
   * What the shell said it can reach, by route. A route absent from this map is
   * unknown, and unknown is treated as unreachable: the router fails closed, so
   * a shell that failed to report cannot cause a route to be attempted blind.
   */
  availability: Partial<Readonly<Record<RouteName, RouteAvailability>>>;
  /** Which verb the caller wants, when the chosen route has verbs. */
  verbId?: string;
}

export interface RouteChoice {
  route: RouteName;
  capability: ToolCapability;
  /** The class to ask authority for: the capability's floor, raised by the verb. */
  operationClass: OperationClass;
  /** Routes that were declared and passed over, in the order they were tried. */
  degradedFrom: RouteName[];
  /** One sentence per degradation, so a Surface can say why rather than only that. */
  reasons: string[];
  verb?: ToolVerb;
  /**
   * The caller asked for a verb this tool does not declare. Reported rather than
   * silently ignored: running "the default" because a verb id did not match is
   * how a caller ends up publishing when it meant to draft.
   */
  unknownVerb?: boolean;
}

/**
 * Choose the strongest route a tool declares, this machine can reach, and a
 * capability covers.
 *
 * Total by construction: `manual` is last in `ROUTE_NAMES`, needs nothing
 * declared, and cannot be unavailable, so the walk always terminates on an
 * answer. "Failure degrades safely" is therefore a property of the list rather
 * than a branch somebody remembered to write — which is the difference that cost
 * Phase 9 three defects of the same shape.
 */
export function chooseRoute(input: RouteChoiceInput): RouteChoice {
  const degradedFrom: RouteName[] = [];
  const reasons: string[] = [];
  const verb = input.summary.verbs.find((candidate) => candidate.id === input.verbId);
  const unknownVerb = input.verbId !== undefined && verb === undefined;

  for (const route of ROUTE_NAMES) {
    const capability = ROUTE_CAPABILITY[route];

    // The terminal fallback. It needs no declaration — a descriptor's
    // `instructions` are always present — and no grant beyond inspection, which
    // is what makes it unconditional and the walk total.
    if (route === "manual") {
      return choice(route, capability, verb, degradedFrom, reasons, unknownVerb);
    }

    if (!input.summary.declaredRoutes.includes(route)) {
      // Not a degradation: a route the tool never offered was never on the
      // table, so it is not something a person needs told about.
      continue;
    }

    const availability = input.availability[route];

    if (availability === undefined || !availability.available) {
      degradedFrom.push(route);
      reasons.push(
        `${route}: ${
          availability === undefined ? "the shell did not report this route" : availability.reason
        }`,
      );
      continue;
    }

    if (!input.granted.has(capability)) {
      degradedFrom.push(route);
      reasons.push(`${route}: ${capability} is not granted`);
      continue;
    }

    return choice(route, capability, verb, degradedFrom, reasons, unknownVerb);
  }

  // Unreachable: `manual` is in `ROUTE_NAMES` and returns unconditionally. It is
  // here so that removing it from the list fails loudly rather than falling out
  // of the loop with nothing.
  throw new Error("route list contained no terminal fallback");
}

function choice(
  route: RouteName,
  capability: ToolCapability,
  verb: ToolVerb | undefined,
  degradedFrom: RouteName[],
  reasons: string[],
  unknownVerb: boolean,
): RouteChoice {
  return {
    route,
    capability,
    operationClass: raisedOperationClass(capability, verb?.operationClass),
    degradedFrom,
    reasons,
    ...(verb === undefined ? {} : { verb }),
    ...(unknownVerb ? { unknownVerb: true } : {}),
  };
}
