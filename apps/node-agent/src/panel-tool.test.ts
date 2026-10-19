import { PAGE_PANEL_PAGES } from "@noctis/contracts";
import { expect, it } from "vitest";

import { PANEL_TOOL_DESCRIPTION } from "./panel-tool.js";

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
