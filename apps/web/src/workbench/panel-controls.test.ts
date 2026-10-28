import { describe, expect, it } from "vitest";
import { PanelControls } from "./PanelControls.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const props = {
  title: "Approvals",
  size: "standard" as const,
  pinned: false,
  focused: false,
  onFocus() {},
  onPin() {},
  onSize() {},
  onClose() {},
  async onHide() {},
};

describe("panel controls", () => {
  it("offers separate hide and close actions", () => {
    const markup = renderToStaticMarkup(createElement(PanelControls, props));
    expect(markup).toContain('aria-label="Hide Approvals"');
    expect(markup).toContain('aria-label="Close Approvals"');
  });
  it("offers pop-out only when the host supplies the action", () => {
    expect(
      renderToStaticMarkup(createElement(PanelControls, { ...props, onPopout() {} })),
    ).toContain('aria-label="Pop out Approvals"');
    expect(renderToStaticMarkup(createElement(PanelControls, props))).not.toContain(
      'aria-label="Pop out Approvals"',
    );
  });
  it("has no fixed Place picker: a panel is moved by dragging it", () => {
    expect(renderToStaticMarkup(createElement(PanelControls, props))).not.toContain("Place ");
  });
});
