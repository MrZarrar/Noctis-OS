import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { IntelligenceRenderer } from "./IntelligenceRenderer.js";

describe("IntelligenceRenderer", () => {
  it("renders recognizable vector shards before WebGL and exposes its state without a live region", () => {
    const html = renderToStaticMarkup(
      createElement(IntelligenceRenderer, { identityId: "vesper", state: "waiting_for_approval" }),
    );
    expect(html).toContain('data-core-state="waiting_for_approval"');
    expect(html).toContain('data-core-renderer="static"');
    expect(html).toContain('data-core-frames="0"');
    expect(html).toContain("<polygon");
    expect(html).toContain("<line");
    expect(html).toContain('role="img"');
    expect(html).not.toContain("aria-live");
    expect(html).not.toContain("radial-gradient");
    const heart = html.match(/<g data-core-heart="true">([\s\S]*?)<\/g>/)?.[1];
    expect(heart).toBeDefined();
    const fills = [...heart!.matchAll(/fill="([^"]+)"/g)].map((match) => match[1]);
    expect(fills.length).toBeGreaterThan(8);
    expect(fills.every((fill) => fill === "#ffc16c")).toBe(true);
    expect(html).not.toContain('cx="239"');
  });
});
