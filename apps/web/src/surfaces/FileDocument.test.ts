import type { DocumentPayload } from "@noctis/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MarkdownFiles, type MarkdownImageUrl } from "../conversation/MarkdownFiles.js";
import { filesQuery } from "../pages/files-view.js";
import type { FileTextCache } from "../pages/useFileText.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { FileDocument } from "./FileDocument.js";

const transport: CoreTransport = {
  request: () => Promise.resolve({ status: 200, body: {} }),
  subscribe: () => Promise.resolve({ close: () => undefined }),
  contentUrl: (path) => `/core${path}`,
};

function render(
  text: string,
  relativePath = "guide/README.md",
  outerImageUrl?: MarkdownImageUrl,
  fileTransport = transport,
  format: DocumentPayload["format"] = "markdown",
): string {
  const source = { from: "file" as const, nodeId: "doc-node", grantId: "doc-grant", relativePath };
  const path = `/files/content?${filesQuery(source, relativePath)}`;
  const surfaceId = "document";
  const cache: FileTextCache = new Map([
    [
      surfaceId,
      {
        transport: fileTransport,
        key: JSON.stringify(["", path, surfaceId]),
        revision: "",
        text,
        loading: false,
      },
    ],
  ]);

  return renderToStaticMarkup(
    createElement(
      MarkdownFiles.Provider,
      { value: outerImageUrl },
      createElement(FileDocument, {
        payload: { title: "README", format, content: source },
        context: { fileTransport, fileText: { cache, surfaceId } },
      }),
    ),
  );
}

describe("Markdown file images", () => {
  it.each([
    ["README.md", "docs/health/day.png", "docs/health/day.png"],
    ["guide/README.md", "shots/day.png", "guide/shots/day.png"],
    ["guide/README.md", "./shots/a.webp", "guide/shots/a.webp"],
    ["guide/README.md", "../art/b.jpg", "art/b.jpg"],
    ["guide/nested/README.md", "../art/b.jpg", "guide/art/b.jpg"],
    ["guide/README.md", "./shots/../art//b.jpg", "guide/art/b.jpg"],
    ["guide/README.md", "shots/login%20screen.png", "guide/shots/login screen.png"],
    ["guide/README.md", "../art/b.jpg?raw=1#preview", "art/b.jpg"],
  ])("resolves %s with %s inside the document's grant", (document, src, joined) => {
    const markup = render(`![screen](${src})`, document);
    const query = filesQuery({ nodeId: "doc-node", grantId: "doc-grant" }, joined).replaceAll(
      "&",
      "&amp;",
    );

    expect(markup).toContain(`src="/core/files/content?${query}"`);
    expect(markup).toContain('alt="screen"');
    expect(markup).toContain('loading="lazy"');
  });

  it.each([
    "../../private/a.png",
    "../art/../../private/a.png",
    "%2e%2e/%2e%2e/private/a.png",
    "%2Fprivate/a.png",
    "shots/%bad.png",
  ])("shows alt text when a relative path is unsafe or malformed: %s", (src) => {
    const outerImageUrl = vi.fn(() => "/must-not-load");
    const markup = render(`![unavailable](${src})`, "guide/README.md", outerImageUrl);

    expect(markup).not.toContain("<img");
    expect(markup).toContain("unavailable</span>");
    expect(outerImageUrl).not.toHaveBeenCalled();
  });

  it.each([
    "https://example.com/a.png",
    "http://example.com/a.png",
    "//example.com/a.png",
    "data:image/png;base64,AA==",
    "blob:preview/a.png",
  ])("shows alt text for a remote or embedded image: %s", (src) => {
    const outerImageUrl = vi.fn(() => "/must-not-load");
    const markup = render(`![external](${src})`, "guide/README.md", outerImageUrl);

    expect(markup).not.toContain("<img");
    expect(markup).toContain("external</span>");
    expect(outerImageUrl).not.toHaveBeenCalled();
  });

  it.each(["C:/repo/shots/a.png", String.raw`C:\repo\shots\a.png`, "/repo/shots/a.png"])(
    "delegates absolute paths to the outer resolver: %s",
    (src) => {
      const outerImageUrl = vi.fn(() => "/outer-image");
      const markup = render(`![absolute](${src})`, "guide/README.md", outerImageUrl);

      expect(outerImageUrl).toHaveBeenCalledWith(src);
      expect(markup).toContain('src="/outer-image"');
    },
  );

  it("shows alt text if the transport cannot serve image URLs", () => {
    const markup = render("![screen](shots/a.png)", "guide/README.md", undefined, {
      request: transport.request,
      subscribe: transport.subscribe,
    });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("screen</span>");
  });

  it("keeps plain text files as text", () => {
    const markup = render(
      "![screen](shots/a.png)",
      "guide/README.txt",
      undefined,
      transport,
      "text",
    );
    expect(markup).toContain("![screen](shots/a.png)");
    expect(markup).not.toContain("<img");
  });
});
