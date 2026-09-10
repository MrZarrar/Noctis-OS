import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SurfaceContext } from "../surfaces/renderers.js";
import { renderSurface } from "../surfaces/renderers.js";
import { resolveSurface } from "../surfaces/registry.js";

/**
 * The control a Surface only shows when its handoff was actually supplied.
 *
 * This file exists because the same defect happened five times in this
 * codebase: a Surface built and registered, a handoff declared in
 * `SurfaceContext`, and no path from a person's click to the thing that acts.
 * Three of those were found by clicking during Phase 9's qualification; two more
 * were found by tracing during Phase 10, one of them the whole confirmation
 * path.
 *
 * Every one of them shared a shape a type-checker cannot see: a handoff that is
 * declared, optional, and never passed renders a Surface with no button, which
 * is indistinguishable from a Surface that is working.
 *
 * So the assertion is deliberately end-to-end through the render: give the
 * context, get the control; withhold the context, lose the control. It is the
 * cheapest thing that fails if a handoff stops being forwarded — by the
 * registry, by `renderSurface`, or by the Surface itself.
 */
interface HandoffCase {
  kind: string;
  capability: string;
  payload: unknown;
  /** The text of the control that must appear only when the handoff is given. */
  control: string;
  /** The context that should produce it. */
  context: SurfaceContext;
}

const APPROVAL_PAYLOAD = {
  id: "0199a000-0000-7000-8000-000000000001",
  consequenceSummary: "Open Vinted in your own signed-in browser",
  operationClass: "local_reversible_edit",
  capability: "browser.open_visible",
  targetType: "tool",
  targetId: "vinted",
  reversibility: "reversible" as const,
  outcome: "require_confirmation" as const,
  reasonCodes: ["operation_class_default", "objective_not_active"],
};

const TOOL_PAYLOAD = {
  tools: [
    {
      toolId: "vinted",
      displayName: "Vinted",
      route: "visible_handoff" as const,
      degradedFrom: [],
      verbs: [],
      state: { kind: "ready" as const },
    },
  ],
};

const NATIVE_PAYLOAD = {
  applications: [
    {
      applicationId: "vscode",
      displayName: "Visual Studio Code",
      intendedMonitor: "primary" as const,
      intendedRegion: "left_two_thirds" as const,
      state: { kind: "discovered" as const, windowTitle: "Noctis", handle: 1 },
    },
  ],
};

const CASES: readonly HandoffCase[] = [
  {
    kind: "approval",
    capability: "authority.approve",
    payload: APPROVAL_PAYLOAD,
    // THE one this file was written for. Until Phase 10 nothing supplied
    // `onConfirm`, so every decision Noctis ever asked about was unanswerable.
    control: "Confirm",
    context: { onConfirm: () => undefined },
  },
  {
    kind: "external_tool",
    capability: "tool.inspect",
    payload: TOOL_PAYLOAD,
    control: "Go there",
    context: { onActOnTool: () => undefined },
  },
  {
    kind: "native_application",
    capability: "window.place",
    payload: NATIVE_PAYLOAD,
    control: "Arrange this window",
    context: { onPlaceWindow: () => undefined },
  },
];

function render(testCase: HandoffCase, context: SurfaceContext): string {
  const resolved = resolveSurface(testCase.kind, 1, testCase.payload, "standard", [
    testCase.capability,
  ]);

  // A fallback would make the control absent for a reason that has nothing to do
  // with handoffs, and the test below would pass while proving nothing.
  expect(resolved.status).toBe("ok");

  return renderToStaticMarkup(
    createElement("div", null, renderSurface(resolved, context)) as ReactElement,
  );
}

describe("every declared handoff reaches a control", () => {
  for (const testCase of CASES) {
    it(`${testCase.kind} offers "${testCase.control}" when its handoff is supplied`, () => {
      expect(render(testCase, testCase.context)).toContain(testCase.control);
    });

    /**
     * The other half, and not redundant: it is what makes the first half mean
     * "because of the handoff" rather than "always". Without it, a Surface that
     * rendered the button unconditionally would pass.
     */
    it(`${testCase.kind} withholds "${testCase.control}" when it is not`, () => {
      expect(render(testCase, {})).not.toContain(testCase.control);
    });
  }
});

describe("the capability gate", () => {
  /**
   * A Surface whose `requires` is not held renders the fallback, buttons and
   * all. Pinned because the approval Surface spent three phases in exactly this
   * state without anybody noticing: `requires: "authority.approve"` and no
   * caller passing it, so the boundary screen was a fallback even when it was
   * proposed.
   */
  it("renders a fallback rather than a control when the capability is absent", () => {
    const resolved = resolveSurface("approval", 1, APPROVAL_PAYLOAD, "standard", []);

    expect(resolved.status).toBe("fallback");

    const markup = renderToStaticMarkup(
      createElement(
        "div",
        null,
        renderSurface(resolved, { onConfirm: () => undefined }),
      ) as ReactElement,
    );

    expect(markup).not.toContain("Confirm");
  });
});
