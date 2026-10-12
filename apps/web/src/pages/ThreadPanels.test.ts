import { describe, expect, it } from "vitest";
import type { CompositionState } from "../workbench/useComposition.js";
import { panelsForOwner } from "./ThreadPanels.js";
const source = {
  intents: [
    { id: "conversation", kind: "conversation", lifecycle: "active" },
    { id: "proposal", kind: "detail", lifecycle: "active" },
  ],
  plan: {
    slots: [{ surfaceId: "conversation" }, { surfaceId: "proposal" }],
    overflowSurfaceIds: ["conversation", "proposal"],
  },
} as unknown as CompositionState;
describe("panelsForOwner", () => {
  it("omits only the Objective transcript from rendering without changing intents or stored plan", () => {
    const view = panelsForOwner(source, "objective");
    expect(view.plan?.slots.map((slot) => slot.surfaceId)).toEqual(["proposal"]);
    expect(view.plan?.overflowSurfaceIds).toEqual(["proposal"]);
    expect(view.intents).toBe(source.intents);
    expect(source.plan?.slots).toHaveLength(2);
    expect(source.intents[0]?.lifecycle).toBe("active");
  });
  it("keeps thread-owned slots intact", () => {
    expect(panelsForOwner(source, "thread").plan).toEqual(source.plan);
    expect(panelsForOwner({ ...source, plan: undefined }, "objective").plan).toBeUndefined();
  });
});
