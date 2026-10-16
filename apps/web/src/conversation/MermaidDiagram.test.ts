import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { depth, identityAccent, material, typography } from "@noctis/ui";
import type { MermaidConfig } from "mermaid";
import {
  MermaidDiagram,
  diagramDimensions,
  renderMermaid,
  startDiagramRender,
} from "./MermaidDiagram.js";

const mermaid = vi.hoisted(() => ({
  loaded: vi.fn(),
  initialize: vi.fn<(config: MermaidConfig) => void>(),
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));

vi.mock("mermaid", () => {
  mermaid.loaded();
  return { default: mermaid };
});

describe("Mermaid rendering", () => {
  it("does not load the renderer while producing static markup", () => {
    const markup = renderToStaticMarkup(
      createElement(MermaidDiagram, { source: "flowchart LR; A-->B" }),
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("<svg");
    expect(mermaid.loaded).not.toHaveBeenCalled();
  });

  it("lazily initializes strict SVG labels with Noctis theme tokens and returns SVG", async () => {
    mermaid.render.mockResolvedValueOnce({ svg: '<svg xmlns="http://www.w3.org/2000/svg" />' });

    expect(await renderMermaid("flowchart LR; A-->B")).toContain("<svg");
    expect(mermaid.loaded).toHaveBeenCalledOnce();
    expect(mermaid.initialize.mock.calls[0]?.[0]).toMatchObject({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: "base",
      themeVariables: {
        background: depth.layers[1],
        primaryTextColor: typography.color.primary,
        primaryBorderColor: identityAccent.vesper.primary,
        clusterBorder: material.highlight,
      },
    });
    expect(mermaid.initialize.mock.calls[0]?.[0].secure).toEqual(
      expect.arrayContaining(["securityLevel", "htmlLabels", "flowchart"]),
    );
    expect(mermaid.render).toHaveBeenLastCalledWith(
      expect.stringMatching(/^noctis-mermaid-\d+$/),
      "flowchart LR; A-->B",
    );
  });

  it("gives simultaneous diagrams distinct IDs without initializing again", async () => {
    mermaid.render.mockResolvedValue({ svg: "<svg />" });

    await Promise.all([renderMermaid("flowchart LR; C-->D"), renderMermaid("flowchart LR; E-->F")]);

    const calls = mermaid.render.mock.calls.slice(-2);
    expect(calls[0]?.[0]).not.toBe(calls[1]?.[0]);
    expect(mermaid.initialize).toHaveBeenCalledOnce();
  });

  it("passes parse failures back to the component for its source fallback", async () => {
    mermaid.render.mockRejectedValueOnce(new Error("Parse error"));

    await expect(renderMermaid("flowchart LR; A -->")).rejects.toThrow("Parse error");
  });

  it("keeps a wide diagram's dimensions so its viewport can scroll", () => {
    expect(diagramDimensions('<svg viewBox="-8 -8 1600 240"><text>Wide</text></svg>')).toEqual({
      width: 1600,
      height: 240,
    });
    expect(diagramDimensions('<svg viewBox="0 0 0 240" />')).toEqual({});
    expect(diagramDimensions('<svg><text>viewBox="0 0 9 9"</text></svg>')).toEqual({});
  });

  it("publishes a blob image and revokes it on cleanup", async () => {
    const svg = '<svg viewBox="0 0 1600 240" />';
    mermaid.render.mockResolvedValueOnce({ svg });
    const publish = vi.fn();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const stop = startDiagramRender("flowchart LR; A-->B", publish);

    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const result = publish.mock.calls[0]?.[0] as { url: string };
    const response = await fetch(result.url);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(await response.text()).toBe(svg);
    expect(publish).toHaveBeenCalledWith({
      source: "flowchart LR; A-->B",
      url: result.url,
      width: 1600,
      height: 240,
    });
    stop();
    expect(revoke).toHaveBeenCalledWith(result.url);
    revoke.mockRestore();
  });

  it("discards a stale render after cleanup without creating a blob", async () => {
    let finish: ((value: { svg: string }) => void) | undefined;
    mermaid.render.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const publish = vi.fn();
    const create = vi.spyOn(URL, "createObjectURL");
    const stop = startDiagramRender("old source", publish);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    stop();
    finish?.({ svg: "<svg />" });
    await mermaid.render.mock.results.at(-1)?.value;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(publish).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });

  it("publishes a source fallback after rendering fails", async () => {
    mermaid.render.mockRejectedValueOnce(new Error("Parse error"));
    const publish = vi.fn();
    const stop = startDiagramRender("flowchart LR; A -->", publish);

    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith({ source: "flowchart LR; A -->", failed: true }),
    );
    stop();
  });
});
