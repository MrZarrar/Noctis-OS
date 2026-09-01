import { describe, expect, it } from "vitest";

import { SurfaceIntentSchema } from "./surface.js";

const valid = {
  id: "01941f29-7c00-7000-8000-000000000003",
  objectiveId: "01941f29-7c00-7000-8000-000000000002",
  kind: "timeline",
  role: "primary",
  persistence: "objective",
  lifecycle: "proposed",
  priority: 10,
  minSize: "standard",
  sourceIds: [],
  artifactIds: [],
  payloadVersion: 1,
  payload: { rows: [] },
  requestedAt: "2026-09-01T12:00:00.000Z",
};

describe("SurfaceIntentSchema", () => {
  it("accepts a well-formed intent", () => {
    expect(SurfaceIntentSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts an optional preferred region", () => {
    expect(SurfaceIntentSchema.safeParse({ ...valid, preferredRegion: "left" }).success).toBe(true);
  });

  it("rejects an unknown role", () => {
    expect(SurfaceIntentSchema.safeParse({ ...valid, role: "hero" }).success).toBe(false);
  });

  it("rejects an unknown field", () => {
    expect(SurfaceIntentSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it("treats payload as unknown but still requires a version", () => {
    const withoutVersion: Record<string, unknown> = {
      id: valid.id,
      objectiveId: valid.objectiveId,
      kind: valid.kind,
      role: valid.role,
      persistence: valid.persistence,
      lifecycle: valid.lifecycle,
      priority: valid.priority,
      minSize: valid.minSize,
      sourceIds: valid.sourceIds,
      artifactIds: valid.artifactIds,
      payload: valid.payload,
      requestedAt: valid.requestedAt,
    };

    expect(SurfaceIntentSchema.safeParse(withoutVersion).success).toBe(false);
  });
});
