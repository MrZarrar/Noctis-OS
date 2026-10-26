import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown.js";

const render = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

describe("a message body", () => {
  it("draws an agent's Markdown instead of showing its asterisks and backticks", () => {
    const markup = render(
      "Got it, **this** works.\n\n1. **Old build:** run `npm run build`\n2. Two",
    );

    expect(markup).toContain("<strong>this</strong>");
    expect(markup).toContain("<code>npm run build</code>");
    expect(markup).toMatch(/<ol[^>]*><li><strong>Old build:<\/strong>/);
    expect(markup).not.toContain("**");
    expect(markup).not.toContain("`");
  });

  it("keeps a typed line break, as plain chat did before", () => {
    expect(render("line one\nline two")).toMatch(/class="noctis-md"[^>]*>[^]*line one\nline two/);
  });

  it("shows HTML in a message as text, never as markup", () => {
    const markup = render('<img src="x" onerror="alert(1)"> <script>alert(2)</script>');

    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
    expect(markup).toContain("&lt;img");
  });

  it("opens web links in a new tab and leaves every other link as its text", () => {
    const markup = render(
      "[site](https://example.com) [file](docs/a.md#L1) [bad](javascript:alert(1))",
    );

    expect(markup).toMatch(
      /<a [^>]*href="https:\/\/example.com"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/,
    );
    expect(markup).not.toContain('href="docs');
    expect(markup).not.toContain("javascript:");
    expect(markup).toContain("file");
    expect(markup).toContain("bad");
  });
});

describe("a box of text in a reply", () => {
  it("gets its own Copy button, so a lyric sheet's two boxes copy separately", () => {
    const markup = render(
      "**Lyrics**\n\n```\n[Verse 1]\nI dreamed\n```\n\n**Style prompt**\n\n```text\ndream pop, 92 bpm\n```",
    );

    expect(markup.match(/<button[^>]*>Copy<\/button>/g)).toHaveLength(2);
    expect(markup).toContain("[Verse 1]\nI dreamed");
    expect(markup).toContain("dream pop, 92 bpm");
  });

  it("leaves inline code alone", () => {
    expect(render("run `npm test` now")).not.toContain("<button");
  });
});
