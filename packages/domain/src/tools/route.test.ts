import type { RouteName, ToolVerb } from "@noctis/contracts";
import { ROUTE_CAPABILITY, ROUTE_NAMES } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import type { ToolSummary } from "./route.js";
import { UNAVAILABLE_UNBUILT, chooseRoute, raisedOperationClass } from "./route.js";

const VERBS: readonly ToolVerb[] = [
  {
    id: "draft",
    label: "Draft a listing",
    args: ["draft"],
    operationClass: "local_reversible_edit",
  },
  { id: "publish", label: "Publish", args: ["publish"], operationClass: "publish" },
];

const everything: ToolSummary = {
  toolId: "vinted",
  declaredRoutes: ["official_cli", "isolated_browser", "visible_handoff", "manual"],
  verbs: VERBS,
};

const allGranted = new Set(Object.values(ROUTE_CAPABILITY));

/**
 * Every route reachable. Spelled out per test where a route is meant to be
 * unreachable, because a route missing from the map is unreachable too — so a
 * partial fixture makes a test pass for a reason it is not testing.
 */
const reachable = {
  official_cli: { available: true as const },
  isolated_browser: { available: true as const },
  visible_handoff: { available: true as const },
};

describe("chooseRoute", () => {
  /**
   * THE GATE: `manual` is the terminal fallback, so a tool that declares nothing
   * and is granted nothing still gets an answer. A router that could return "no
   * route" would make every caller invent its own degradation.
   */
  it("always finds a route, even for a tool that declares none", () => {
    const bare: ToolSummary = { toolId: "unknown", declaredRoutes: [], verbs: [] };

    expect(chooseRoute({ summary: bare, granted: new Set(), availability: {} })).toMatchObject({
      route: "manual",
      capability: "tool.inspect",
    });
  });

  it("prefers the strongest route the tool declares, the machine reaches, and a grant covers", () => {
    const chosen = chooseRoute({
      summary: everything,
      granted: allGranted,
      availability: reachable,
    });

    expect(chosen.route).toBe("official_cli");
    expect(chosen.degradedFrom).toEqual([]);
  });

  /**
   * The isolated-browser executor is not built, so the router must skip it
   * rather than choose it and fail. Availability is consulted *before* authority
   * for exactly this reason: a grant must never be spent on a route that cannot
   * run.
   */
  it("skips a route the machine cannot reach and says which it passed over", () => {
    const chosen = chooseRoute({
      summary: everything,
      granted: allGranted,
      availability: {
        ...reachable,
        official_cli: { available: false, reason: "vinted-cli is not installed" },
        isolated_browser: UNAVAILABLE_UNBUILT,
      },
    });

    expect(chosen.route).toBe("visible_handoff");
    expect(chosen.degradedFrom).toEqual(["official_cli", "isolated_browser"]);
    expect(chosen.reasons[0]).toContain("vinted-cli is not installed");
  });

  /**
   * THE GATE: Section 12.3 wants existing-profile use separately granted.
   * Without the grant the router degrades past it rather than asking authority
   * and being refused — a router that routes to a capability nobody holds turns
   * every session into a prompt.
   */
  it("degrades past a route whose capability is not granted", () => {
    const withoutHandoff = new Set(allGranted);
    withoutHandoff.delete("browser.open_visible");

    // Reachable, and still passed over. If the fixture left it unreported it
    // would degrade for the wrong reason and this test would prove nothing.
    const chosen = chooseRoute({
      summary: everything,
      granted: withoutHandoff,
      availability: {
        ...reachable,
        official_cli: { available: false, reason: "not installed" },
        isolated_browser: UNAVAILABLE_UNBUILT,
      },
    });

    expect(chosen.route).toBe("manual");
    expect(chosen.degradedFrom).toEqual(["official_cli", "isolated_browser", "visible_handoff"]);
    expect(chosen.reasons).toContain("visible_handoff: browser.open_visible is not granted");
  });

  /**
   * A route the tool never declared is not a route, however available and
   * however granted. The descriptor is the allowlist.
   */
  it("never chooses a route the tool does not declare", () => {
    const handoffOnly: ToolSummary = { ...everything, declaredRoutes: ["visible_handoff"] };

    expect(
      chooseRoute({ summary: handoffOnly, granted: allGranted, availability: reachable }).route,
    ).toBe("visible_handoff");
  });

  /** An unreported route is unknown, not available. Fail closed. */
  it("treats a route the shell said nothing about as unreachable", () => {
    expect(chooseRoute({ summary: everything, granted: allGranted, availability: {} }).route).toBe(
      "manual",
    );
  });

  /**
   * THE GATE, and the Phase 9 lesson that cost three defects: a table cannot
   * hide a missing entry, a condition chain can. If a route is added to
   * `ROUTE_NAMES` and not to `ROUTE_CAPABILITY`, this fails.
   */
  it("names a capability for every route and no others", () => {
    expect(Object.keys(ROUTE_CAPABILITY).sort()).toEqual([...ROUTE_NAMES].sort());
  });

  it("returns the verb it was asked for", () => {
    const chosen = chooseRoute({
      summary: everything,
      granted: allGranted,
      availability: reachable,
      verbId: "publish",
    });

    expect(chosen.verb).toMatchObject({ id: "publish", operationClass: "publish" });
    expect(chosen.operationClass).toBe("publish");
  });

  /**
   * A verb the tool does not declare must not silently become another verb, and
   * must not become "no verb, run the default" either.
   */
  it("refuses a verb the tool does not declare", () => {
    const chosen = chooseRoute({
      summary: everything,
      granted: allGranted,
      availability: reachable,
      verbId: "delete_everything",
    });

    expect(chosen.verb).toBeUndefined();
    expect(chosen.unknownVerb).toBe(true);
  });

  /**
   * The page never sees an executable path, a URL, or an origin allowlist — a
   * summary has nowhere to carry one. Asserted on the shape itself, because this
   * is the property that keeps the descriptor an allowlist rather than advice.
   */
  it("is decided from a summary that carries no path, url, or origin", () => {
    expect(Object.keys(everything).sort()).toEqual(["declaredRoutes", "toolId", "verbs"]);
  });
});

describe("raisedOperationClass", () => {
  /**
   * Section 9.1's commit boundary. A verb may say it publishes; it may never say
   * a `tool.run_command` merely inspects — the capability's class is the floor,
   * and the stricter of the two wins.
   */
  it("takes the stricter of the capability floor and the verb", () => {
    expect(raisedOperationClass("tool.run_command", "publish")).toBe("publish");
    expect(raisedOperationClass("tool.run_command", "spend")).toBe("spend");
  });

  it("refuses to let a verb understate the capability", () => {
    expect(raisedOperationClass("tool.run_command", "read_inspect")).toBe("external_write");
    expect(raisedOperationClass("browser.control_profile", "local_reversible_edit")).toBe(
      "external_write",
    );
  });

  it("uses the capability's own class when no verb is involved", () => {
    expect(raisedOperationClass("browser.open_visible", undefined)).toBe("local_reversible_edit");
    expect(raisedOperationClass("tool.inspect", undefined)).toBe("read_inspect");
  });

  /**
   * The severity order has to be total over the operation-class enum, or a class
   * added later compares as equal to everything and silently understates.
   */
  it("orders every operation class", () => {
    const classes = [
      "read_inspect",
      "local_reversible_edit",
      "external_write",
      "message_send",
      "publish",
      "spend",
      "destructive",
      "production_deploy",
      "credential_security",
    ] as const;

    for (const candidate of classes) {
      // Against the strictest floor there is, every verb must lose.
      expect(raisedOperationClass("tool.register_descriptor", candidate)).toBe(
        "credential_security",
      );
    }
  });
});

describe("route preference order", () => {
  /**
   * The order is the policy: official interfaces first, then isolated
   * automation, then somebody's own signed-in browser, then instructions. A
   * router that reached for the person's browser before trying an API would be
   * Section 12.3 backwards.
   */
  it("is Section 12.3's, strongest first", () => {
    const order: readonly RouteName[] = ROUTE_NAMES;

    expect(order.indexOf("official_cli")).toBeLessThan(order.indexOf("isolated_browser"));
    expect(order.indexOf("isolated_browser")).toBeLessThan(order.indexOf("visible_handoff"));
    expect(order.indexOf("visible_handoff")).toBeLessThan(order.indexOf("manual"));
  });
});
