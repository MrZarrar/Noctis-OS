import { describe, expect, it } from "vitest";

import { ClientFrameSchema, ServerFrameSchema } from "./ws.js";

const EVENT = {
  id: "01941f29-7c00-7000-8000-000000000010",
  sequence: 1,
  streamType: "objective",
  streamId: "01941f29-7c00-7000-8000-000000000011",
  type: "objective.created.v1",
  actorType: "user",
  actorId: "mushaf",
  payloadVersion: 1,
  payload: {},
  correlationId: "01941f29-7c00-7000-8000-000000000012",
  occurredAt: "2026-09-01T12:00:00.000Z",
};

describe("WebSocket frames", () => {
  it("accepts a subscribe frame carrying a resume point", () => {
    expect(
      ClientFrameSchema.safeParse({ kind: "subscribe", afterSequence: 42, envelopeVersion: 1 })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown envelope version, failing closed", () => {
    expect(
      ClientFrameSchema.safeParse({ kind: "subscribe", afterSequence: 42, envelopeVersion: 2 })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown client frame kind", () => {
    expect(ClientFrameSchema.safeParse({ kind: "mutate", envelopeVersion: 1 }).success).toBe(false);
  });

  it("accepts an acknowledge frame", () => {
    expect(
      ClientFrameSchema.safeParse({ kind: "acknowledge", envelopeVersion: 1, sequence: 1 }).success,
    ).toBe(true);
  });

  it("accepts a server gap frame", () => {
    expect(
      ServerFrameSchema.safeParse({
        kind: "gap",
        envelopeVersion: 1,
        fromSequence: 10,
        toSequence: 99,
      }).success,
    ).toBe(true);
  });

  it("accepts a server event frame embedding an orchestration event", () => {
    expect(
      ServerFrameSchema.safeParse({ kind: "event", envelopeVersion: 1, event: EVENT }).success,
    ).toBe(true);
  });

  it("rejects an unknown envelope version on a server frame, failing closed", () => {
    expect(
      ServerFrameSchema.safeParse({
        kind: "gap",
        envelopeVersion: 2,
        fromSequence: 10,
        toSequence: 99,
      }).success,
    ).toBe(false);
  });
});
