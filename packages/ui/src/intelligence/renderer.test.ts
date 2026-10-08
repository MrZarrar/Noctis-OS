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

  it("draws Jester's faults at rest but keeps the face hidden, and picks Jester's profile from the identity", () => {
    const html = renderToStaticMarkup(
      createElement(IntelligenceRenderer, { identityId: "jester", state: "idle" }),
    );

    expect(html).toContain('data-core-profile="jester"');
    expect(html).toContain('data-jester-fault="true"');
    expect(html).toContain('stroke="#b6ff3b"');
    expect(html).toContain('data-jester-drip="true"');
    expect(html).not.toContain('data-jester-grin="true"');
    expect(html).not.toContain("#ff3b5c");
  });

  it("surfaces the red eye and the grin while Jester speaks, the heart moved to the right eye", () => {
    const html = renderToStaticMarkup(
      createElement(IntelligenceRenderer, { identityId: "jester", state: "speaking" }),
    );

    expect(html).toContain('data-jester-grin="true"');
    expect(html).toContain('fill="#ff3b5c"');
    // Right and up: the violet eye's place, projected like every other point.
    expect(html).toMatch(
      /<g data-core-heart="true" transform="translate\(\d+(\.\d+)? -\d+(\.\d+)?\)">/,
    );
  });

  it("drops the face for approval and turns the centre amber, as Vesper's does", () => {
    const html = renderToStaticMarkup(
      createElement(IntelligenceRenderer, { identityId: "jester", state: "waiting_for_approval" }),
    );
    const heart = html.match(/<g data-core-heart="true"[^>]*>([\s\S]*?)<\/g>/)?.[1];

    expect(html).not.toContain('data-jester-grin="true"');
    expect(html).not.toContain("#ff3b5c");
    expect([...heart!.matchAll(/fill="([^"]+)"/g)].every((match) => match[1] === "#ffc16c")).toBe(
      true,
    );
  });

  it("draws nothing of Jester's for Vesper", () => {
    const html = renderToStaticMarkup(
      createElement(IntelligenceRenderer, { identityId: "vesper", state: "speaking" }),
    );

    expect(html).toContain('data-core-profile="vesper"');
    expect(html).not.toContain("data-jester");
    expect(html).not.toContain("#b6ff3b");
    expect(html).not.toContain("#ff3b5c");
  });
});
