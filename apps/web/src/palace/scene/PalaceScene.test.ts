import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Chrome } from "./Chrome.js";
import { Desk, resizedDeskHeight } from "./Desk.js";
import { PalaceScene } from "./PalaceScene.js";

describe("Palace room navigation", () => {
  const render = (): string =>
    renderToStaticMarkup(
      createElement(PalaceScene, {
        room: "atrium",
        exploring: false,
        onRoomChange: () => undefined,
        children: createElement("span", null, "Fixed controls"),
      }),
    );

  it("keeps the room doors in the accessibility tree", () => {
    const markup = render();
    expect(markup).toContain(">Library</span>");
    expect(markup.slice(0, markup.indexOf(">Library</span>"))).not.toContain('aria-hidden="true"');
  });

  it("lets pointer input reach doors through empty space around the fixed controls", () => {
    const markup = render();
    const overlay = markup.match(/<div([^>]*)><span>Fixed controls<\/span><\/div>/);
    expect(overlay?.[1]).toContain("pointer-events:none");
    expect(markup).toContain('class="palace-canvas"');
  });

  it("keeps the search and navigation clickable and centered above the room", () => {
    const markup = renderToStaticMarkup(
      createElement(Chrome, {
        roomName: "The library",
        query: "",
        onQuery: () => undefined,
        scope: "palace",
        onScope: () => undefined,
        exploring: false,
        onExplore: () => undefined,
        onLeave: () => undefined,
        onReturnToAtrium: () => undefined,
      }),
    );
    const buttons = markup.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(5);
    for (const button of buttons) expect(button).toContain("pointer-events:auto");
    expect(markup.match(/<input[^>]*>/)?.[0]).toContain("pointer-events:auto");
    expect(markup).toMatch(/class="palace-heading-anchor"><div/);
    expect(markup).not.toContain("translateX(-50%)");
  });

  it("writes on the scene's paper without a full-width replacement sheet", () => {
    const markup = renderToStaticMarkup(
      createElement(Desk, {
        value: "An unfinished thought",
        onChange: () => undefined,
        onSave: () => undefined,
        state: { kind: "draft" },
        dimmed: false,
      }),
    );
    expect(markup).toContain('class="palace-desk"');
    expect(markup).not.toContain("linear-gradient");
    expect(markup).toContain("An unfinished thought");
    expect(markup).toContain("Draft saved on this device");
  });

  it("shows the demo save limit instead of a permanent-save confirmation", () => {
    const markup = renderToStaticMarkup(
      createElement(Desk, {
        value: "A sample idea",
        onChange: () => undefined,
        onSave: () => undefined,
        state: { kind: "message", text: "Demo saved for this tab. Refreshing resets it." },
        dimmed: false,
      }),
    );
    expect(markup).toContain("Demo saved for this tab. Refreshing resets it.");
  });

  it("offers a full writing view and bounds drag resizing to the available space", () => {
    const markup = renderToStaticMarkup(
      createElement(Desk, {
        value: "A long letter",
        onChange: () => undefined,
        onSave: () => undefined,
        state: { kind: "idle" },
        dimmed: false,
      }),
    );
    expect(markup).toContain('aria-label="Open full writing view"');
    expect(resizedDeskHeight(300, 200, 100, 700)).toBe(400);
    expect(resizedDeskHeight(300, 200, 900, 700)).toBe(180);
    expect(resizedDeskHeight(300, 700, 0, 700)).toBe(700);
  });

  it("can save a book record before its notebook has any writing", () => {
    const props = {
      value: "",
      onChange: () => undefined,
      onSave: () => undefined,
      state: { kind: "idle" } as const,
      dimmed: false,
    };
    const button = (allowEmptyBody: boolean) =>
      renderToStaticMarkup(createElement(Desk, { ...props, allowEmptyBody })).match(
        /<button[^>]*class="palace-save"[^>]*>/,
      )?.[0];
    expect(button(false)).toContain("disabled");
    expect(button(true)).not.toContain("disabled");
  });
});
