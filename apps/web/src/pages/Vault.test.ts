import type { VaultSphereNode } from "@noctis/ui";
import { expect, it } from "vitest";

import { firstDrawnHit } from "./Vault.js";

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
