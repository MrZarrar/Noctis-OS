import type { RouteName, ToolDescriptor } from "@noctis/contracts";
import { ROUTE_CAPABILITY, ROUTE_NAMES } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { UNAVAILABLE_UNBUILT, chooseRoute, raisedOperationClass } from "./route.js";

const everything: ToolDescriptor = {
  id: "vinted",
  displayName: "Vinted",
  instructions: "Open Vinted and start a new listing by hand.",
  routes: [
    {
      route: "official_cli",
      executable: "vinted-cli",
      detached: false,
      verbs: [
        {
          id: "draft",
          label: "Draft a listing",
          args: ["draft"],
          operationClass: "local_reversible_edit",
        },
        { id: "publish", label: "Publish", args: ["publish"], operationClass: "publish" },
      ],
    },
    {
      route: "isolated_browser",
      url: "https://www.vinted.co.uk/items/new",
      origins: ["https://www.vinted.co.uk"],
    },
    {
      route: "visible_handoff",
      url: "https://www.vinted.co.uk/items/new",
      origins: ["https://www.vinted.co.uk"],
    },
    { route: "manual", steps: ["Open Vinted", "Press Sell now"] },
  ],
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
   * THE GATE: `manual` is the terminal fallback, so a tool with nothing declared
   * and nothing granted still gets an answer. A router that could return "no
   * route" would make every caller invent its own degradation.
   */
  it("always finds a route, even for a tool that declares none", () => {
    const bare: ToolDescriptor = { ...everything, routes: [] };

    expect(chooseRoute({ descriptor: bare, granted: new Set(), availability: {} })).toMatchObject({
      route: "manual",
      capability: "tool.inspect",
    });
  });

  it("prefers the strongest route the tool declares, the machine can reach, and a grant covers", () => {
    const chosen = chooseRoute({
      descriptor: everything,
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
      descriptor: everything,
      granted: allGranted,
      availability: {
        ...reachable,
        official_cli: { available: false, reason: "vinted-cli is not installed" },
        isolated_browser: UNAVAILABLE_UNBUILT,
      },
    });

    expect(chosen.route).toBe("visible_handoff");
    expect(chosen.degradedFrom).toEqual(["official_cli", "isolated_browser"]);
  });

  /**
   * THE GATE: Section 12.3 wants existing-profile control separately granted.
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
      descriptor: everything,
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
  it("never chooses a route the descriptor does not declare", () => {
    const handoffOnly: ToolDescriptor = {
      ...everything,
      routes: everything.routes.filter((route) => route.route === "visible_handoff"),
    };

    expect(
      chooseRoute({ descriptor: handoffOnly, granted: allGranted, availability: reachable }).route,
    ).toBe("visible_handoff");
  });

  /** An unreported route is unknown, not available. Fail closed. */
  it("treats a route the shell said nothing about as unreachable", () => {
    const chosen = chooseRoute({
      descriptor: everything,
      granted: allGranted,
      availability: {},
    });

    expect(chosen.route).toBe("manual");
  });

  /**
   * THE GATE, and the Phase 9 lesson that cost three defects: a table cannot
   * hide a missing entry, a condition chain can. If a route is added to
   * `ROUTE_NAMES` and not to `ROUTE_CAPABILITY`, this fails.
   */
  it("names a capability for every route and no others", () => {
    expect(Object.keys(ROUTE_CAPABILITY).sort()).toEqual([...ROUTE_NAMES].sort());
  });

  it("returns the verb it was asked for when the chosen route has one", () => {
    const chosen = chooseRoute({
      descriptor: everything,
      granted: allGranted,
      availability: reachable,
      verbId: "publish",
    });

    expect(chosen.verb).toMatchObject({ id: "publish", operationClass: "publish" });
  });

  /**
   * A verb the chosen route does not declare must not silently become another
   * verb, and must not become "no verb, run the default" either.
   */
  it("refuses a verb the chosen route does not declare", () => {
    const chosen = chooseRoute({
      descriptor: everything,
      granted: allGranted,
      availability: reachable,
      verbId: "delete_everything",
    });

    expect(chosen.verb).toBeUndefined();
    expect(chosen.unknownVerb).toBe(true);
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
