import { Markdown as Compile, RuleType } from "markdown-to-jsx";
import { typography } from "@noctis/ui";
import type { ComponentProps } from "react";
import { useContext } from "react";

import { MarkdownFiles } from "./MarkdownFiles.js";
import { MermaidDiagram } from "./MermaidDiagram.js";

function Image({ src, alt }: ComponentProps<"img">): JSX.Element {
  const imageUrl = useContext(MarkdownFiles);
  const url =
    src !== undefined &&
    /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(src) &&
    /\.(?:png|jpe?g|gif|webp)$/i.test(src)
      ? imageUrl?.(src)
      : undefined;

  return url === undefined ? (
    <span style={{ color: typography.color.muted }}>{alt}</span>
  ) : (
    <img src={url} alt={alt} loading="lazy" style={{ maxWidth: "100%" }} />
  );
}

function ReadOnlyCheckbox({ checked }: ComponentProps<"input">): JSX.Element {
  return (
    <input type="checkbox" checked={Boolean(checked)} disabled aria-checked={Boolean(checked)} />
  );
}

/**
 * Only a web link leaves Noctis. An agent's link to a repo path such as
 * `docs/a.md#L1` would navigate the app to nowhere, so it stays as its words.
 */
function Link({ href, children }: ComponentProps<"a">): JSX.Element {
  return href !== undefined && /^(https?:|mailto:)/i.test(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

/**
 * A message body as the agent wrote it: bold, code, lists and tables drawn
 * rather than shown as raw asterisks and backticks. HTML in the text stays text.
 * The look is `.noctis-md` in index.css, because the core's CSP refuses inline
 * `<style>`.
 */
export function Markdown({
  text,
  readOnlyTasks = false,
}: {
  text: string;
  readOnlyTasks?: boolean;
}): JSX.Element {
  return (
    <Compile
      options={{
        disableParsingRawHTML: true,
        forceWrapper: true,
        wrapper: "div",
        wrapperProps: { className: "noctis-md" } as object,
        renderRule: (next, node, _renderChildren, state) =>
          node.type === RuleType.codeBlock && node.lang === "mermaid" ? (
            <MermaidDiagram key={state.key} source={node.text} />
          ) : (
            next()
          ),
        overrides: { a: Link, img: Image, ...(readOnlyTasks ? { input: ReadOnlyCheckbox } : {}) },
      }}
    >
      {text}
    </Compile>
  );
}
