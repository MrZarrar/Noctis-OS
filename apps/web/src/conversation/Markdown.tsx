import { Markdown as Compile, RuleType } from "markdown-to-jsx";
import { typography } from "@noctis/ui";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";

import { MarkdownFiles } from "./MarkdownFiles.js";
import { MermaidDiagram } from "./MermaidDiagram.js";

function Image({ src, alt }: ComponentProps<"img">): JSX.Element {
  const imageUrl = useContext(MarkdownFiles);
  const path = src?.split(/[?#]/, 1)[0];
  const url =
    path !== undefined &&
    !/^(?:https?:|data:|blob:|\/\/)/i.test(path) &&
    /\.(?:png|jpe?g|gif|webp)$/i.test(path)
      ? imageUrl?.(path)
      : undefined;

  return url === undefined ? (
    <span style={{ color: typography.color.muted }}>{alt}</span>
  ) : (
    <img src={url} alt={alt} loading="lazy" style={{ maxWidth: "100%" }} />
  );
}

/** A fenced block with its own Copy button, as VS Code has, so one box copies without selecting it. */
function CopyableBlock({ text, children }: { text: string; children: ReactNode }): JSX.Element {
  const [copied, setCopied] = useState<"Copied" | "Copy failed">();

  useEffect(() => {
    if (copied === undefined) return undefined;

    const timer = setTimeout(() => {
      setCopied(undefined);
    }, 1500);

    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  return (
    <div className="noctis-md-block">
      {children}
      <button
        type="button"
        className="noctis-md-copy"
        onClick={() => {
          navigator.clipboard.writeText(text).then(
            () => {
              setCopied("Copied");
            },
            () => {
              setCopied("Copy failed");
            },
          );
        }}
      >
        {copied ?? "Copy"}
      </button>
    </div>
  );
}

function ReadOnlyCheckbox({ checked }: ComponentProps<"input">): JSX.Element {
  return (
    <input type="checkbox" checked={Boolean(checked)} disabled aria-checked={Boolean(checked)} />
  );
}

/**
 * How a Vault note's `[[Name]]` opens the note it names: a click handler when that note is in
 * the graph, `undefined` when nobody has written it yet. Only notes provide one, because a
 * chat message's `[[ -f x ]]` is Bash, not a link.
 */
export type WikiLinkResolver = (target: string) => (() => void) | undefined;

const WikiLinks = createContext<WikiLinkResolver | undefined>(undefined);

const WIKILINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g;
const WIKI_HREF = "noctis-wikilink:";

function asLinks(text: string): string {
  return text.replace(
    WIKILINK,
    (_, target: string, label: string | undefined) =>
      `[${(label ?? target).trim()}](${WIKI_HREF}${encodeURIComponent(target.trim())})`,
  );
}

/**
 * Only a web link leaves Noctis. An agent's link to a repo path such as
 * `docs/a.md#L1` would navigate the app to nowhere, so it stays as its words.
 */
function Link({ href, children }: ComponentProps<"a">): JSX.Element {
  const resolve = useContext(WikiLinks);

  if (href?.startsWith(WIKI_HREF) === true) {
    const open = resolve?.(decodeURIComponent(href.slice(WIKI_HREF.length)));

    return open === undefined ? (
      <span>{children}</span>
    ) : (
      <button type="button" className="noctis-wikilink" onClick={open}>
        {children}
      </button>
    );
  }

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
  wikiLinks,
}: {
  text: string;
  readOnlyTasks?: boolean;
  wikiLinks?: WikiLinkResolver;
}): JSX.Element {
  return (
    <WikiLinks.Provider value={wikiLinks}>
      <Compile
        options={{
          disableParsingRawHTML: true,
          forceWrapper: true,
          wrapper: "div",
          wrapperProps: { className: "noctis-md" } as object,
          renderRule: (next, node, _renderChildren, state) =>
            node.type !== RuleType.codeBlock ? (
              next()
            ) : node.lang === "mermaid" ? (
              <MermaidDiagram key={state.key} source={node.text} />
            ) : (
              <CopyableBlock key={state.key} text={node.text}>
                {next()}
              </CopyableBlock>
            ),
          overrides: { a: Link, img: Image, ...(readOnlyTasks ? { input: ReadOnlyCheckbox } : {}) },
        }}
      >
        {wikiLinks === undefined ? text : asLinks(text)}
      </Compile>
    </WikiLinks.Provider>
  );
}
