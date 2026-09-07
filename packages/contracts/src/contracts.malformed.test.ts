import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import { ArtifactRecordSchema } from "./artifact.js";
import {
  AuthorityDecisionSchema,
  AuthorityRequestSchema,
  StandingPermissionSchema,
} from "./authority.js";
import {
  ActivateIdentityCommandSchema,
  ComposeSurfacesCommandSchema,
  UpsertSurfaceIntentCommandSchema,
} from "./command.js";
import { OrchestrationEventSchema } from "./events.js";
import {
  ConversationThreadSchema,
  IdentityMessageSchema,
  IdentityProfileSchema,
} from "./identity.js";
import { MissionEvidenceSchema, MissionRecordSchema, MissionStepSchema } from "./mission.js";
import {
  CapabilityGrantSchema,
  EnvironmentInspectEvidenceSchema,
  FileSearchConstraintsSchema,
  FileSearchEvidenceSchema,
  FileSearchPayloadSchema,
  NodeCredentialSchema,
  NodeDescriptorSchema,
  NodeFrameSchema,
  NodeJobAssignmentSchema,
  NodeJobSchema,
  NodeServerFrameSchema,
  VerificationNoopEvidenceSchema,
} from "./node.js";
import {
  EvidenceItemSchema,
  FalsifierSchema,
  HypothesisSchema,
  NoirCaseSchema,
  UncertaintySchema,
} from "./noir.js";
import { ObjectiveLinkSchema, ObjectiveRecordSchema } from "./objective.js";
import { SourceObservationSchema, SourceRecordSchema } from "./source.js";
import { CompositionPlanSchema, SurfaceIntentSchema, SurfaceOverrideSchema } from "./surface.js";
import { ClientFrameSchema, ServerFrameSchema } from "./ws.js";

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
  ["ObjectiveLink", ObjectiveLinkSchema],
  ["MissionStep", MissionStepSchema],
  ["MissionEvidence", MissionEvidenceSchema],
  ["SurfaceOverride", SurfaceOverrideSchema],
  ["CompositionPlan", CompositionPlanSchema],
  ["NodeDescriptor", NodeDescriptorSchema],
  ["CapabilityGrant", CapabilityGrantSchema],
  ["Hypothesis", HypothesisSchema],
  ["EvidenceItem", EvidenceItemSchema],
  ["Falsifier", FalsifierSchema],
  ["Uncertainty", UncertaintySchema],
  ["AuthorityDecision", AuthorityDecisionSchema],
  ["StandingPermission", StandingPermissionSchema],
  ["IdentityProfile", IdentityProfileSchema],
  ["IdentityMessage", IdentityMessageSchema],
  ["ActivateIdentityCommand", ActivateIdentityCommandSchema],
  ["UpsertSurfaceIntentCommand", UpsertSurfaceIntentCommandSchema],
  ["ComposeSurfacesCommand", ComposeSurfacesCommandSchema],
  ["SourceRecord", SourceRecordSchema],
  ["OrchestrationEvent", OrchestrationEventSchema],
  ["ClientFrame", ClientFrameSchema],
  ["ServerFrame", ServerFrameSchema],
  ["NodeFrame", NodeFrameSchema],
  ["NodeServerFrame", NodeServerFrameSchema],
  ["NodeJobAssignment", NodeJobAssignmentSchema],
  ["NodeCredential", NodeCredentialSchema],
  ["FileSearchPayload", FileSearchPayloadSchema],
  ["FileSearchEvidence", FileSearchEvidenceSchema],
  ["FileSearchConstraints", FileSearchConstraintsSchema],
  ["EnvironmentInspectEvidence", EnvironmentInspectEvidenceSchema],
  ["VerificationNoopEvidence", VerificationNoopEvidenceSchema],
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
      // Phase 8: a local artifact must name where the bytes are and what they
      // hash to, or "local" is a word with nothing behind it.
      hostId: "desk",
      checksum: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
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
  [
    "ObjectiveLink",
    ObjectiveLinkSchema,
    {
      objectiveId: "01941f29-7c00-7000-8000-00000000001d",
      relatedType: "mission",
      relatedId: "01941f29-7c00-7000-8000-00000000001e",
      relation: "depends_on",
      createdAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "MissionStep",
    MissionStepSchema,
    {
      id: "01941f29-7c00-7000-8000-00000000001f",
      missionId: "01941f29-7c00-7000-8000-000000000020",
      ordinal: 0,
      kind: "deterministic",
      operationClass: "read_inspect",
      status: "draft",
      payloadVersion: 1,
      payload: {},
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "MissionEvidence",
    MissionEvidenceSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000021",
      missionId: "01941f29-7c00-7000-8000-000000000022",
      kind: "result",
      hostId: "host-1",
      summary: "Verified the node agent responded",
      payloadVersion: 1,
      payload: {},
      observedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "SurfaceOverride",
    SurfaceOverrideSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000023",
      surfaceId: "01941f29-7c00-7000-8000-000000000024",
      clientId: "client-1",
      displayFingerprint: "fp-1",
      region: "left",
      size: "standard",
      createdAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "CompositionPlan",
    CompositionPlanSchema,
    {
      objectiveId: "01941f29-7c00-7000-8000-000000000025",
      layoutId: "layout-1",
      displayFingerprint: "fp-1",
      slots: [
        {
          surfaceId: "01941f29-7c00-7000-8000-000000000026",
          region: "left",
          order: 0,
          size: "standard",
          layer: 0,
        },
      ],
      overflowSurfaceIds: [],
      reasonCodes: [],
      generatedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "NodeDescriptor",
    NodeDescriptorSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000027",
      hostId: "host-1",
      status: "pending",
      fingerprint: "fp-1",
      agentVersion: "1.0.0",
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "CapabilityGrant",
    CapabilityGrantSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000028",
      nodeId: "01941f29-7c00-7000-8000-000000000029",
      capability: "fs.read",
      operationClass: "read_inspect",
      constraintsVersion: 1,
      constraints: {},
      grantedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "Hypothesis",
    HypothesisSchema,
    {
      id: "01941f29-7c00-7000-8000-00000000002a",
      caseId: "01941f29-7c00-7000-8000-00000000002b",
      statement: "The build failed because of a flaky test",
      rank: 0,
      status: "open",
      confidenceRationale: "One recent failure, no repro yet",
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "EvidenceItem",
    EvidenceItemSchema,
    {
      id: "01941f29-7c00-7000-8000-00000000002c",
      caseId: "01941f29-7c00-7000-8000-00000000002d",
      stance: "supports",
      verification: "unverified",
      summary: "Log shows a timeout",
      observedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "Falsifier",
    FalsifierSchema,
    {
      id: "01941f29-7c00-7000-8000-00000000002e",
      caseId: "01941f29-7c00-7000-8000-00000000002f",
      hypothesisId: "01941f29-7c00-7000-8000-000000000030",
      check: "Re-run the test in isolation ten times",
      result: "pending",
      createdAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "Uncertainty",
    UncertaintySchema,
    {
      id: "01941f29-7c00-7000-8000-000000000031",
      caseId: "01941f29-7c00-7000-8000-000000000032",
      statement: "No evidence yet on the network path",
      reason: "missing_evidence",
      createdAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "AuthorityDecision",
    AuthorityDecisionSchema,
    {
      requestId: "01941f29-7c00-7000-8000-000000000033",
      outcome: "allow",
      policyId: "policy-1",
      reasonCodes: [],
      decidedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "StandingPermission",
    StandingPermissionSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000034",
      actorId: "vesper",
      capability: "fs.read",
      operationClass: "read_inspect",
      constraints: { targetType: "repository", targetIds: ["noctis-os"] },
      grantedAt: "2026-09-01T12:00:00.000Z",
      grantedBy: "local",
    },
  ],
  [
    "IdentityProfile",
    IdentityProfileSchema,
    {
      id: "vesper",
      displayName: "Vesper",
      activationCommand: "/vesper",
    },
  ],
  [
    "IdentityMessage",
    IdentityMessageSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000035",
      threadId: "01941f29-7c00-7000-8000-000000000036",
      role: "user",
      contentRef: "blob://message-1",
      createdAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "ActivateIdentityCommand",
    ActivateIdentityCommandSchema,
    { idempotencyKey: "idem-key-identity-1", identityId: "vesper" },
  ],
  [
    "SourceRecord",
    SourceRecordSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000037",
      sourceType: "rss",
      externalId: "feed-1",
      freshnessSeconds: 300,
      unavailableSemantics: "unknown",
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "OrchestrationEvent",
    OrchestrationEventSchema,
    {
      id: "01941f29-7c00-7000-8000-000000000038",
      sequence: 1,
      streamType: "objective",
      streamId: "01941f29-7c00-7000-8000-000000000039",
      type: "objective.created.v1",
      actorType: "user",
      actorId: "mushaf",
      payloadVersion: 1,
      payload: {},
      correlationId: "01941f29-7c00-7000-8000-00000000003a",
      occurredAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  [
    "ClientFrame",
    ClientFrameSchema,
    {
      kind: "subscribe",
      envelopeVersion: 1,
      afterSequence: 0,
    },
  ],
  [
    "ServerFrame",
    ServerFrameSchema,
    {
      kind: "gap",
      envelopeVersion: 1,
      fromSequence: 0,
      toSequence: 1,
    },
  ],
  [
    "NodeFrame",
    NodeFrameSchema,
    {
      kind: "result",
      envelopeVersion: 1,
      jobId: "01941f29-7c00-7000-8000-000000000030",
      outcome: "succeeded",
      evidence: { verified: true },
    },
  ],
  [
    "NodeServerFrame",
    NodeServerFrameSchema,
    {
      kind: "job",
      envelopeVersion: 1,
      assignment: '{"jobId":"01941f29-7c00-7000-8000-000000000031"}',
      signature: "a".repeat(64),
    },
  ],
  [
    "NodeJobAssignment",
    NodeJobAssignmentSchema,
    {
      jobId: "01941f29-7c00-7000-8000-000000000032",
      nodeId: "01941f29-7c00-7000-8000-000000000033",
      capability: "verification.noop",
      payloadVersion: 1,
      payload: {},
      idempotencyKey: "idem-key-node-1",
      leaseExpiresAt: "2026-09-01T12:00:30.000Z",
      attempt: 1,
    },
  ],
  [
    "NodeCredential",
    NodeCredentialSchema,
    {
      coreUrl: "http://127.0.0.1:7717",
      nodeId: "01941f29-7c00-7000-8000-000000000034",
      generation: 0,
      credential: "b".repeat(64),
    },
  ],
  ["FileSearchPayload", FileSearchPayloadSchema, { rootGrantId: "root-a", nameContains: "report" }],
  [
    "FileSearchEvidence",
    FileSearchEvidenceSchema,
    { matches: [{ relativePath: "notes/findings.md", sizeBytes: 8 }], truncated: false },
  ],
  [
    "FileSearchConstraints",
    FileSearchConstraintsSchema,
    { roots: [{ grantId: "root-a", path: "/granted/root" }] },
  ],
  [
    "EnvironmentInspectEvidence",
    EnvironmentInspectEvidenceSchema,
    { platform: "win32", arch: "x64", nodeVersion: "v22.23.2", cpuCount: 8, totalMemoryBytes: 1 },
  ],
  ["VerificationNoopEvidence", VerificationNoopEvidenceSchema, { verified: true }],
  [
    "UpsertSurfaceIntentCommand",
    UpsertSurfaceIntentCommandSchema,
    {
      idempotencyKey: "upsert-1",
      objectiveId: "01941f29-7c00-7000-8000-000000000040",
      kind: "detail",
      role: "primary",
      persistence: "objective",
      priority: 0,
      minSize: "compact",
      payloadVersion: 1,
      payload: {},
    },
  ],
  [
    "ComposeSurfacesCommand",
    ComposeSurfacesCommandSchema,
    {
      idempotencyKey: "compose-1",
      objectiveId: "01941f29-7c00-7000-8000-000000000041",
      clientId: "workbench-1",
      display: { fingerprint: "fp-1", widthPx: 3440 },
      attentionState: "active_canvas",
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

  it("CompositionPlan rejects an unknown key nested inside a slot", () => {
    const fixture = {
      objectiveId: "01941f29-7c00-7000-8000-000000000025",
      layoutId: "layout-1",
      displayFingerprint: "fp-1",
      slots: [
        {
          surfaceId: "01941f29-7c00-7000-8000-000000000026",
          region: "left",
          order: 0,
          size: "standard",
          layer: 0,
          unexpectedField: true,
        },
      ],
      overflowSurfaceIds: [],
      reasonCodes: [],
      generatedAt: "2026-09-01T12:00:00.000Z",
    };

    expect(CompositionPlanSchema.safeParse(fixture).success).toBe(false);
  });
});
