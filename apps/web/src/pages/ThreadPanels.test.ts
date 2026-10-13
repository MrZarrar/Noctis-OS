import { describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../conversation/useConversation.js";
import type { CompositionState } from "../workbench/useComposition.js";
import { panelsForOwner, sendPanelChoice } from "./ThreadPanels.js";
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
  it("sends choices to the owning conversation and rejects other owners", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const conversation = {
      thread: { id: "owning-thread", objectiveId: "owning-objective" },
      send,
    } as unknown as ConversationState;
    await sendPanelChoice(conversation, "Use Alpha", { threadId: "owning-thread" });
    await sendPanelChoice(conversation, "Compare", { objectiveId: "owning-objective" });
    expect(send.mock.calls).toEqual([["Use Alpha"], ["Compare"]]);
    for (const owner of [
      { threadId: "foreign-thread" },
      { objectiveId: "foreign-objective" },
      { presence: true as const },
    ]) {
      await expect(sendPanelChoice(conversation, "Wrong", owner)).rejects.toThrow(
        "Open the panel's conversation",
      );
    }
    expect(send).toHaveBeenCalledTimes(2);
  });
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
