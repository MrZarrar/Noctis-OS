import { describe, expect, it } from "vitest";

import { ClientFrameSchema, ServerFrameSchema } from "./ws.js";

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
});
