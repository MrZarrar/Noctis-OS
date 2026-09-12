import type { ModelRef, RuntimeAuthMode, RuntimeProbe, RuntimeProviderId } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import type { ProviderCandidate } from "./route.js";
import { chooseProvider } from "./route.js";

const GPT: ModelRef = { providerId: "codex", model: "gpt-5-codex" };
const SONNET: ModelRef = { providerId: "claude", model: "claude-sonnet-4-5" };

function probe(
  providerId: RuntimeProviderId,
  authMode: RuntimeAuthMode,
  models: readonly ModelRef[],
  available = true,
): RuntimeProbe {
  return { providerId, available, authMode, models: [...models] };
}

/** Everything a node needs to be eligible; tests knock one thing out at a time. */
function node(
  nodeId: string,
  p: RuntimeProbe,
  over: Partial<ProviderCandidate> = {},
): ProviderCandidate {
  return {
    nodeId,
    hostId: `host-${nodeId}`,
    connected: true,
    granted: true,
    hasRoots: true,
    probe: p,
    ...over,
  };
}

describe("chooseProvider", () => {
  it("selects the node offering the requested model with an eligible auth mode and the roots", () => {
    const decision = chooseProvider(GPT, [
      node("a", probe("codex", "chatgpt", [SONNET])),
      node("b", probe("codex", "chatgpt", [GPT])),
    ]);

    expect(decision.selected).toEqual({ nodeId: "b", model: GPT });
    expect(decision.costClass).toBe("subscription");
    expect(decision.candidates).toEqual([
      { nodeId: "a", providerId: "codex", eligible: false, reasonCodes: ["model_not_offered"] },
      { nodeId: "b", providerId: "codex", eligible: true, reasonCodes: [] },
    ]);
  });

  /** THE GATE: no metered adapter, ever. A node on an API key is never routed to. */
  it("never selects an api_key node, even when it is the only one offering the model", () => {
    const decision = chooseProvider(GPT, [node("a", probe("codex", "api_key", [GPT]))]);

    expect(decision.selected).toBeUndefined();
    expect(decision.costClass).toBe("none");
    expect(decision.candidates[0]?.reasonCodes).toEqual(["auth_mode_ineligible"]);
    expect(decision.reasonCodes).toEqual(["no_eligible_node"]);
  });

  it("treats an unknown auth mode as ineligible too", () => {
    const decision = chooseProvider(GPT, [node("a", probe("codex", "unknown", [GPT]))]);

    expect(decision.candidates[0]?.reasonCodes).toEqual(["auth_mode_ineligible"]);
  });

  it("with localOnly rejects chatgpt and claude_ai nodes with local_only_root", () => {
    const decision = chooseProvider(
      SONNET,
      [
        node("a", probe("claude", "claude_ai", [SONNET])),
        node("b", probe("claude", "local", [SONNET])),
      ],
      { localOnly: true },
    );

    expect(decision.selected?.nodeId).toBe("b");
    expect(decision.costClass).toBe("local");
    expect(decision.candidates[0]?.reasonCodes).toEqual(["local_only_root"]);
  });

  it("names local_only_root at the top when that was the only bar", () => {
    const decision = chooseProvider(GPT, [node("a", probe("codex", "chatgpt", [GPT]))], {
      localOnly: true,
    });

    expect(decision.selected).toBeUndefined();
    expect(decision.reasonCodes).toEqual(["local_only_root"]);
  });

  it("lets preferredNodeId win a tie and says session_affinity", () => {
    const decision = chooseProvider(
      GPT,
      [node("a", probe("codex", "chatgpt", [GPT])), node("b", probe("codex", "chatgpt", [GPT]))],
      { preferredNodeId: "b" },
    );

    expect(decision.selected?.nodeId).toBe("b");
    expect(decision.reasonCodes).toEqual(["session_affinity"]);
  });

  it("ignores a preferredNodeId that is not eligible", () => {
    const decision = chooseProvider(
      GPT,
      [node("a", probe("codex", "chatgpt", [GPT])), node("b", probe("codex", "api_key", [GPT]))],
      { preferredNodeId: "b" },
    );

    expect(decision.selected?.nodeId).toBe("a");
    expect(decision.reasonCodes).toEqual([]);
  });

  it("reports model_not_offered when no node offers the requested model", () => {
    const decision = chooseProvider(GPT, [
      node("a", probe("codex", "chatgpt", [SONNET])),
      node("b", probe("claude", "claude_ai", [SONNET])),
    ]);

    expect(decision.selected).toBeUndefined();
    expect(decision.reasonCodes).toEqual(["model_not_offered"]);
    expect(decision.candidates[1]?.reasonCodes).toEqual(["provider_mismatch", "model_not_offered"]);
  });

  it("orders candidates by nodeId and picks the lowest when nothing else decides", () => {
    const decision = chooseProvider(GPT, [
      node("c", probe("codex", "chatgpt", [GPT])),
      node("a", probe("codex", "chatgpt", [GPT])),
      node("b", probe("codex", "chatgpt", [GPT])),
    ]);

    expect(decision.candidates.map((c) => c.nodeId)).toEqual(["a", "b", "c"]);
    expect(decision.selected?.nodeId).toBe("a");
  });

  it("names every failing check in a fixed order", () => {
    const decision = chooseProvider(GPT, [
      node("a", probe("codex", "chatgpt", [GPT], false), {
        connected: false,
        granted: false,
        hasRoots: false,
      }),
    ]);

    expect(decision.candidates[0]?.reasonCodes).toEqual([
      "not_connected",
      "not_granted",
      "missing_roots",
      "provider_unavailable",
    ]);
  });

  it("carries the probe's label when the request has none", () => {
    const decision = chooseProvider(GPT, [
      node("a", probe("codex", "chatgpt", [{ ...GPT, label: "GPT-5 Codex" }])),
    ]);

    expect(decision.selected?.model).toEqual({ ...GPT, label: "GPT-5 Codex" });
  });

  it("keeps the requested label over the probe's", () => {
    const decision = chooseProvider({ ...GPT, label: "mine" }, [
      node("a", probe("codex", "chatgpt", [{ ...GPT, label: "theirs" }])),
    ]);

    expect(decision.selected?.model.label).toBe("mine");
  });
});
