import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown.js";

const render = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

describe("Markdown diagrams", () => {
  it("reserves a diagram instead of a plain code block for a mermaid fence", () => {
    const markup = render("```mermaid\nflowchart LR\n  A --> B\n```");

    expect(markup).toContain('aria-label="Mermaid diagram"');
    expect(markup).not.toContain("<pre");
    expect(markup).not.toContain("<code");
  });

  it("keeps other fenced code and inline code unchanged", () => {
    const markup = render("```typescript\nconst mermaid = true;\n```\n\n`mermaid`");

    expect(markup).toMatch(/<pre><code class="language-typescript[^"]*">/);
    expect(markup).toContain("const mermaid = true;");
    expect(markup).toContain("<code>mermaid</code>");
    expect(markup).not.toContain('aria-label="Mermaid diagram"');
  });

  it("keeps diagrams inside lists and blockquotes", () => {
    const markup = render(
      "> ```mermaid\n> flowchart LR\n>   A --> B\n> ```\n\n- ```mermaid\n  flowchart TD\n    C --> D\n  ```",
    );

    expect(markup.match(/aria-label="Mermaid diagram"/g)).toHaveLength(2);
    expect(markup).toContain("<blockquote>");
    expect(markup).toContain("<ul>");
  });

  it("keeps task checkboxes read-only when diagrams share a document", () => {
    const markup = renderToStaticMarkup(
      createElement(Markdown, {
        text: "- [x] Done\n\n```mermaid\nflowchart LR\n  A --> B\n```",
        readOnlyTasks: true,
      }),
    );

    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-label="Mermaid diagram"');
  });
});
