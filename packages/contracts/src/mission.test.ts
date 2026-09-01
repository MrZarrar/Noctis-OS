import { describe, expect, it } from "vitest";

import { MissionRecordSchema } from "./mission.js";

const valid = {
  id: "01941f29-7c00-7000-8000-000000000001",
  objectiveId: "01941f29-7c00-7000-8000-000000000002",
  title: "Verify the node agent",
  status: "draft",
  operationClass: "read_inspect",
  hostPolicy: "any_granted_host",
  revision: 0,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
};

describe("MissionRecordSchema", () => {
  it("accepts a well-formed mission", () => {
    expect(MissionRecordSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unknown field", () => {
    expect(MissionRecordSchema.safeParse({ ...valid, injected: true }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(MissionRecordSchema.safeParse({ ...valid, status: "paused" }).success).toBe(false);
  });

  it("rejects a non-UUIDv7 id", () => {
    expect(
      MissionRecordSchema.safeParse({ ...valid, id: "9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d" })
        .success,
    ).toBe(false);
  });

  it("rejects a blank title", () => {
    expect(MissionRecordSchema.safeParse({ ...valid, title: "   " }).success).toBe(false);
  });
});
