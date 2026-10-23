import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Markdown } from "./Markdown.js";
import { MarkdownFiles, markdownImageUrl } from "./MarkdownFiles.js";
import type { ConversationState } from "./useConversation.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { Threads } from "../pages/Threads.js";
import { ThreadPanels, useThreadPanels } from "../pages/ThreadPanels.js";
import { resolveSurface } from "../surfaces/registry.js";
import { renderSurface } from "../surfaces/renderers.js";

vi.mock("../workbench/Workbench.js", () => ({
  Workbench: () =>
    renderSurface(
      resolveSurface(
        "document",
        1,
        {
          title: "Screenshots",
          format: "markdown",
          content: { from: "inline", text: "![panel screenshot](C:/repo/shots/panel.png)" },
        },
        "standard",
        [],
      ),
    ),
}));

describe("Markdown images", () => {
  it("shows alt text when no file resolver is provided", () => {
    const markup = renderToStaticMarkup(
      createElement(Markdown, { text: "![login screen](C:/repo/shots/login.png)" }),
    );

    expect(markup).not.toContain("<img");
    expect(markup).toContain("<span");
    expect(markup).toContain("login screen</span>");
  });

  it.each([
    "https://example.com/login.png",
    "http://example.com/login.png",
    "//example.com/login.png",
    "data:image/png;base64,AA==",
    "shots/login.png",
    "C:shots/login.png",
    "C:/repo/shots/login.svg",
  ])("shows alt text instead of a broken image for %s", (src) => {
    const markup = renderToStaticMarkup(createElement(Markdown, { text: `![preview](${src})` }));

    expect(markup).not.toContain("<img");
    expect(markup).toContain("preview</span>");
  });

  it.each([
    "C:/repo/shots/login.png",
    String.raw`C:\repo\shots\login.JPG`,
    "/repo/shots/login.jpeg",
    "/repo/shots/login.gif",
    "/repo/shots/login.webp",
  ])("resolves an absolute raster image through context: %s", (src) => {
    const imageUrl = vi.fn(() => "/files/content?image=resolved");
    const markup = renderToStaticMarkup(
      createElement(
        MarkdownFiles.Provider,
        { value: imageUrl },
        createElement(Markdown, { text: `![login screen](${src})` }),
      ),
    );

    expect(imageUrl).toHaveBeenCalledWith(src);
    expect(markup).toContain('src="/files/content?image=resolved"');
    expect(markup).toContain('alt="login screen"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('style="max-width:100%"');
  });

  it("never asks the resolver for remote, blob or SVG sources", () => {
    const imageUrl = vi.fn(() => "/must-not-load");
    const markup = renderToStaticMarkup(
      createElement(
        MarkdownFiles.Provider,
        { value: imageUrl },
        createElement(Markdown, {
          text: "![remote](https://example.com/a.png) ![blob](blob:preview/a.png) ![vector](/repo/a.svg)",
        }),
      ),
    );

    expect(imageUrl).not.toHaveBeenCalled();
    expect(markup).not.toContain("<img");
  });

  it.each(["docs/health/day.png", "./shots/a.webp", "../art/b.jpg"])(
    "lets the context resolve a relative source: %s",
    (src) => {
      const imageUrl = vi.fn(() => "/resolved-image");
      const markup = renderToStaticMarkup(
        createElement(
          MarkdownFiles.Provider,
          { value: imageUrl },
          createElement(Markdown, { text: `![preview](${src})` }),
        ),
      );

      expect(imageUrl).toHaveBeenCalledWith(src);
      expect(markup).toContain('src="/resolved-image"');
    },
  );

  it("removes URL queries and fragments from the file path", () => {
    const imageUrl = vi.fn(() => "/resolved-image");
    const markup = renderToStaticMarkup(
      createElement(
        MarkdownFiles.Provider,
        { value: imageUrl },
        createElement(Markdown, { text: "![preview](shots/a.PNG?version=2#large)" }),
      ),
    );

    expect(imageUrl).toHaveBeenCalledWith("shots/a.PNG");
    expect(markup).toContain('src="/resolved-image"');
  });

  it("keeps unresolved alt text muted and escaped", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MarkdownFiles.Provider,
        { value: () => undefined },
        createElement(Markdown, { text: "![missing & unavailable](/repo/login.png)" }),
      ),
    );

    expect(markup).not.toContain("<img");
    expect(markup).toContain("missing &amp; unavailable</span>");
    expect(markup).toContain("color:");
  });
});

describe("Markdown file URLs", () => {
  const roots = [
    { nodeId: "first", grantId: "elsewhere", path: "C:/other" },
    { nodeId: "first", grantId: "also-elsewhere", path: "D:/other" },
    { nodeId: "second", grantId: "repo", path: "C:\\repo" },
    { nodeId: "linux", grantId: "linux-repo", path: "/repo" },
  ];

  it("tries every node and encodes the matched grant and relative path", () => {
    const contentUrl = vi.fn((path: string) => `https://core.example${path}`);
    const url = markdownImageUrl("c:/REPO/shots/login screen.PNG", roots, { contentUrl });

    expect(url).toBe(
      "https://core.example/files/content?node=second&root=repo&path=shots%2Flogin+screen.PNG",
    );
    expect(contentUrl).toHaveBeenCalledOnce();
  });

  it("resolves POSIX paths case sensitively", () => {
    const transport = { contentUrl: (path: string) => path };
    expect(markdownImageUrl("/repo/shots/login.png", roots, transport)).toBe(
      "/files/content?node=linux&root=linux-repo&path=shots%2Flogin.png",
    );
    expect(markdownImageUrl("/REPO/shots/login.png", roots, transport)).toBeUndefined();
  });

  it.each([
    "C:/repo/../private/login.png",
    String.raw`C:\repo\shots\..\login.png`,
    "/repo/shots/../../private/login.png",
    "/repo/shots/login..png",
    "/repo-other/login.png",
    "shots/login.png",
  ])("does not build a content URL outside the allowed path: %s", (path) => {
    const contentUrl = vi.fn((path: string) => path);

    expect(markdownImageUrl(path, roots, { contentUrl })).toBeUndefined();
    expect(contentUrl).not.toHaveBeenCalled();
  });

  it("resolves nothing without roots or a content-capable transport", () => {
    expect(
      markdownImageUrl("/repo/login.png", [], { contentUrl: (path: string) => path }),
    ).toBeUndefined();
    expect(markdownImageUrl("/repo/login.png", roots, undefined)).toBeUndefined();
    expect(markdownImageUrl("/repo/login.png", roots, {})).toBeUndefined();
  });

  it("refuses relative paths even when a root is relative", () => {
    const contentUrl = vi.fn((path: string) => path);
    expect(
      markdownImageUrl("repo/shots/a.png", [{ nodeId: "work", grantId: "repo", path: "repo" }], {
        contentUrl,
      }),
    ).toBeUndefined();
    expect(contentUrl).not.toHaveBeenCalled();
  });
});

describe("Markdown file providers", () => {
  const conversation: ConversationState = {
    thread: undefined,
    panelsRevision: 0,
    presencePanelsRevision: 0,
    messages: [
      {
        id: "message",
        threadId: "thread",
        role: "identity",
        body: "![saved](C:/repo/shots/saved.png)",
        createdAt: "2026-10-16T12:00:00Z",
      },
    ],
    turns: [],
    streaming: new Map([["stream", "![streamed](C:/repo/shots/streamed.png)"]]),
    partialReplies: new Map(),
    pendingApprovals: [],
    models: [],
    defaultModel: undefined,
    roots: [
      {
        nodeId: "work",
        grantId: "repo",
        path: "C:/repo",
        mode: "read",
        localOnly: false,
        hostId: "host",
        connected: true,
      },
    ],
    offlineRetry: undefined,
    canAttach: false,
    children: [],
    outputUrl: undefined,
    error: undefined,
    send: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    startFresh: () => Promise.resolve(),
    startFreshIfIdle: () => Promise.resolve(),
    confirm: () => Promise.resolve(),
    decline: () => Promise.resolve(),
    retryElsewhere: () => Promise.resolve(),
  };
  const transport: CoreTransport = {
    request: () => Promise.resolve({ status: 200, body: {} }),
    subscribe: () => Promise.resolve({ close: () => undefined }),
    contentUrl: (path) => `/core${path}`,
  };

  it("resolves images in saved and streaming conversation messages", () => {
    const markup = renderToStaticMarkup(
      createElement(Threads, {
        identityId: "vesper",
        conversation,
        connected: true,
        transport,
      }),
    );

    expect(markup).toContain(
      "/core/files/content?node=work&amp;root=repo&amp;path=shots%2Fsaved.png",
    );
    expect(markup).toContain(
      "/core/files/content?node=work&amp;root=repo&amp;path=shots%2Fstreamed.png",
    );
  });

  it.each([false, true])("resolves document panel images with mobile=%s", (mobile) => {
    function Panels(): JSX.Element {
      const panels = useThreadPanels(transport, conversation);
      return createElement(ThreadPanels, {
        mobile,
        panels: {
          ...panels,
          hasPanels: true,
          sources: [
            {
              owner: "thread",
              composition: {
                ...panels.sources[0]!.composition,
                plan: {
                  threadId: "thread",
                  layoutId: "layout",
                  displayFingerprint: "display",
                  slots: [
                    {
                      surfaceId: "document",
                      region: "overlay",
                      order: 0,
                      size: "standard",
                      layer: 0,
                    },
                  ],
                  overflowSurfaceIds: [],
                  reasonCodes: [],
                  generatedAt: "2026-10-16T12:00:00Z",
                },
              },
            },
          ],
        },
      });
    }
    const markup = renderToStaticMarkup(createElement(Panels));

    expect(markup).toContain('class="document-panel"');
    expect(markup).toContain(
      "/core/files/content?node=work&amp;root=repo&amp;path=shots%2Fpanel.png",
    );
  });
});
