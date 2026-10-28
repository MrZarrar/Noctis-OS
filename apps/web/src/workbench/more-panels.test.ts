import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { depth } from "@noctis/ui";
import { MorePanels } from "./MorePanels.js";

describe("tucked panels control", () => {
  it("lists titles, update marks and keyboard-accessible show buttons on a solid background", () => {
    const markup = renderToStaticMarkup(
      createElement(MorePanels, {
        panels: [
          { scope: "thread", id: "a", title: "Build script", updated: true },
          { scope: "objective", id: "b", title: "Trainers", updated: false },
        ],
        onShow: () => undefined,
      }),
    );
    expect(markup).toContain("Panels (2 hidden or closed)");
    expect(markup).toContain("Build script");
    expect(markup).toContain("Trainers");
    expect(markup).toContain("Updated");
    expect(markup).toContain('aria-label="Show Build script"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain(`background:${depth.layers[1]}`);
    expect(markup).toContain("<summary");
  });

  it("renders nothing when there are no tucked panels", () => {
    expect(
      renderToStaticMarkup(
        createElement(MorePanels, {
          panels: [],
          onShow: () => undefined,
        }),
      ),
    ).toBe("");
  });
});
