import { depth, identityAccent, material, typography } from "@noctis/ui";
import type { Mermaid } from "mermaid";
import { useEffect, useState } from "react";

let renderer: Promise<Mermaid> | undefined;
let nextId = 0;

export async function renderMermaid(source: string): Promise<string> {
  renderer ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: "base",
      themeVariables: {
        darkMode: true,
        background: depth.layers[1],
        primaryColor: depth.layers[2],
        primaryTextColor: typography.color.primary,
        primaryBorderColor: identityAccent.vesper.primary,
        secondaryColor: depth.layers[3],
        secondaryTextColor: typography.color.primary,
        tertiaryColor: depth.layers[0],
        tertiaryTextColor: typography.color.primary,
        lineColor: typography.color.muted,
        textColor: typography.color.primary,
        edgeLabelBackground: depth.layers[1],
        clusterBkg: depth.layers[0],
        clusterBorder: material.highlight,
        fontFamily: typography.family,
      },
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "suppressErrorRendering",
        "htmlLabels",
        "flowchart",
      ],
    });
    return mermaid;
  });

  const mermaid = await renderer;
  const { svg } = await mermaid.render(`noctis-mermaid-${String(++nextId)}`, source);
  return svg;
}

export interface DiagramResult {
  source: string;
  url?: string;
  width?: number;
  height?: number;
  failed?: boolean;
}

export function diagramDimensions(svg: string): Pick<DiagramResult, "width" | "height"> {
  const viewBox = /<svg\b[^>]*\bviewBox="([^"]+)"/.exec(svg)?.[1];
  const [, , width, height] =
    viewBox
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  return width !== undefined &&
    height !== undefined &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : {};
}

export function startDiagramRender(
  source: string,
  publish: (result: DiagramResult) => void,
): () => void {
  let cancelled = false;
  let url: string | undefined;

  void renderMermaid(source)
    .then((svg) => {
      if (cancelled) return;
      url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      // Percentage SVG widths lose their natural size when loaded as images.
      publish({ source, url, ...diagramDimensions(svg) });
    })
    .catch(() => {
      if (!cancelled) publish({ source, failed: true });
    });

  return () => {
    cancelled = true;
    if (url !== undefined) URL.revokeObjectURL(url);
  };
}

export function MermaidDiagram({ source }: { source: string }): JSX.Element {
  const [result, setResult] = useState<DiagramResult>();

  useEffect(() => startDiagramRender(source, setResult), [source]);

  if (result?.source === source && result.failed) {
    return (
      <div>
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
        <p className="noctis-md-diagram-status">diagram could not be drawn</p>
      </div>
    );
  }

  return (
    <div
      className="noctis-md-diagram"
      aria-label="Mermaid diagram"
      aria-busy={result?.source !== source}
    >
      {result?.source === source && result.url ? (
        <img
          src={result.url}
          width={result.width}
          height={result.height}
          alt="Mermaid diagram"
          onError={() => setResult({ source, failed: true })}
        />
      ) : (
        <span className="noctis-md-diagram-status">Drawing diagram…</span>
      )}
    </div>
  );
}
