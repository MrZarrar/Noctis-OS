import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentSurface } from "./document.js";

describe("document host rendering", () => {
  it("keeps inline text escaped and preserves paragraphs in the plain fallback", () => {
    const html = renderToStaticMarkup(
      createElement(DocumentSurface, {
        title: "Draft",
        format: "text",
        content: { from: "inline", text: "one\n\ntwo <script>x</script>" },
      }),
    );
    expect(html).toContain("one\n\ntwo &lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script");
  });
  it("uses the host body without duplicating the raw text", () => {
    const html = renderToStaticMarkup(
      createElement(DocumentSurface, {
        title: "Draft",
        format: "markdown",
        content: { from: "inline", text: "# raw" },
        body: createElement("h1", null, "Rendered"),
      }),
    );
    expect(html).toContain("<h1>Rendered</h1>");
    expect(html).not.toContain("# raw");
  });
  it("never loads a file without a host body", () => {
    const html = renderToStaticMarkup(
      createElement(DocumentSurface, {
        title: "Draft",
        format: "text",
        content: { from: "file", nodeId: "n", grantId: "g", relativePath: "secret.md" },
      }),
    );
    expect(html).toContain("This document opens from Files");
    expect(html).not.toContain("secret.md");
  });
});
