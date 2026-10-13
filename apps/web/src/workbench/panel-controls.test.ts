import { describe, expect, it } from "vitest";
import { controlsFor, PanelControls } from "./PanelControls.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

describe("panel controls", () => {
  it("offers pop-out in a narrow desktop strip when the host supplies the action", () => {
    const props = {
      title: "Approvals",
      region: "centre" as const,
      size: "standard" as const,
      display: "compact" as const,
      pinned: false,
      focused: false,
      regions: [],
      onFocus() {},
      onPin() {},
      onPlace() {},
      onSize() {},
      onClose() {},
    };
    expect(
      renderToStaticMarkup(createElement(PanelControls, { ...props, onPopout() {} })),
    ).toContain('aria-label="Pop out Approvals"');
    expect(renderToStaticMarkup(createElement(PanelControls, props))).not.toContain(
      'aria-label="Pop out Approvals"',
    );
  });
  it("keeps place off compact panels", () => {
    expect(controlsFor("compact")).toEqual(["focus", "pin", "size", "close"]);
    expect(controlsFor("standard")).toEqual(["focus", "pin", "place", "size", "close"]);
    expect(controlsFor("wide")).toEqual(controlsFor("standard"));
  });
});
