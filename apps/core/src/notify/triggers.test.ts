import type { OrchestrationEvent } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { pushFor } from "./triggers.js";

/**
 * The discriminant is `type`, not `name` — `OrchestrationEventSchema` in
 * `packages/contracts/src/events.ts` declares `type: EventNameSchema`. A switch
 * on `event.name` would read `undefined` every time and push nothing, silently.
 */
function event(type: string, payload: Record<string, unknown>): OrchestrationEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    streamType: "identity",
    streamId: "00000000-0000-4000-8000-0000000000aa",
    type,
    actorType: "user",
    actorId: "local",
    payloadVersion: 1,
    payload,
    correlationId: "00000000-0000-4000-8000-0000000000bb",
    occurredAt: "2026-09-16T00:00:00.000Z",
  } as OrchestrationEvent;
}

/** What `authority/service.ts` actually emits. There is no `decision` field. */
function decision(outcome: string): OrchestrationEvent {
  return event("authority.decision_recorded.v1", {
    requestId: "00000000-0000-4000-8000-0000000000aa",
    actorId: "vesper",
    operationClass: "file_write",
    capability: "vault.write",
    target: { type: "file", id: "inbox/plan.md" },
    reversibility: "reversible",
    outcome,
    policyId: "policy.default",
    reasonCodes: ["consequential"],
  });
}

describe("pushFor", () => {
  it("pushes when a decision needs a confirmation, because that is a person being asked", () => {
    const payload = pushFor(decision("require_confirmation"));

    expect(payload?.title).toContain("Approval");
    expect(payload?.body).toContain("vault.write");
    expect(payload?.body).toContain("inbox/plan.md");
  });

  it("pushes for a typed confirmation too — it is the same person, asked harder", () => {
    expect(pushFor(decision("require_typed_confirmation"))?.title).toContain("Approval");
  });

  it("does not push an allow or a deny, which are already decided", () => {
    expect(pushFor(decision("allow"))).toBeUndefined();
    expect(pushFor(decision("deny"))).toBeUndefined();
  });

  it("truncates the target, because a lock screen is not a log line", () => {
    const long = pushFor(
      event("authority.decision_recorded.v1", {
        outcome: "require_confirmation",
        capability: "vault.write",
        target: { type: "file", id: "x".repeat(400) },
      }),
    );

    expect(long?.body.length).toBeLessThanOrEqual(140);
    expect(long?.body).toContain("…");
  });

  it("pushes a failed turn, and names the reason", () => {
    const payload = pushFor(
      event("identity.turn_completed.v1", {
        turnId: "00000000-0000-4000-8000-0000000000cc",
        threadId: "00000000-0000-4000-8000-0000000000aa",
        status: "failed",
        model: { provider: "codex", name: "gpt-5" },
        failureReason: "runtime_declined",
      }),
    );

    expect(payload?.title).toContain("failed");
    expect(payload?.body).toContain("runtime_declined");
  });

  it("does not push a completed turn, which would make the phone buzz all day", () => {
    expect(pushFor(event("identity.turn_completed.v1", { status: "completed" }))).toBeUndefined();
  });

  it("does not push a cancelled turn, because the person cancelling it already knows", () => {
    expect(pushFor(event("identity.turn_completed.v1", { status: "cancelled" }))).toBeUndefined();
  });

  it("ignores every other event", () => {
    expect(pushFor(event("objective.created.v1", {}))).toBeUndefined();
    expect(pushFor(event("node.connected.v1", {}))).toBeUndefined();
  });

  it("ignores an event whose payload is not an object at all", () => {
    const malformed = { ...event("identity.turn_completed.v1", {}), payload: "failed" };

    expect(pushFor(malformed as OrchestrationEvent)).toBeUndefined();
  });

  it("tags by stream so a second push about the same thing replaces the first", () => {
    expect(pushFor(decision("require_confirmation"))?.tag).toBe(
      "00000000-0000-4000-8000-0000000000aa",
    );
  });
});
