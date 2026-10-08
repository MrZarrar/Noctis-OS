import { z } from "zod";

import { NodeJobStatusSchema, OperationClassSchema } from "./enums.js";
import {
  IdempotencyKeySchema,
  RevisionSchema,
  SchemaVersionSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./primitives.js";
import {
  RuntimeAnswerSchema,
  RuntimeAskSchema,
  RuntimeDelegationResultSchema,
  RuntimeDelegationSchema,
  RuntimeDeltaSchema,
  RuntimeItemSchema,
  RuntimeProbeSchema,
  RuntimeTurnEvidenceSchema,
  RuntimeTurnPayloadSchema,
} from "./runtime.js";

export const NodeStatusSchema = z.enum(["pending", "paired", "online", "offline", "revoked"]);

export const NodeDescriptorSchema = z
  .object({
    id: UuidSchema,
    hostId: z.string().trim().min(1),
    status: NodeStatusSchema,
    fingerprint: z.string().trim().min(1),
    agentVersion: z.string().trim().min(1),
    lastSeenAt: UtcTimestampSchema.optional(),
    revokedAt: UtcTimestampSchema.optional(),
    /** What the node probed at its last hello. ADR-0023. */
    providers: z.array(RuntimeProbeSchema).max(8).default([]),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const CapabilityGrantSchema = z
  .object({
    id: UuidSchema,
    nodeId: UuidSchema,
    capability: z.string().trim().min(1),
    operationClass: OperationClassSchema,
    constraintsVersion: SchemaVersionSchema,
    constraints: z.unknown(),
    grantedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema.optional(),
    revokedAt: UtcTimestampSchema.optional(),
  })
  .strict();

export const NodeJobSchema = z
  .object({
    id: UuidSchema,
    missionId: UuidSchema.optional(),
    nodeId: UuidSchema.optional(),
    /** A request, not the assignment: `nodeId` still records where it ran. */
    pinnedNodeId: UuidSchema.optional(),
    capability: z.string().trim().min(1),
    status: NodeJobStatusSchema,
    idempotencyKey: IdempotencyKeySchema,
    leaseExpiresAt: UtcTimestampSchema.optional(),
    attempts: z.int().nonnegative(),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    revision: RevisionSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export type NodeStatus = z.infer<typeof NodeStatusSchema>;
export type NodeDescriptor = z.infer<typeof NodeDescriptorSchema>;
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;
export type NodeJob = z.infer<typeof NodeJobSchema>;

/* -------------------------------------------------------------------------- */
/* Phase 3: the worker protocol.                                              */
/* -------------------------------------------------------------------------- */

/** Versioned independently of the client envelope: the two realms are not one protocol. */
export const NODE_ENVELOPE_VERSION = 1;

/**
 * Every capability a node may be granted. Phase 3 ships three deterministic
 * read-only adapters; a capability absent from this list cannot be granted,
 * enqueued, or executed, because all three paths parse through here.
 */
export const NODE_CAPABILITIES = [
  "environment.inspect",
  "file.search",
  "verification.noop",
  /** Phase 10: one conversational turn on a spawned runtime. */
  "runtime.turn",
  /** v1 S4: the owner browsing and opening files in a granted root. */
  "file.list",
  "file.read",
] as const;

export const NodeCapabilitySchema = z.enum(NODE_CAPABILITIES);

export type NodeCapability = z.infer<typeof NodeCapabilitySchema>;

/**
 * The consequence class of each capability, fixed by the capability rather than
 * supplied by whoever issues the grant.
 *
 * A grant that named its own operation class could claim `read_inspect` for a
 * destructive capability and the authority policy would believe it. The
 * capability is the thing with consequences, so the capability owns the class.
 */
export const CAPABILITY_OPERATION_CLASS = {
  "environment.inspect": "read_inspect",
  "file.search": "read_inspect",
  "verification.noop": "read_inspect",
  /**
   * A turn reads and talks. Anything consequential the runtime wants mid-turn
   * arrives as an `ask` and is classed by its own capability, not by this one.
   */
  "runtime.turn": "read_inspect",
  "file.list": "read_inspect",
  "file.read": "read_inspect",
} as const satisfies Record<NodeCapability, z.infer<typeof OperationClassSchema>>;

/**
 * Grants that cover more than their own capability. A folder granted to the
 * agents is a folder the owner may open: a `runtime.turn` grant already lets
 * the core have an agent read anything in it, so listing and reading it
 * directly is less, not more. Roots stay on the `runtime.turn` grant, so there
 * is one list of shared folders per PC rather than two that drift apart.
 */
const GRANT_ALSO_COVERS: Partial<Record<NodeCapability, readonly NodeCapability[]>> = {
  "runtime.turn": ["file.list", "file.read"],
};

/** Whether a grant of `granted` lets a node run a job of `capability`. */
export function grantCovers(granted: string, capability: NodeCapability): boolean {
  return (
    granted === capability ||
    (GRANT_ALSO_COVERS[granted as NodeCapability]?.includes(capability) ?? false)
  );
}

/** No parameters: the adapter reports the environment it is already running in. */
export const EnvironmentInspectPayloadSchema = z.object({}).strict();

export const EnvironmentInspectEvidenceSchema = z
  .object({
    platform: z.string().trim().min(1).max(64),
    arch: z.string().trim().min(1).max(64),
    nodeVersion: z.string().trim().min(1).max(64),
    cpuCount: z.int().positive().max(4096),
    totalMemoryBytes: z.int().positive(),
  })
  .strict();

/**
 * `rootGrantId` is an opaque grant id, never a path — Section 10: "file roots and
 * browser profiles by opaque grant ID". A payload naming a path directly would
 * let the requester choose what the node reads.
 */
export const FileSearchPayloadSchema = z
  .object({
    rootGrantId: z.string().trim().min(1).max(128),
    /**
     * A case-insensitive substring, deliberately not a regular expression. This
     * value can originate from a model, and a model-supplied regex is a
     * catastrophic-backtracking denial of service against the node.
     */
    nameContains: z.string().trim().min(1).max(200),
    maxResults: z.int().positive().max(500).default(50),
  })
  .strict();

export const FileSearchEvidenceSchema = z
  .object({
    matches: z
      .array(
        z
          .object({ relativePath: z.string().min(1).max(1024), sizeBytes: z.int().nonnegative() })
          .strict(),
      )
      .max(500),
    truncated: z.boolean(),
  })
  .strict();

/**
 * A path inside a granted root, `/`-separated, `""` for the root itself. Every
 * form that could name something outside the root is refused here, before a
 * node sees it; the node still resolves the result and checks containment,
 * because a junction inside the root points wherever it likes.
 */
export const FileRelativePathSchema = z
  .string()
  .max(1024)
  .refine(
    (path) =>
      path === "" ||
      path
        .split("/")
        .every(
          (segment) =>
            segment !== "" && segment !== "." && segment !== ".." && !/[\\:\0]/.test(segment),
        ),
    "must be a relative path inside the root",
  );

export const FileListPayloadSchema = z
  .object({
    rootGrantId: z.string().trim().min(1).max(128),
    relativePath: FileRelativePathSchema,
  })
  .strict();

/** ponytail: one page per folder. Paging when a real folder outgrows it. */
export const MAX_FILE_LIST_ENTRIES = 2_000;

export const FileListEvidenceSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            name: z.string().min(1).max(255),
            kind: z.enum(["file", "directory"]),
            sizeBytes: z.int().nonnegative(),
            modifiedAt: UtcTimestampSchema,
          })
          .strict(),
      )
      .max(MAX_FILE_LIST_ENTRIES),
    truncated: z.boolean(),
  })
  .strict();

/**
 * One byte range of one file. The bytes do not travel in the evidence: the
 * node streams them to `POST /node/files` for this job, and the core pipes
 * them to whoever asked. Evidence records only what was sent.
 */
export const FileReadPayloadSchema = z
  .object({
    rootGrantId: z.string().trim().min(1).max(128),
    relativePath: FileRelativePathSchema.refine((path) => path !== "", "must name a file"),
    offset: z.int().nonnegative(),
    /** Absent reads to the end of the file. */
    length: z.int().positive().optional(),
  })
  .strict();

export const FileReadEvidenceSchema = z
  .object({ sizeBytes: z.int().nonnegative(), sentBytes: z.int().nonnegative() })
  .strict();

export const VerificationNoopPayloadSchema = z
  .object({ note: z.string().trim().max(200).optional() })
  .strict();

/** A literal, not a boolean: a "verification" that can report false is a result. */
export const VerificationNoopEvidenceSchema = z.object({ verified: z.literal(true) }).strict();

/**
 * The payload a job of each capability accepts, and the evidence it must return.
 *
 * Both directions parse against the same table, so a node cannot answer a job
 * with evidence of some other shape and have the core record it as a result.
 * Section 10 step 7: "Core verifies result schema, commits state".
 */
export const CAPABILITY_CONTRACTS = {
  "environment.inspect": {
    payload: EnvironmentInspectPayloadSchema,
    evidence: EnvironmentInspectEvidenceSchema,
  },
  "file.search": { payload: FileSearchPayloadSchema, evidence: FileSearchEvidenceSchema },
  "verification.noop": {
    payload: VerificationNoopPayloadSchema,
    evidence: VerificationNoopEvidenceSchema,
  },
  "runtime.turn": { payload: RuntimeTurnPayloadSchema, evidence: RuntimeTurnEvidenceSchema },
  "file.list": { payload: FileListPayloadSchema, evidence: FileListEvidenceSchema },
  "file.read": { payload: FileReadPayloadSchema, evidence: FileReadEvidenceSchema },
} as const satisfies Record<NodeCapability, { payload: z.ZodType; evidence: z.ZodType }>;

/**
 * Constraints stored on a `file.search` grant. The path is the node's, chosen by
 * the operator at grant time; a requester only ever names the grant id.
 */
export const FileSearchConstraintsSchema = z
  .object({
    roots: z
      .array(
        z
          .object({ grantId: z.string().trim().min(1).max(128), path: z.string().trim().min(1) })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();

/** What the node agent persists locally after pairing. The core stores none of it. */
export const NodeCredentialSchema = z
  .object({
    coreUrl: z.string().trim().min(1),
    nodeId: UuidSchema,
    generation: z.int().nonnegative(),
    credential: z.string().min(32),
  })
  .strict();

/** The signed unit of work. Sent as JSON text so the signature covers exact bytes. */
export const NodeJobAssignmentSchema = z
  .object({
    jobId: UuidSchema,
    nodeId: UuidSchema,
    capability: NodeCapabilitySchema,
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    idempotencyKey: IdempotencyKeySchema,
    leaseExpiresAt: UtcTimestampSchema,
    attempt: z.int().positive(),
  })
  .strict();

const NodeEnvelopeVersionSchema = z.literal(NODE_ENVELOPE_VERSION);

const HexSignatureSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Node -> core. No frame carries the node's identity; the credential establishes it. */
export const NodeFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("hello"),
      envelopeVersion: NodeEnvelopeVersionSchema,
      agentVersion: z.string().trim().min(1).max(64),
      /** What the agent can actually run. The core intersects it with the grants. */
      capabilities: z.array(NodeCapabilitySchema).max(NODE_CAPABILITIES.length),
      /** What it probed. A mode string per provider, never a token. */
      providers: z.array(RuntimeProbeSchema).max(8).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("progress"),
      envelopeVersion: NodeEnvelopeVersionSchema,
      jobId: UuidSchema,
      percent: z.int().min(0).max(100),
      note: z.string().trim().max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("result"),
      envelopeVersion: NodeEnvelopeVersionSchema,
      jobId: UuidSchema,
      outcome: z.enum(["succeeded", "failed"]),
      /** Parsed against the job's capability evidence schema, never trusted as-is. */
      evidence: z.unknown(),
      failureReason: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
  /** One item of a turn. `sequence` orders items within the job; the core persists them. */
  z
    .object({
      kind: z.literal("stream"),
      envelopeVersion: NodeEnvelopeVersionSchema,
      jobId: UuidSchema,
      sequence: z.int().nonnegative(),
      item: RuntimeItemSchema,
    })
    .strict(),
  /** A token delta. Forwarded to clients, never persisted. */
  z
    .object({
      kind: z.literal("delta"),
      envelopeVersion: NodeEnvelopeVersionSchema,
      jobId: UuidSchema,
      delta: RuntimeDeltaSchema,
    })
    .strict(),
  /** The runtime is blocked on a consequential act until `answer` arrives. */
  z
    .object({
      kind: z.literal("ask"),
      envelopeVersion: NodeEnvelopeVersionSchema,
      jobId: UuidSchema,
      ask: RuntimeAskSchema,
    })
    .strict(),
  /** The runtime hands work to another agent and waits for `delegated`. */
  z
    .object({
      kind: z.literal("delegate"),
      envelopeVersion: NodeEnvelopeVersionSchema,
      jobId: UuidSchema,
      delegation: RuntimeDelegationSchema,
    })
    .strict(),
]);

/** Core -> node. */
export const NodeServerFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("welcome"),
      envelopeVersion: NodeEnvelopeVersionSchema,
      nodeId: UuidSchema,
      /**
       * The rotated credential for the next connection. The previous generation
       * stays valid, so an agent that dies before persisting this is not locked
       * out — it reconnects on the credential it already had.
       */
      generation: z.int().nonnegative(),
      credential: z.string().min(32),
      grants: z.array(CapabilityGrantSchema).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("job"),
      envelopeVersion: NodeEnvelopeVersionSchema,
      /**
       * `NodeJobAssignment` as JSON text, signed verbatim. Signing the exact
       * bytes on the wire rather than a re-serialised object means the two sides
       * never have to agree on key order, which is the usual way a signature
       * over structured data quietly stops verifying.
       */
      assignment: z.string().min(1).max(64_000),
      signature: HexSignatureSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cancel"),
      envelopeVersion: NodeEnvelopeVersionSchema,
      jobId: UuidSchema,
    })
    .strict(),
  /** The core's decision on an `ask`. The node forwards it; the runtime never decides. */
  z
    .object({
      kind: z.literal("answer"),
      envelopeVersion: NodeEnvelopeVersionSchema,
      jobId: UuidSchema,
      answer: RuntimeAnswerSchema,
    })
    .strict(),
  /** How a `delegate` ended: the child thread, its reply and what it produced. */
  z
    .object({
      kind: z.literal("delegated"),
      envelopeVersion: NodeEnvelopeVersionSchema,
      jobId: UuidSchema,
      result: RuntimeDelegationResultSchema,
    })
    .strict(),
]);

export type NodeJobAssignment = z.infer<typeof NodeJobAssignmentSchema>;
export type NodeCredential = z.infer<typeof NodeCredentialSchema>;
export type NodeFrame = z.infer<typeof NodeFrameSchema>;
export type NodeServerFrame = z.infer<typeof NodeServerFrameSchema>;
export type FileSearchConstraints = z.infer<typeof FileSearchConstraintsSchema>;
export type FileSearchPayload = z.infer<typeof FileSearchPayloadSchema>;
export type FileListEvidence = z.infer<typeof FileListEvidenceSchema>;
export type FileReadPayload = z.infer<typeof FileReadPayloadSchema>;
