/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { MOBILE_QUERY } from "../layout/useIsMobile.js";

import { renderSurface } from "./renderers.js";

import { REGISTRY, resolveSurface } from "./registry.js";

const CONVERSATION = { messages: [{ id: "m1", author: "Vesper", text: "Ready." }] };

describe("options panels", () => {
  const image = { from: "file", nodeId: "work", grantId: "screens", relativePath: "anker.png" };
  const payload = {
    title: "Three cables under £10",
    options: [
      {
        id: "anker",
        title: "Anker USB-C cable",
        price: "£8.99",
        detail: "60W charging, 1 metre",
        image,
        url: "https://amazon.co.uk/cable?colour=black",
        action: { label: "Add Anker", message: "Add option anker to my basket" },
      },
    ],
    actions: [{ label: "Find more", message: "Find more cables" }],
  };
  const render = (context = {}, value = payload) =>
    renderToStaticMarkup(
      createElement(
        "div",
        null,
        renderSurface(resolveSurface("options", 1, value, "standard"), context),
      ),
    );

  it.each(["compact", "standard", "wide", "stage"] as const)(
    "resolves at %s with its payload title and no capability",
    (size) => {
      expect(resolveSurface("options", 1, payload, size)).toMatchObject({
        status: "ok",
        title: payload.title,
      });
    },
  );

  it("renders file screenshots through the media handoff with the content revision", () => {
    const html = render({
      contentRevision: "revision-2",
      mediaUrl: (source: unknown, revision: string) => {
        expect(source).toEqual(image);
        expect(revision).toBe("revision-2");
        return "/files/content?preview=anker";
      },
    });
    expect(html).toContain('src="/files/content?preview=anker"');
    expect(html).toContain("Anker USB-C cable");
    expect(html).toContain("£8.99");
    expect(html).toContain("60W charging, 1 metre");
  });

  it("offers inspectable listing links and a calm fallback without a media URL", () => {
    const html = render();
    expect(html).toContain("amazon.co.uk");
    expect(html).toContain(`title="${payload.options[0]!.url}"`);
    expect(html).toContain(`aria-label="Open listing: ${payload.options[0]!.url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("View address");
    expect(html).toContain("Screenshot unavailable");
    expect(html).not.toContain("<img");
  });

  it("requires both the owner and handoff and honours action disabled and error state", () => {
    for (const context of [
      {},
      { onPanelAction: () => undefined },
      { panelOwner: { threadId: "owner" } },
    ]) {
      expect(render(context)).toMatch(/<button[^>]*disabled[^>]*>Add Anker<\/button>/);
    }
    const context = { panelOwner: { threadId: "owner" }, onPanelAction: () => undefined };
    expect(render(context)).toContain("Add Anker</button>");
    expect(render(context)).not.toContain("disabled");
    expect(render({ ...context, panelActionsDisabled: true })).toMatch(
      /<button[^>]*disabled[^>]*>Add Anker<\/button>/,
    );
    expect(render({ ...context, panelActionsError: "Could not send choice" })).toContain(
      "Could not send choice",
    );
    expect(render(context)).toContain("Find more</button>");
  });

  it.each(["javascript:alert(1)", "data:text/html,test", "ftp://example.com/a", "not a URL"])(
    "checks unsafe links again at the rendering edge: %s",
    (url) => {
      const html = renderToStaticMarkup(
        createElement(
          "div",
          null,
          renderSurface({
            status: "ok",
            kind: "options",
            title: payload.title,
            payload: { ...payload, options: [{ ...payload.options[0], url }] },
          }),
        ),
      );
      expect(html).not.toContain("<a ");
    },
  );

  it("rejects malformed options at the registry gate", () => {
    for (const options of [[], Array(9).fill(payload.options[0]), [{ id: "a" }]]) {
      expect(resolveSurface("options", 1, { ...payload, options }, "standard").status).toBe(
        "fallback",
      );
    }
  });

  it("uses the shell's phone breakpoint for stacked cards", () => {
    expect(readFileSync(new URL("./options.css", import.meta.url), "utf8")).toContain(
      `@media ${MOBILE_QUERY}`,
    );
  });

  it("retains accepted bytes independently for each screenshot across remounts", () => {
    const value = {
      ...payload,
      options: [
        payload.options[0]!,
        {
          ...payload.options[0]!,
          id: "belkin",
          title: "Belkin cable",
          image: { ...image, relativePath: "belkin.png" },
        },
      ],
    };
    const cache = new Map(
      value.options.map((option, index) => {
        const id = JSON.stringify(["panel", option.id, index]);
        return [
          id,
          {
            key: JSON.stringify([`/files/${option.image.relativePath}?revision=old`, id]),
            url: `blob:accepted-${option.id}`,
          },
        ];
      }),
    );
    const context = {
      fileMedia: { cache, surfaceId: "panel" },
      mediaUrl: (source: typeof image, revision: string) =>
        `/files/${source.relativePath}?revision=${revision}`,
      contentRevision: "old",
    };
    for (let mount = 0; mount < 2; mount++) {
      const html = render(context, value);
      expect(html).toContain('src="blob:accepted-anker"');
      expect(html).toContain('src="blob:accepted-belkin"');
    }
    const updated = render({ ...context, contentRevision: "new" }, value);
    expect(updated).not.toContain('src="blob:accepted-');
  });

  it("keeps distinct screenshots for valid options sharing an ID", () => {
    const value = {
      ...payload,
      options: [
        payload.options[0]!,
        {
          ...payload.options[0]!,
          title: "Another cable",
          image: { ...image, relativePath: "other.png" },
        },
      ],
    };
    const cache = new Map(
      value.options.map((option, index) => {
        const id = JSON.stringify(["panel", option.id, index]);
        return [
          id,
          {
            key: JSON.stringify([`/files/${option.image.relativePath}`, id]),
            url: `blob:accepted-${index}`,
          },
        ];
      }),
    );
    const html = render(
      {
        fileMedia: { cache, surfaceId: "panel" },
        mediaUrl: (source: typeof image) => `/files/${source.relativePath}`,
      },
      value,
    );
    expect(html).toContain('src="blob:accepted-0"');
    expect(html).toContain('src="blob:accepted-1"');
  });
});

describe("read-only work panels", () => {
  const document = {
    title: "Plan",
    format: "markdown",
    content: {
      from: "inline",
      text: "# Plan\n- [ ] first step\n\n<script>alert(1)</script>\n\n`code`",
    },
  };
  it.each([
    ["document", document],
    [
      "timeline",
      {
        title: "Today",
        items: [{ id: "a", start: "09:00", end: "10:00", label: "Build", due: true }],
      },
    ],
    [
      "verification",
      {
        title: "Checks",
        items: [{ id: "a", claim: "Build works", status: "verified", reason: "Tests pass" }],
      },
    ],
  ])("resolves and renders %s with its title", (kind, payload) => {
    const resolved = resolveSurface(kind, 1, payload, "compact");
    expect(resolved).toMatchObject({ status: "ok", title: (payload as { title: string }).title });
    expect(renderToStaticMarkup(createElement("div", null, renderSurface(resolved)))).not.toContain(
      "could not be rendered",
    );
  });
  it("renders document Markdown safely with a read-only checkbox", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        renderSurface(resolveSurface("document", 1, document, "standard")),
      ),
    );
    expect(html).toContain("<h1");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
    expect(html).toContain("<code>code</code>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script");
  });
  it("preserves shortlist details beside message choices", () => {
    const resolved = resolveSurface(
      "list",
      1,
      {
        items: [{ id: "a", label: "Alpha", detail: "Fits the deadline" }],
        actions: [{ label: "Use Alpha", message: "Use Alpha" }],
      },
      "standard",
    );
    const html = renderToStaticMarkup(createElement("div", null, renderSurface(resolved)));
    expect(html).toContain("Fits the deadline");
  });
  it.each(["list", "detail", "evidence", "attention", "document", "timeline", "verification"])(
    "renders message actions for %s only with a host handoff",
    (kind) => {
      const payloads = {
        list: { items: [] },
        detail: { fields: [] },
        evidence: { items: [] },
        attention: { headline: "Wait", detail: "Review" },
        document,
        timeline: { title: "Today", items: [] },
        verification: { title: "Checks", items: [] },
      };
      const payload = {
        ...payloads[kind as keyof typeof payloads],
        actions: [{ label: "Use option A", message: "I choose A" }],
      };
      const resolved = resolveSurface(kind, 1, payload, "standard");
      expect(resolved.status).toBe("ok");
      const render = (context = {}) =>
        renderToStaticMarkup(
          createElement(
            "div",
            null,
            renderSurface(resolved, { panelOwner: { threadId: "owning-thread" }, ...context }),
          ),
        );
      expect(render({ onPanelAction: () => undefined })).toContain("Use option A</button>");
      expect(render()).toContain("disabled");
      expect(render({ onPanelAction: () => undefined, panelActionsDisabled: true })).toContain(
        "disabled",
      );
    },
  );
});

describe("media panels", () => {
  const payload = {
    title: "A photo",
    mediaType: "image/png",
    source: { from: "attachment", attachmentId: "01941f29-7c00-7000-8000-000000000001" },
  };

  it("resolves a media payload from an attachment with its validated title", () => {
    expect(resolveSurface("media", 1, { ...payload, title: " A photo " }, "compact")).toMatchObject(
      { status: "ok", title: "A photo" },
    );
  });

  it.each(["../x", "..\\x"])("refuses an escaping relative path %s", (relativePath) => {
    expect(
      resolveSurface(
        "media",
        1,
        { ...payload, source: { from: "file", nodeId: "work", grantId: "grant", relativePath } },
        "standard",
      ).status,
    ).toBe("fallback");
  });

  it("renders a media Surface with no mediaUrl as text, not a broken image", () => {
    const resolved = resolveSurface("media", 1, payload, "standard");
    expect(resolved.status).toBe("ok");
    const html = renderToStaticMarkup(createElement("div", null, renderSurface(resolved)));
    expect(html).toContain("This file opens from Threads");
    expect(html).not.toContain("<img");
  });

  it("hands the source to mediaUrl and the compact size to the renderer", () => {
    const resolved = resolveSurface("media", 1, payload, "compact");
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        renderSurface(
          resolved,
          {
            mediaUrl: (source) => {
              expect(source).toEqual(payload.source);
              return "/output/photo";
            },
          },
          "compact",
        ),
      ),
    );
    expect(html).toContain('src="/output/photo"');
    expect(html).toContain("max-height:96px");
  });
});

describe("the Surface registry", () => {
  it("resolves a registered kind whose payload matches its schema", () => {
    const resolved = resolveSurface("conversation", 1, CONVERSATION, "wide");

    expect(resolved.status).toBe("ok");
  });

  /**
   * The example used to be `native_application`, which Phase 9 registered. A
   * test for "nothing registered this" needs a kind nothing ever will.
   */
  it("falls back for a kind nothing registered", () => {
    const resolved = resolveSurface("haruspicy", 1, {}, "wide");

    expect(resolved).toEqual({
      status: "fallback",
      kind: "haruspicy",
      reason: "no renderer is registered for this kind",
    });
  });

  it("falls back rather than rendering a payload from another version", () => {
    const resolved = resolveSurface("conversation", 2, CONVERSATION, "wide");

    expect(resolved.status).toBe("fallback");
  });

  it("falls back for a size the renderer does not support", () => {
    const resolved = resolveSurface("conversation", 1, CONVERSATION, "compact");

    expect(resolved.status).toBe("fallback");
  });

  it("THE GATE: a malformed payload degrades to the fallback instead of throwing", () => {
    for (const payload of [null, "text", 7, [], {}, { messages: [{ id: "m1" }] }]) {
      expect(resolveSurface("conversation", 1, payload, "wide").status).toBe("fallback");
    }
  });

  it("refuses a payload carrying unknown fields", () => {
    const resolved = resolveSurface(
      "detail",
      1,
      { fields: [], region: "centre", x: 10 },
      "standard",
    );

    expect(resolved.status).toBe("fallback");
  });

  it("declares a schema, a version, and at least one size for every kind", () => {
    for (const [kind, entry] of Object.entries(REGISTRY)) {
      expect(entry.payloadVersion, kind).toBeGreaterThan(0);
      expect(entry.sizes.length, kind).toBeGreaterThan(0);
      expect(entry.title.length, kind).toBeGreaterThan(0);
    }
  });
});

describe("THE GATE: a Surface cannot show what the caller may not see", () => {
  const approval = {
    id: "01941f29-7c00-7000-8000-000000000001",
    consequenceSummary: "Publish the listing",
    operationClass: "publish",
    capability: "vinted.publish",
    targetType: "listing",
    targetId: "vinted-4821",
    reversibility: "partially_reversible" as const,
    outcome: "require_confirmation" as const,
    reasonCodes: ["operation_class_default"],
  };

  it("falls back when the caller does not hold the capability the Surface requires", () => {
    const resolved = resolveSurface("approval", 1, approval, "standard", []);

    expect(resolved.status).toBe("fallback");
    expect(resolved.status === "fallback" && resolved.reason).toContain("authority.approve");
  });

  it("renders it for a caller who does", () => {
    const resolved = resolveSurface("approval", 1, approval, "standard", ["authority.approve"]);

    expect(resolved.status).toBe("ok");
  });

  it("refuses to squeeze an approval into a compact Surface", () => {
    // Not a style rule. A consequence boundary too small to show its target is
    // one that gets approved without being read.
    const resolved = resolveSurface("approval", 1, approval, "compact", ["authority.approve"]);

    expect(resolved.status).toBe("fallback");
  });

  it("leaves every Surface that gates nothing reachable without a capability", () => {
    const ungated = Object.entries(REGISTRY).filter(([, entry]) => !("requires" in entry));

    expect(ungated.length).toBeGreaterThan(0);

    for (const [kind] of ungated) {
      // Passing no capabilities must not turn an ungated Surface into a
      // fallback; only a payload or a size may do that.
      const resolved = resolveSurface(kind, 1, {}, "standard", []);

      expect(resolved.status === "fallback" ? resolved.reason : "ok").not.toContain("capability");
    }
  });
});

describe("the native application Surface", () => {
  const FOCUS = {
    applications: [
      {
        applicationId: "vscode",
        displayName: "Visual Studio Code",
        intendedMonitor: "primary",
        intendedRegion: "left_two_thirds",
        state: { kind: "notRunning" },
      },
    ],
  };

  it("resolves with the window.place capability", () => {
    const resolved = resolveSurface("native_application", 1, FOCUS, "wide", ["window.place"]);

    expect(resolved.status).toBe("ok");
  });

  /**
   * THE GATE: a page with no desktop shell behind it cannot place a window, and
   * the honest answer is a fallback that says why rather than a Surface whose
   * buttons would all fail.
   */
  it("falls back without it, which is what a browser gets", () => {
    const resolved = resolveSurface("native_application", 1, FOCUS, "wide", []);

    expect(resolved.status).toBe("fallback");
    expect(resolved.status === "fallback" ? resolved.reason : "").toContain("window.place");
  });

  /**
   * THE GATE: the payload carries the state the shell reported, and a state the
   * schema does not know must not render as though it were understood.
   */
  it("refuses a state nothing in the contract describes", () => {
    const invented = {
      applications: [{ ...FOCUS.applications[0], state: { kind: "probably_fine" } }],
    };

    expect(resolveSurface("native_application", 1, invented, "wide", ["window.place"]).status).toBe(
      "fallback",
    );
  });

  it("refuses a placed state that cannot say where it was placed", () => {
    const missingPlacement = {
      applications: [
        { ...FOCUS.applications[0], state: { kind: "placed", windowTitle: "Noctis-OS" } },
      ],
    };

    expect(
      resolveSurface("native_application", 1, missingPlacement, "wide", ["window.place"]).status,
    ).toBe("fallback");
  });

  /** Never compact: the state, the intended region, and the reason they differ. */
  it("refuses the compact size", () => {
    expect(resolveSurface("native_application", 1, FOCUS, "compact", ["window.place"]).status).toBe(
      "fallback",
    );
  });

  it("refuses a payload with no applications in it at all", () => {
    expect(
      resolveSurface("native_application", 1, { applications: [] }, "wide", ["window.place"])
        .status,
    ).toBe("fallback");
  });
});

describe("live briefs", () => {
  const brief = {
    title: "Vesper",
    runtime: "Codex",
    activity: "Nightly backup",
    status: "running",
    startedAt: "2026-09-01T11:56:00.000Z",
  };

  it("resolves at compact size, titled by who is working", () => {
    expect(resolveSurface("live_brief", 1, brief, "compact")).toMatchObject({
      status: "ok",
      title: "Vesper",
    });
  });

  it("falls back when a brief carries anything beyond its fields", () => {
    expect(resolveSurface("live_brief", 1, { ...brief, prompt: "x" }, "compact").status).toBe(
      "fallback",
    );
  });

  it("renders what is running, on what, and for how long", () => {
    const markup = renderToStaticMarkup(
      createElement("div", null, renderSurface(resolveSurface("live_brief", 1, brief, "compact"))),
    );
    expect(markup).toContain("Nightly backup");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Running · ");
    expect(markup).toContain('dateTime="2026-09-01T11:56:00.000Z"');
  });
});

describe("visual panels", () => {
  const payload = {
    title: "Rate limiter",
    source: { from: "file", nodeId: "node-1", grantId: "grant-1", relativePath: "figs/a.html" },
  };

  it("runs the agent's page in a sandboxed frame that cannot reach Noctis", () => {
    const resolved = resolveSurface("visual", 1, payload, "standard");
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        null,
        renderSurface(resolved, {
          visualUrl: (source) => `/visuals/content?path=${source.relativePath}`,
        }),
      ),
    );

    expect(resolved).toMatchObject({ status: "ok", title: "Rate limiter" });
    expect(markup).toMatch(/<iframe[^>]*sandbox="allow-scripts"/);
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).toContain('src="/visuals/content?path=figs/a.html"');
  });
});
