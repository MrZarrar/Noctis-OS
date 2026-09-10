import type {
  OperationClass,
  RouteAvailability,
  RouteName,
  ToolCapability,
  ToolDescriptor,
  ToolVerb,
} from "@noctis/contracts";
import { ROUTE_CAPABILITY, ROUTE_NAMES, TOOL_CAPABILITY_OPERATION_CLASS } from "@noctis/contracts";

/**
 * Section 12.3's route decision, as one pure total function.
 *
 * Deterministic code owns routing (AGENTS.md). A model may propose which tool
 * and what for; which route that becomes is decided here, from declared facts
 * only — what the descriptor offers, what the machine can reach, and what a
 * capability covers.
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
 * inspects cannot talk its way below the floor, because a descriptor that could
 * understate its own consequence would make the whole table advisory.
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
  descriptor: ToolDescriptor;
  /** The capabilities the caller holds. Not an authority decision — an eligibility filter. */
  granted: ReadonlySet<ToolCapability>;
  /**
   * What the shell said it can reach, by route. A route absent from this map is
   * unknown, and unknown is treated as unreachable: the router fails closed, so
   * a shell that failed to report cannot cause a route to be attempted blind.
   */
  availability: Partial<Readonly<Record<RouteName, RouteAvailability>>>;
  /** Which verb the caller wants, when the route has verbs. */
  verbId?: string;
}

export interface RouteChoice {
  route: RouteName;
  capability: ToolCapability;
  /** The class to ask authority for: the capability's floor raised by the verb. */
  operationClass: OperationClass;
  /** Routes that were declared but passed over, in order, with why. */
  degradedFrom: RouteName[];
  reasons: string[];
  verb?: ToolVerb;
  /**
   * The caller asked for a verb the chosen route does not declare. Reported
   * rather than silently ignored: running "the default" because a verb id did
   * not match is how a caller ends up publishing when it meant to draft.
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

  for (const route of ROUTE_NAMES) {
    const declared = input.descriptor.routes.find((candidate) => candidate.route === route);
    const capability = ROUTE_CAPABILITY[route];

    // The terminal fallback. It needs no declaration — a descriptor's
    // `instructions` are always present — and no grant beyond inspection, which
    // is what makes it unconditional.
    if (route === "manual") {
      const verb = findVerb(declared, input.verbId);

      return {
        route,
        capability,
        operationClass: raisedOperationClass(capability, verb?.operationClass),
        degradedFrom,
        reasons,
        ...(verb === undefined ? {} : { verb }),
      };
    }

    if (declared === undefined) {
      // Not degradation: a route the tool never offered was never on the table,
      // so it is not something a person needs told about.
      continue;
    }

    const availability = input.availability[route];

    if (availability === undefined || !availability.available) {
      degradedFrom.push(route);
      reasons.push(
        `${route}: ${availability === undefined ? "the shell did not report this route" : availability.reason}`,
      );
      continue;
    }

    if (!input.granted.has(capability)) {
      degradedFrom.push(route);
      reasons.push(`${route}: ${capability} is not granted`);
      continue;
    }

    const verb = findVerb(declared, input.verbId);
    const unknownVerb = input.verbId !== undefined && verb === undefined && hasVerbs(declared);

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

  // Unreachable: `manual` is in `ROUTE_NAMES` and returns unconditionally. It is
  // here so that removing it from the list fails loudly rather than falling out
  // of the loop with nothing.
  throw new Error("route list contained no terminal fallback");
}

function hasVerbs(route: ToolDescriptor["routes"][number] | undefined): boolean {
  return route !== undefined && route.route === "official_cli";
}

function findVerb(
  route: ToolDescriptor["routes"][number] | undefined,
  verbId: string | undefined,
): ToolVerb | undefined {
  if (route === undefined || verbId === undefined || route.route !== "official_cli") {
    return undefined;
  }

  return route.verbs.find((verb) => verb.id === verbId);
}
