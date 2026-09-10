import type { ExternalToolState, RouteName } from "@noctis/contracts";
import { ExternalToolStateSchema, ROUTE_NAMES } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { ACT_LABEL } from "./external_tool.js";

/**
 * Every state the contract allows, taken from the schema rather than written
 * out, so a state added to the union without a label fails here.
 */
const STATE_KINDS: readonly ExternalToolState["kind"][] = ExternalToolStateSchema.options.map(
  (option) => option.shape.kind.value,
);

describe("ACT_LABEL", () => {
  /**
   * THE GATE, and the reason this table exists at all.
   *
   * Phase 9 shipped three defects of one shape: a mechanism built, tested in
   * isolation, and left with no path a person could take to it. One of them was
   * exactly this table's absence — the place action was offered in three states
   * and missing from `placed`, which was the only state the user-override
   * gesture could be performed from, so a gate clause was unreachable from the
   * interface while its unit tests passed.
   *
   * A missing key fails this test. A missing `&&` in a condition chain fails
   * nothing.
   */
  it("has an entry for every state the contract allows", () => {
    expect(Object.keys(ACT_LABEL).sort()).toEqual([...STATE_KINDS].sort());
  });

  /**
   * Only one state may withhold the action, and it is the one with a decision
   * outstanding. Every other state — including the failures — must offer a way
   * forward, because a Surface with no action is a dead end a person has to
   * reload the app to escape.
   */
  it("offers a way forward from every state except the one awaiting a decision", () => {
    const withoutAction = STATE_KINDS.filter((kind) => ACT_LABEL[kind] === undefined);

    expect(withoutAction).toEqual(["needsApproval"]);
  });

  /**
   * The failure states have to be retryable. Installing the tool, or plugging in
   * a display, changes the answer — and nothing else in the interface would ask
   * again.
   */
  it("lets a person retry a route that was unavailable or refused", () => {
    expect(ACT_LABEL.routeUnavailable).toBeDefined();
    expect(ACT_LABEL.refused).toBeDefined();
    expect(ACT_LABEL.instructions).toBeDefined();
  });

  /**
   * A label is a sentence fragment somebody reads on a button, not an
   * identifier. Phase 9 pinned the same property on its region labels after a
   * draft rendered `left_two_thirds` at a person.
   */
  it("reads as words rather than as identifiers", () => {
    for (const label of Object.values(ACT_LABEL)) {
      if (label === undefined) {
        continue;
      }

      expect(label).not.toContain("_");
      expect(label.length).toBeGreaterThan(2);
    }
  });
});

describe("route names the Surface must be able to describe", () => {
  /**
   * The Surface renders a sentence per route, including for the routes it
   * degraded past. A route with no sentence would render blank in the one place
   * a person is deciding whether to let Noctis into their signed-in browser.
   */
  it("covers all four of Section 12.3's routes", () => {
    const routes: readonly RouteName[] = ROUTE_NAMES;

    expect(routes).toHaveLength(4);
  });
});
