import { describe, expect, it } from "vitest";

import { EventNameSchema, OrchestrationEventSchema } from "./events.js";

const valid = {
  id: "01941f29-7c00-7000-8000-000000000010",
  sequence: 1,
  streamType: "objective",
  streamId: "01941f29-7c00-7000-8000-000000000002",
  type: "objective.created.v1",
  actorType: "user",
  actorId: "mushaf",
  payloadVersion: 1,
  payload: { title: "Ship Phase 1" },
  correlationId: "01941f29-7c00-7000-8000-000000000011",
  occurredAt: "2026-09-01T12:00:00.000Z",
};

describe("EventNameSchema", () => {
  it("accepts a registered versioned name", () => {
    expect(EventNameSchema.safeParse("objective.activated.v1").success).toBe(true);
  });

  it("rejects an unregistered name", () => {
    expect(EventNameSchema.safeParse("objective.exploded.v1").success).toBe(false);
  });

  it("rejects an unknown version of a registered name", () => {
    expect(EventNameSchema.safeParse("objective.created.v2").success).toBe(false);
  });

  it("rejects an unversioned name", () => {
    expect(EventNameSchema.safeParse("objective.created").success).toBe(false);
  });
});

describe("OrchestrationEventSchema", () => {
  it("accepts a well-formed event", () => {
    expect(OrchestrationEventSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts an optional causation id", () => {
    expect(
      OrchestrationEventSchema.safeParse({
        ...valid,
        causationId: "01941f29-7c00-7000-8000-000000000012",
      }).success,
    ).toBe(true);
  });

  it("rejects a sequence below one", () => {
    expect(OrchestrationEventSchema.safeParse({ ...valid, sequence: 0 }).success).toBe(false);
  });

  it("rejects an unknown stream type", () => {
    expect(OrchestrationEventSchema.safeParse({ ...valid, streamType: "vault" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown field", () => {
    expect(OrchestrationEventSchema.safeParse({ ...valid, spoof: 1 }).success).toBe(false);
  });
});
