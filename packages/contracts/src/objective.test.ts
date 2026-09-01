import { describe, expect, it } from "vitest";

import { ObjectiveStatusSchema } from "./enums.js";
import * as objective from "./objective.js";

describe("ObjectiveStatusSchema", () => {
  it.each(["suggested", "draft", "active", "paused", "completed", "abandoned"])(
    "accepts the canonical %s status",
    (status) => {
      expect(ObjectiveStatusSchema.safeParse(status).success).toBe(true);
    },
  );

  it("rejects an unknown status instead of defaulting it", () => {
    expect(ObjectiveStatusSchema.safeParse("running").success).toBe(false);
  });
});

describe("ObjectiveRecordSchema", () => {
  const validObjective = {
    id: "018fe6d0-4a95-7a2d-9a65-2fc4f5f54801",
    title: "Bootstrap Noctis",
    intent: "Create the independent repository safely",
    status: "active",
    identityId: "vesper",
    protocolIds: [],
    createdAt: "2026-08-23T19:12:04.469Z",
    updatedAt: "2026-08-23T19:12:04.469Z",
    activatedAt: "2026-08-23T19:12:04.469Z",
    revision: 1,
  };

  it("accepts a complete canonical Objective record", () => {
    expect(objective.ObjectiveRecordSchema?.safeParse(validObjective).success).toBe(true);
  });

  it("rejects a negative revision", () => {
    expect(
      objective.ObjectiveRecordSchema?.safeParse({ ...validObjective, revision: -1 }).success,
    ).toBe(false);
  });

  it("rejects unknown fields instead of silently discarding them", () => {
    expect(
      objective.ObjectiveRecordSchema?.safeParse({ ...validObjective, modelCoordinates: [20, 30] })
        .success,
    ).toBe(false);
  });
});
