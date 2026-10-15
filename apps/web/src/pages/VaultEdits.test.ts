import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import type { VaultEdit } from "./VaultEdits.js";
import { VaultEdits } from "./VaultEdits.js";

const fact: VaultEdit = {
  id: "0199a000-0000-7000-8000-0000000000a1",
  kind: "fact",
  path: "people/tolga.md",
  source: "inbox/t.md",
  text: "Moved to **Istanbul**.",
  status: "applied",
  createdAt: "2026-10-13T03:00:00Z",
};

const render = (edits: VaultEdit[]): string =>
  renderToStaticMarkup(
    createElement(VaultEdits, {
      edits,
      onUndo: () => undefined,
      onApply: () => undefined,
      onDecline: () => undefined,
    }),
  );

it("offers Undo on a filed fact and Apply or Decline on a waiting change", () => {
  const markup = render([
    fact,
    {
      ...fact,
      id: "b",
      kind: "revision",
      text: "London",
      replaceText: "Istanbul",
      status: "pending",
      reason: "moved",
    },
  ]);

  expect(markup).toContain(">Undo<");
  expect(markup).toContain(">Apply<");
  expect(markup).toContain(">Decline<");
  expect(markup).toContain("people/tolga.md");
  expect(markup).toContain("From the inbox");
  expect(markup).toContain("inbox/t.md");
  expect(markup).toContain("<strong>Istanbul</strong>");
  expect(markup).toContain("Find");
  expect(markup).toContain("London");
  expect(markup).toContain("Replace with");
  expect(markup).toContain("Istanbul");
  expect(markup).not.toContain(fact.id);
});

it("shows the status and reason without actions for settled or refused edits", () => {
  for (const status of ["undone", "declined", "refused"] as const) {
    const markup = render([{ ...fact, status, reason: "The note has changed." }]);

    expect(markup).toContain(status);
    expect(markup).toContain("The note has changed.");
    expect(markup).not.toContain("<button");
  }
});

it("limits the newest-first API list to 50 edits", () => {
  const markup = render(
    Array.from({ length: 51 }, (_, index) => ({
      ...fact,
      id: String(index),
      path: `people/person-${String(index)}.md`,
    })),
  );

  expect(markup).toContain("people/person-0.md");
  expect(markup).toContain("people/person-49.md");
  expect(markup).not.toContain("people/person-50.md");
});
