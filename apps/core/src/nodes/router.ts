import type { MissionHostPolicy, NodeCapability, NodeStatus } from "@noctis/contracts";
import { grantCovers } from "@noctis/contracts";

/**
 * Why a job could not be placed. Every refusal names one, and the name is
 * recorded on the job row, so a job that stays queued can say why instead of
 * merely sitting there. Section 10: "host routing with explicit reason codes".
 */
export type RouteRefusal =
  | "mission_is_core_only"
  | "no_paired_node"
  | "no_node_for_host"
  | "no_node_with_capability"
  | "grant_expired"
  | "no_online_node"
  /** The job named its node and that node is revoked, unpaired, or not connected. */
  | "pinned_node_unavailable";

export interface CandidateGrant {
  capability: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface RouteCandidate {
  nodeId: string;
  hostId: string;
  status: NodeStatus;
  /** Whether a socket is open right now. Not read from the row: the row lags. */
  connected: boolean;
  activeLeases: number;
  grants: readonly CandidateGrant[];
}

export interface RouteInput {
  capability: NodeCapability;
  /** `any_granted_host` when the job has no Mission: nothing constrains it. */
  hostPolicy: MissionHostPolicy;
  hostId?: string;
  /** Only this node may take the job. A pin is not a preference. */
  pinnedNodeId?: string;
  candidates: readonly RouteCandidate[];
  /** Epoch milliseconds from the injected clock. */
  now: number;
}

export type RouteOutcome = { ok: true; nodeId: string } | { ok: false; reason: RouteRefusal };

function isUsable(grant: CandidateGrant, capability: NodeCapability, now: number): boolean {
  return (
    grantCovers(grant.capability, capability) &&
    grant.revokedAt === undefined &&
    (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now)
  );
}

/**
 * Picks the node for one job, or says why none fits.
 *
 * Pure and total, and the filters run in a fixed order so the reason code is
 * the most specific true one: a node on the right host that lacks the
 * capability reports the missing capability, not the host. Selection is by
 * fewest active leases, tie-broken by node id, so the same inputs always place
 * the job on the same node — a router that picked at random would make a failed
 * dispatch impossible to reproduce.
 */
export function routeJob(input: RouteInput): RouteOutcome {
  if (input.hostPolicy === "core_only") {
    return { ok: false, reason: "mission_is_core_only" };
  }

  const pinned =
    input.pinnedNodeId === undefined
      ? input.candidates
      : input.candidates.filter(
          (candidate) =>
            candidate.nodeId === input.pinnedNodeId &&
            candidate.status !== "revoked" &&
            candidate.connected,
        );

  // Before every other gate: a pinned job has exactly one place it can go, and
  // "the other node was fine" is not a reason a resumed session can use.
  if (input.pinnedNodeId !== undefined && pinned.length === 0) {
    return { ok: false, reason: "pinned_node_unavailable" };
  }

  const paired = pinned.filter((candidate) => candidate.status !== "revoked");

  if (paired.length === 0) {
    return { ok: false, reason: "no_paired_node" };
  }

  const onHost =
    input.hostPolicy === "named_host"
      ? paired.filter((candidate) => candidate.hostId === input.hostId)
      : paired;

  if (onHost.length === 0) {
    return { ok: false, reason: "no_node_for_host" };
  }

  const granted = onHost.filter((candidate) =>
    candidate.grants.some((grant) => grantCovers(grant.capability, input.capability)),
  );

  if (granted.length === 0) {
    return { ok: false, reason: "no_node_with_capability" };
  }

  const live = granted.filter((candidate) =>
    candidate.grants.some((grant) => isUsable(grant, input.capability, input.now)),
  );

  if (live.length === 0) {
    return { ok: false, reason: "grant_expired" };
  }

  const connected = live.filter((candidate) => candidate.connected);

  if (connected.length === 0) {
    return { ok: false, reason: "no_online_node" };
  }

  const chosen = [...connected].sort(
    (left, right) =>
      left.activeLeases - right.activeLeases || left.nodeId.localeCompare(right.nodeId),
  )[0];

  if (chosen === undefined) {
    return { ok: false, reason: "no_online_node" };
  }

  return { ok: true, nodeId: chosen.nodeId };
}
