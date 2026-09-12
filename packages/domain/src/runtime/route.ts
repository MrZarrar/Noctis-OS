import type { ModelRef, RuntimeProbe, RuntimeProviderId } from "@noctis/contracts";
import { ELIGIBLE_AUTH_MODES } from "@noctis/contracts";

/**
 * Which node runs a turn, as one pure function over what the nodes reported.
 *
 * A model is data: the request names a provider and a model, and a node is
 * eligible only if its probe offers exactly that. Auth mode is enforced here at
 * dispatch, so an `api_key` node is never routed to however many models it lists.
 */

export interface ProviderCandidate {
  nodeId: string;
  hostId: string;
  connected: boolean;
  granted: boolean;
  probe: RuntimeProbe;
  /** True when every root the turn needs is granted on this node. */
  hasRoots: boolean;
}

export interface ProviderDecision {
  selected?: { nodeId: string; model: ModelRef };
  candidates: Array<{
    nodeId: string;
    providerId: RuntimeProviderId;
    eligible: boolean;
    reasonCodes: string[];
  }>;
  reasonCodes: string[];
  costClass: "subscription" | "local" | "none";
}

interface Judged {
  candidate: ProviderCandidate;
  offered: ModelRef | undefined;
  reasonCodes: string[];
}

/** Every failing check, in a fixed order, so two decisions about one node read the same. */
function judge(requested: ModelRef, candidate: ProviderCandidate, localOnly: boolean): Judged {
  const { probe } = candidate;
  const offered = probe.models.find((m) => m.model === requested.model);
  const checks: Array<[ok: boolean, code: string]> = [
    [candidate.connected, "not_connected"],
    [candidate.granted, "not_granted"],
    [candidate.hasRoots, "missing_roots"],
    [probe.available, "provider_unavailable"],
    [ELIGIBLE_AUTH_MODES.has(probe.authMode), "auth_mode_ineligible"],
    [probe.providerId === requested.providerId, "provider_mismatch"],
    [offered !== undefined, "model_not_offered"],
    [!localOnly || probe.authMode === "local", "local_only_root"],
  ];

  return {
    candidate,
    offered,
    reasonCodes: checks.filter(([ok]) => !ok).map(([, code]) => code),
  };
}

export function chooseProvider(
  requested: ModelRef,
  candidates: readonly ProviderCandidate[],
  options?: { preferredNodeId?: string; localOnly?: boolean },
): ProviderDecision {
  const judged = candidates
    .map((c) => judge(requested, c, options?.localOnly ?? false))
    .sort((a, b) => a.candidate.nodeId.localeCompare(b.candidate.nodeId));
  const eligible = judged.filter((j) => j.reasonCodes.length === 0);
  const preferred = eligible.find((j) => j.candidate.nodeId === options?.preferredNodeId);
  const winner = preferred ?? eligible[0];

  const out = judged.map((j) => ({
    nodeId: j.candidate.nodeId,
    providerId: j.candidate.probe.providerId,
    eligible: j.reasonCodes.length === 0,
    reasonCodes: j.reasonCodes,
  }));

  if (winner === undefined) {
    const reason = judged.every((j) => j.offered === undefined)
      ? "model_not_offered"
      : judged.some((j) => j.reasonCodes.length === 1 && j.reasonCodes[0] === "local_only_root")
        ? "local_only_root"
        : "no_eligible_node";

    return { candidates: out, reasonCodes: [reason], costClass: "none" };
  }

  const label = requested.label ?? winner.offered?.label;

  return {
    selected: {
      nodeId: winner.candidate.nodeId,
      model: { ...requested, ...(label === undefined ? {} : { label }) },
    },
    candidates: out,
    reasonCodes: preferred === undefined ? [] : ["session_affinity"],
    costClass: winner.candidate.probe.authMode === "local" ? "local" : "subscription",
  };
}
