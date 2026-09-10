import { describe, expect, it } from "vitest";

import { externalToolBridgeFrom } from "./ExternalToolBridge.js";

/**
 * A shell response as `tool_survey` actually produces it: availability reported
 * only for the routes the tool declares, and nothing else.
 */
const SURVEY_FROM_THE_SHELL = [
  {
    toolId: "vinted",
    displayName: "Vinted",
    declaredRoutes: ["visible_handoff"],
    verbs: [],
    availability: { visible_handoff: { available: true } },
    manualSteps: ["Open Vinted and start a new listing."],
  },
];

function bridgeReturning(answer: unknown): ReturnType<typeof externalToolBridgeFrom> {
  return externalToolBridgeFrom({
    __TAURI__: { core: { invoke: () => Promise.resolve(answer) } },
  });
}

describe("externalToolBridgeFrom", () => {
  /**
   * `undefined` in a browser, and that is the answer rather than a failure. It
   * is also why the E2E suite needs no shell to pretend at: with no bridge the
   * Surface simply does not appear.
   */
  it("is nothing at all outside the desktop shell", () => {
    expect(externalToolBridgeFrom(undefined)).toBeUndefined();
    expect(externalToolBridgeFrom({})).toBeUndefined();
  });

  /**
   * THE GATE: the shell reports availability only for the routes a tool
   * declares, because a route it does not offer has no availability to report.
   * A schema that demanded an entry per route would reject every real response —
   * and it would do it at runtime, in the one place Phase 9 proved a schema
   * mismatch surfaces as a Surface that quietly stops working.
   */
  it("accepts an availability map covering only the declared routes", async () => {
    const bridge = bridgeReturning(SURVEY_FROM_THE_SHELL);

    const surveyed = await bridge?.survey();

    expect(surveyed?.[0]?.availability).toEqual({ visible_handoff: { available: true } });
    expect(surveyed?.[0]?.declaredRoutes).toEqual(["visible_handoff"]);
  });

  /**
   * A route name the page does not know is a drift between the two sides, and it
   * must fail loudly here rather than becoming a Surface with a blank line where
   * the route sentence should be.
   */
  it("refuses a route name the contract does not define", async () => {
    const bridge = bridgeReturning([
      { ...SURVEY_FROM_THE_SHELL[0], declaredRoutes: ["remote_desktop"] },
    ]);

    await expect(bridge?.survey()).rejects.toThrow();
  });

  /**
   * `Option::None` serialises as `null`, and `.optional()` rejects it — the
   * defect that put a raw zod error on screen in Phase 9. Asserted by sending
   * `null` rather than by omitting the field, because omitting it is what made
   * the original test pass while the product failed.
   */
  it("accepts a needsApproval whose confirmation phrase is null", async () => {
    const bridge = bridgeReturning({
      kind: "needsApproval",
      requestId: "req-1",
      outcome: "require_confirmation",
      consequenceSummary: "Open Vinted in your own signed-in browser",
      confirmationPhrase: null,
    });

    await expect(
      bridge?.execute({ toolId: "vinted", verbId: "", route: "visible_handoff" }),
    ).resolves.toMatchObject({ kind: "needsApproval" });
  });

  /** Every outcome the shell can produce has to survive the boundary parse. */
  it("accepts every outcome the shell produces", async () => {
    const outcomes = [
      { kind: "launched", processId: 4242, launchCorrelationId: "launch-7" },
      { kind: "ran", exitCode: 0, output: "" },
      { kind: "handedOff", url: "https://www.vinted.co.uk/items/new" },
      { kind: "instructions", steps: ["Open it"] },
      { kind: "routeUnavailable", route: "isolated_browser", reason: "not built" },
      { kind: "refused", reason: "This tool does not offer the official_cli route" },
    ];

    for (const outcome of outcomes) {
      const bridge = bridgeReturning(outcome);

      await expect(
        bridge?.execute({ toolId: "vinted", verbId: "", route: "manual" }),
      ).resolves.toMatchObject({ kind: outcome.kind });
    }
  });
});
