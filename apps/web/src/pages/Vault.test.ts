import type { VaultSphereNode } from "@noctis/ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { VaultNote, firstDrawnHit } from "./Vault.js";

const nodes: VaultSphereNode[] = [
  { id: "agent", name: "Agent", type: "agent" },
  { id: "partial", name: "Partial", type: "note", x: 0, y: 0 },
  { id: "note", name: "Note", type: "note", x: 0, y: 0, z: 0 },
  { id: "other", name: "Other", type: "note", x: 1, y: 2, z: 3 },
];

it("skips recall hits absent from the drawn graph, including nodes without coordinates", () => {
  expect(firstDrawnHit(["agent", "missing", "partial", "note"], nodes)).toBe("note");
  expect(firstDrawnHit(["agent", "missing", "partial"], nodes)).toBeUndefined();
  expect(firstDrawnHit([], nodes)).toBeUndefined();
  expect(firstDrawnHit(["other", "note"], nodes)).toBe("other");
});

const note = (state: Parameters<typeof VaultNote>[0]["state"]): string =>
  renderToStaticMarkup(createElement(VaultNote, { name: "Tolga", state }));

it("shows the opened node's note as Markdown, with where it lives", () => {
  const markup = note({
    kind: "note",
    path: "people/tolga.md",
    text: "Runs the **Istanbul** office.",
  });

  expect(markup).toContain("people/tolga.md");
  expect(markup).toContain("<strong>Istanbul</strong>");
});

it("says plainly when a name has no note behind it", () => {
  expect(note({ kind: "none" })).toContain("No note has been written for Tolga yet");
});
