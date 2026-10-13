import { describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../conversation/useConversation.js";
import type { CompositionState } from "../workbench/useComposition.js";
import {
  pagePanelContext,
  panelsForOwner,
  sendPanelChoice,
  type ThreadPanelsState,
} from "./ThreadPanels.js";
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
    expect(send.mock.calls).toEqual([
      ["Use Alpha", { threadId: "owning-thread" }],
      ["Compare", { threadId: "owning-thread" }],
    ]);
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

it("starts Files at the pinned node root or latest live file folder and Vault at validated recall", () => {
  const nodeId = "0199a000-0000-7000-8000-000000000001";
  const grantId = "0199a000-0000-7000-8000-000000000002";
  const media = (path: string, requestedAt: string, lifecycle = "active") => ({
    kind: "media",
    requestedAt,
    lifecycle,
    payload: {
      title: path,
      mediaType: "image/png",
      source: { from: "file", nodeId, grantId, relativePath: path },
    },
  });
  const panels = {
    sources: [
      {
        composition: {
          intents: [
            media("older/one.png", "2026-10-10"),
            media("latest/two.png", "2026-10-11"),
            media("closed/three.png", "2026-10-12", "dismissed"),
            {
              kind: "media",
              requestedAt: "2026-10-13",
              lifecycle: "active",
              payload: { source: { from: "file", relativePath: "../unsafe" } },
            },
            {
              kind: "vault_recall",
              requestedAt: "2026-10-13",
              lifecycle: "active",
              payload: {
                query: "Travel",
                freshness: "current",
                evidence: [
                  {
                    itemId: "item",
                    entityId: "travel-vogue",
                    path: "people/travel.md",
                    quote: "Travel",
                    freshness: "current",
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  } as unknown as ThreadPanelsState;
  const conversation = { roots: [{ nodeId, grantId }] } as unknown as ConversationState;
  expect(pagePanelContext(panels, conversation)).toEqual({
    contextFiles: { nodeId, grantId, relativePath: "latest" },
    focusId: "travel-vogue",
  });
  expect(
    pagePanelContext(panels, {
      ...conversation,
      thread: { nodeId, rootGrantId: grantId },
    } as ConversationState).contextFiles,
  ).toEqual({ nodeId, grantId, relativePath: "" });
  expect(pagePanelContext({ ...panels, sources: [] }, conversation)).toEqual({
    contextFiles: undefined,
    focusId: undefined,
  });
});
