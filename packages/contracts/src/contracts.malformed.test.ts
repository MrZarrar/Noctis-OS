import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import { ArtifactRecordSchema } from "./artifact.js";
import { AuthorityRequestSchema } from "./authority.js";
import { ConversationThreadSchema } from "./identity.js";
import { MissionRecordSchema } from "./mission.js";
import { NodeJobSchema } from "./node.js";
import { NoirCaseSchema } from "./noir.js";
import { ObjectiveRecordSchema } from "./objective.js";
import { SourceObservationSchema } from "./source.js";
import { SurfaceIntentSchema } from "./surface.js";

const SCHEMAS: ReadonlyArray<readonly [string, ZodType]> = [
  ["ArtifactRecord", ArtifactRecordSchema],
  ["AuthorityRequest", AuthorityRequestSchema],
  ["ConversationThread", ConversationThreadSchema],
  ["MissionRecord", MissionRecordSchema],
  ["NodeJob", NodeJobSchema],
  ["NoirCase", NoirCaseSchema],
  ["ObjectiveRecord", ObjectiveRecordSchema],
  ["SourceObservation", SourceObservationSchema],
  ["SurfaceIntent", SurfaceIntentSchema],
];

const HOSTILE_INPUTS: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["a string", "not an object"],
  ["a number", 7],
  ["an array", []],
  ["an empty object", {}],
  ["a prototype-polluting payload", JSON.parse('{"__proto__":{"polluted":true}}')],
];

describe("every schema rejects hostile input", () => {
  for (const [schemaName, schema] of SCHEMAS) {
    it.each(HOSTILE_INPUTS)(`${schemaName} rejects %s`, (_label, input) => {
      expect(schema.safeParse(input).success).toBe(false);
    });
  }
});

const VALID_FIXTURES: ReadonlyArray<readonly [string, ZodType, Record<string, unknown>]> = [
  [
    "ArtifactRecord",
    ArtifactRecordSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000010",
      kind: "local_artifact",
      title: "Report",
      uri: "file:///tmp/report.txt",
      provenanceVersion: 1,
      provenance: {},
      createdAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "AuthorityRequest",
    AuthorityRequestSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000011",
      actorId: "vesper",
      operationClass: "read_inspect",
      capability: "fs.read",
      target: { type: "file", id: "abc" },
      consequenceSummary: "Reads a file",
      reversibility: "reversible",
      idempotencyKey: "idem-key-1",
      requestedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "ConversationThread",
    ConversationThreadSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000012",
      identityId: "vesper",
      revision: 0,
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "MissionRecord",
    MissionRecordSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000013",
      objectiveId: "01941f29-7c00-7000-8000-000000000014",
      title: "Verify the node agent",
      status: "draft",
      operationClass: "read_inspect",
      hostPolicy: "any_granted_host",
      revision: 0,
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "NodeJob",
    NodeJobSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000015",
      capability: "fs.read",
      status: "queued",
      idempotencyKey: "idem-key-2",
      attempts: 0,
      payloadVersion: 1,
      payload: {},
      revision: 0,
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "NoirCase",
    NoirCaseSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000016",
      objectiveId: "01941f29-7c00-7000-8000-000000000017",
      question: "Why did the build fail?",
      status: "forming",
      revision: 0,
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "ObjectiveRecord",
    ObjectiveRecordSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000018",
      title: "Ship the contracts package",
      intent: "Land the phase 1 schemas",
      status: "draft",
      identityId: "vesper",
      protocolIds: [],
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
      revision: 0,
    },
  ],
  [
    "SourceObservation",
    SourceObservationSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000019",
      sourceId: "01941f29-7c00-7000-8000-00000000001a",
      status: "current",
      payloadVersion: 1,
      payload: {},
      observedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "SurfaceIntent",
    SurfaceIntentSchema,
    {
      id: "01941f29-7c00-7000-8000-00000000001b",
      objectiveId: "01941f29-7c00-7000-8000-00000000001c",
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
    },
  ],
];

describe("every schema enforces .strict() against unknown fields", () => {
  for (const [schemaName, schema, fixture] of VALID_FIXTURES) {
    it(`${schemaName} fixture is valid`, () => {
      expect(schema.safeParse(fixture).success).toBe(true);
    });

    it(`${schemaName} rejects the fixture plus one unknown field`, () => {
      expect(schema.safeParse({ ...fixture, unexpectedField: true }).success).toBe(false);
    });
  }
});
