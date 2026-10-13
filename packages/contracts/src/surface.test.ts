import { ComposeSurfacesCommandSchema, UpsertSurfaceIntentCommandSchema } from "./command.js";
import { describe, expect, it } from "vitest";

import {
  CompositionPlanSchema,
  SurfaceIntentSchema,
  SurfaceOwnerSchema,
  ownerIdOf,
} from "./surface.js";

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
  it("accepts deterministic v8 source identities without accepting v8 entity IDs", () => {
    const source = "12345678-1234-8123-8123-123456789012";
    expect(SurfaceIntentSchema.safeParse({ ...valid, sourceIds: [source] }).success).toBe(true);
    expect(
      UpsertSurfaceIntentCommandSchema.safeParse({
        objectiveId: valid.objectiveId,
        kind: valid.kind,
        role: valid.role,
        persistence: valid.persistence,
        priority: valid.priority,
        minSize: valid.minSize,
        payloadVersion: 1,
        payload: {},
        idempotencyKey: "file",
        sourceIds: [source],
      }).success,
    ).toBe(true);
    expect(SurfaceIntentSchema.safeParse({ ...valid, id: source }).success).toBe(false);
  });
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

describe("surface ownership", () => {
  const owners = [
    { objectiveId: valid.objectiveId },
    { threadId: valid.objectiveId },
    { presence: true },
  ];
  const invalidOwners = [
    {},
    { presence: false },
    { objectiveId: valid.objectiveId, threadId: valid.objectiveId },
    { objectiveId: valid.objectiveId, presence: true },
    { threadId: valid.objectiveId, presence: true },
    { objectiveId: valid.objectiveId, threadId: valid.objectiveId, presence: true },
  ];
  const base = { ...valid, objectiveId: undefined };
  const plan = {
    layoutId: "test",
    displayFingerprint: "test",
    slots: [],
    overflowSurfaceIds: [],
    reasonCodes: [],
    generatedAt: valid.requestedAt,
  };
  for (const [name, schema, value] of [
    ["owner", SurfaceOwnerSchema, {}],
    ["intent", SurfaceIntentSchema, base],
    ["plan", CompositionPlanSchema, plan],
    [
      "upsert command",
      UpsertSurfaceIntentCommandSchema,
      {
        idempotencyKey: "ownership-test",
        kind: "document",
        role: "primary",
        persistence: "ephemeral",
        priority: 0,
        minSize: "compact",
        payloadVersion: 1,
        payload: {},
      },
    ],
    [
      "compose command",
      ComposeSurfacesCommandSchema,
      {
        idempotencyKey: "ownership-test",
        clientId: "client",
        display: { fingerprint: "display", widthPx: 1200 },
        attentionState: "presence",
      },
    ],
  ] as const) {
    it.each(owners)("accepts a single " + name + " owner: %j", (owner) =>
      expect(schema.safeParse({ ...value, ...owner }).success).toBe(true),
    );
    it.each(invalidOwners)("rejects invalid " + name + " ownership: %j", (owner) =>
      expect(schema.safeParse({ ...value, ...owner }).success).toBe(false),
    );
  }
  it("distinguishes every owner kind", () =>
    expect(new Set(owners.map((owner) => ownerIdOf(owner))).size).toBe(3));
});
