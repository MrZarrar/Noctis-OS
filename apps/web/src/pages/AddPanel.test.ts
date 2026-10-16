import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AddPanel } from "./AddPanel.js";

describe("AddPanel", () => {
  const markup = renderToStaticMarkup(
    createElement(AddPanel, {
      transport: undefined,
      identityId: "vesper",
      onAdded: () => undefined,
    }),
  );

  it("draws the menu on a solid background, so the thread behind it does not show through", () => {
    const dialog = markup.match(/<dialog[^>]*>/)?.[0] ?? "";

    expect(dialog).toMatch(/background:\s*#/);
  });

  it("makes Cancel red", () => {
    expect(markup).toMatch(/<button[^>]*style="[^"]*background:\s*#FF4D4D[^"]*"[^>]*>Cancel</);
  });
});
