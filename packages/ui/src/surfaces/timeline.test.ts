import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TimelineSurface } from "./timeline.js";

describe("timeline rendering", () => {
  it("shows times as supplied, details, due text, and rows without times", () => {
    const html = renderToStaticMarkup(
      createElement(TimelineSurface, {
        title: "Today",
        items: [
          { id: "a", start: "09:00", end: "10:00", label: "Build", detail: "Step", due: true },
          { id: "b", label: "Review" },
        ],
      }),
    );
    expect(html).toContain("09:00 – 10:00");
    for (const text of ["Step", "Due", "Review"]) expect(html).toContain(text);
  });
});
