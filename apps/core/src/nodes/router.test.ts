import { describe, expect, it } from "vitest";

import type { RouteCandidate } from "./router.js";
import { routeJob } from "./router.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    nodeId: "0199a000-0000-7000-8000-00000000000a",
    hostId: "workstation",
    status: "online",
    connected: true,
    activeLeases: 0,
    grants: [{ capability: "verification.noop" }],
    ...overrides,
  };
}

function route(candidates: readonly RouteCandidate[], overrides: Record<string, unknown> = {}) {
  return routeJob({
    capability: "verification.noop",
    hostPolicy: "any_granted_host",
    candidates,
    now: NOW,
    ...overrides,
  });
}

describe("routeJob", () => {
  it("places a job on a connected node that holds the grant", () => {
    expect(route([candidate()])).toEqual({
      ok: true,
      nodeId: "0199a000-0000-7000-8000-00000000000a",
    });
  });

  it("refuses a core_only Mission before looking at any node", () => {
    expect(route([candidate()], { hostPolicy: "core_only" })).toEqual({
      ok: false,
      reason: "mission_is_core_only",
    });
  });

  it("refuses when there is no node at all", () => {
    expect(route([])).toEqual({ ok: false, reason: "no_paired_node" });
  });

  it("refuses when every node is revoked", () => {
    expect(route([candidate({ status: "revoked" })])).toEqual({
      ok: false,
      reason: "no_paired_node",
    });
  });

  /** The "wrong host" case: a capable node on the wrong machine is not a fallback. */
  it("refuses a named_host job when no node is on that host", () => {
    expect(
      route([candidate({ hostId: "laptop" })], { hostPolicy: "named_host", hostId: "server" }),
    ).toEqual({ ok: false, reason: "no_node_for_host" });
  });

  it("places a named_host job on the node that is on that host", () => {
    const outcome = route(
      [
        candidate({ nodeId: "0199a000-0000-7000-8000-00000000000a", hostId: "laptop" }),
        candidate({ nodeId: "0199a000-0000-7000-8000-00000000000b", hostId: "server" }),
      ],
      { hostPolicy: "named_host", hostId: "server" },
    );

    expect(outcome).toEqual({ ok: true, nodeId: "0199a000-0000-7000-8000-00000000000b" });
  });

  it("refuses when the node on the right host lacks the capability", () => {
    expect(
      route([candidate({ grants: [{ capability: "file.search" }] })], {
        hostPolicy: "named_host",
        hostId: "workstation",
      }),
    ).toEqual({ ok: false, reason: "no_node_with_capability" });
  });

  /** The host filter runs first, so the reason names the most specific truth. */
  it("reports the host before the capability when both are wrong", () => {
    expect(
      route([candidate({ hostId: "laptop", grants: [{ capability: "file.search" }] })], {
        hostPolicy: "named_host",
        hostId: "server",
      }),
    ).toEqual({ ok: false, reason: "no_node_for_host" });
  });

  it("distinguishes an expired grant from a missing one", () => {
    expect(
      route([
        candidate({
          grants: [{ capability: "verification.noop", expiresAt: "2026-08-31T12:00:00.000Z" }],
        }),
      ]),
    ).toEqual({ ok: false, reason: "grant_expired" });
  });

  it("treats a revoked grant as expired rather than absent", () => {
    expect(
      route([
        candidate({
          grants: [{ capability: "verification.noop", revokedAt: "2026-08-31T12:00:00.000Z" }],
        }),
      ]),
    ).toEqual({ ok: false, reason: "grant_expired" });
  });

  it("honours a grant that expires later", () => {
    expect(
      route([
        candidate({
          grants: [{ capability: "verification.noop", expiresAt: "2026-09-02T12:00:00.000Z" }],
        }),
      ]).ok,
    ).toBe(true);
  });

  it("refuses when the only granted node is not connected", () => {
    expect(route([candidate({ connected: false })])).toEqual({
      ok: false,
      reason: "no_online_node",
    });
  });

  it("prefers the node with the fewest active leases", () => {
    const outcome = route([
      candidate({ nodeId: "0199a000-0000-7000-8000-00000000000a", activeLeases: 3 }),
      candidate({ nodeId: "0199a000-0000-7000-8000-00000000000b", activeLeases: 1 }),
    ]);

    expect(outcome).toEqual({ ok: true, nodeId: "0199a000-0000-7000-8000-00000000000b" });
  });

  /**
   * A router that broke ties at random would make a bad dispatch impossible to
   * reproduce, which is the one thing you need when a job lands on the wrong box.
   */
  it("breaks a tie by node id, in either input order", () => {
    const a = candidate({ nodeId: "0199a000-0000-7000-8000-00000000000a" });
    const b = candidate({ nodeId: "0199a000-0000-7000-8000-00000000000b" });

    expect(route([a, b])).toEqual(route([b, a]));
    expect(route([b, a])).toEqual({ ok: true, nodeId: "0199a000-0000-7000-8000-00000000000a" });
  });

  it("does not mutate the candidate list it was given", () => {
    const candidates = [
      candidate({ nodeId: "0199a000-0000-7000-8000-00000000000b", activeLeases: 5 }),
      candidate({ nodeId: "0199a000-0000-7000-8000-00000000000a", activeLeases: 1 }),
    ];

    route(candidates);

    expect(candidates[0]?.nodeId).toBe("0199a000-0000-7000-8000-00000000000b");
  });
});
