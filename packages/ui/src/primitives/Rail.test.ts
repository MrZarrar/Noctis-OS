import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Rail } from "./Rail.js";

describe("Rail", () => {
  const html = renderToStaticMarkup(
    createElement(Rail, { active: "Presence", onSelect: () => undefined, allPages: true }),
  );

  it("never scrolls sideways, which pushed the icons off centre", () => {
    expect(html).toContain("overflow-x:hidden");
  });

  it("cuts a label too long for the column instead of widening it", () => {
    expect(html).toMatch(/<span[^>]*text-overflow:ellipsis[^>]*>Automations<\/span>/);
  });
});
