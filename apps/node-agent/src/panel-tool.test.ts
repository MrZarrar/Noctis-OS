import { PAGE_PANEL_PAGES } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { PANEL_TOOL_DESCRIPTION, surfaceProblem } from "./panel-tool.js";

it("tells the agent it can open any Noctis page the owner can, such as the Vault", () => {
  expect(PANEL_TOOL_DESCRIPTION).toContain("page {page:");
  for (const page of PAGE_PANEL_PAGES) {
    expect(PANEL_TOOL_DESCRIPTION).toContain(`"${page}"`);
  }
});

it("describes the options panel, its pictures by path and its links", () => {
  expect(PANEL_TOOL_DESCRIPTION).toContain("options {title, options:");
  expect(PANEL_TOOL_DESCRIPTION).toContain("image: {path}");
  expect(PANEL_TOOL_DESCRIPTION).toContain("url");
});

it("keeps source files off panels unless the owner asks to see them", () => {
  expect(PANEL_TOOL_DESCRIPTION).toContain(
    "Source code and configuration edits stay off the canvas",
  );
  expect(PANEL_TOOL_DESCRIPTION).toContain("only when the owner asks to see them");
  expect(PANEL_TOOL_DESCRIPTION).toContain(".md, .txt, .csv and .tsv");
});

describe("checking a panel before it is recorded", () => {
  const base = { role: "primary", persistence: "restorable", priority: 50, payloadVersion: 1 };

  it("tells the agent what is wrong with an options panel in its own shape, so it can send it again", () => {
    const problem = surfaceProblem({
      ...base,
      surfaceKind: "options",
      payload: {
        title: "USB-C cables",
        options: [
          {
            id: "anker",
            title: "Anker",
            reason: "best",
            image: "C:\\shots\\anker.png",
            link: "https://www.amazon.co.uk/dp/X",
            action: "Add Anker to basket",
          },
        ],
      },
    });

    expect(problem).toContain("Not shown");
    expect(problem).toContain("options.0.image");
    expect(problem).toContain("options.0.action");
    expect(problem).toContain("reason");
  });

  it("passes a panel the core will show", () => {
    expect(
      surfaceProblem({
        ...base,
        surfaceKind: "options",
        payload: {
          title: "USB-C cables",
          options: [
            {
              id: "anker",
              title: "Anker",
              image: { path: "C:\\shots\\anker.png" },
              url: "https://www.amazon.co.uk/dp/X",
              action: { label: "Add to basket", message: "Add anker" },
            },
          ],
        },
      }),
    ).toBeUndefined();
    expect(
      surfaceProblem({ ...base, surfaceKind: "page", payload: { page: "Vault" } }),
    ).toBeUndefined();
    expect(
      surfaceProblem({
        ...base,
        surfaceKind: "document",
        payload: { title: "README", path: "C:\\r.md" },
      }),
    ).toBeUndefined();
    expect(
      surfaceProblem({
        ...base,
        surfaceKind: "document",
        payload: { title: "Source", path: "C:\\app.ts" },
      }),
    ).toBeUndefined();
  });

  it("refuses what the core would refuse: a kind agents cannot open, a page on a folder, a picture with no path", () => {
    expect(surfaceProblem({ ...base, surfaceKind: "approval", payload: {} })).toContain("approval");
    expect(
      surfaceProblem({
        ...base,
        surfaceKind: "page",
        payload: { page: "Files", folder: { nodeId: "n", grantId: "g", relativePath: "x" } },
      }),
    ).toContain("Not shown");
    expect(
      surfaceProblem({
        ...base,
        surfaceKind: "media",
        payload: { title: "x", mediaType: "image/png" },
      }),
    ).toContain("path");
  });
});
