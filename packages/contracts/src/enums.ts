import { z } from "zod";

export const ConversationalIdentityIdSchema = z.enum(["vesper", "jester"]);
export const ProtocolIdSchema = z.enum(["noir"]);
export const AttentionStateSchema = z.enum([
  "presence",
  "active_canvas",
  "focus",
  "attention_required",
]);

export const ObjectiveStatusSchema = z.enum([
  "suggested",
  "draft",
  "active",
  "paused",
  "completed",
  "abandoned",
]);

export const MissionStatusSchema = z.enum([
  "draft",
  "awaiting_approval",
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
]);

export const SurfaceRoleSchema = z.enum([
  "primary",
  "supporting",
  "context",
  "control",
  "attention",
]);

export const SurfacePersistenceSchema = z.enum(["ephemeral", "objective", "pinned", "restorable"]);

export const SurfaceLifecycleSchema = z.enum([
  "proposed",
  "entering",
  "active",
  "background",
  "exiting",
  "dismissed",
]);

/** Defined by Phase 1: Section 4.2 gives no diagram for node jobs. */
export const NodeJobStatusSchema = z.enum([
  "queued",
  "leased",
  "running",
  "expired",
  "succeeded",
  "failed",
  "cancelled",
]);

export const NoirCaseStatusSchema = z.enum([
  "forming",
  "investigating",
  "synthesising",
  "resolved",
  "blocked",
  "abandoned",
]);

export const OperationClassSchema = z.enum([
  "read_inspect",
  "local_reversible_edit",
  "external_write",
  "message_send",
  "publish",
  "spend",
  "destructive",
  "production_deploy",
  "credential_security",
]);

export type ConversationalIdentityId = z.infer<typeof ConversationalIdentityIdSchema>;
export type ProtocolId = z.infer<typeof ProtocolIdSchema>;
export type AttentionState = z.infer<typeof AttentionStateSchema>;
export type ObjectiveStatus = z.infer<typeof ObjectiveStatusSchema>;
export type MissionStatus = z.infer<typeof MissionStatusSchema>;
export type SurfaceRole = z.infer<typeof SurfaceRoleSchema>;
export type SurfacePersistence = z.infer<typeof SurfacePersistenceSchema>;
export type SurfaceLifecycle = z.infer<typeof SurfaceLifecycleSchema>;
export type NodeJobStatus = z.infer<typeof NodeJobStatusSchema>;
export type NoirCaseStatus = z.infer<typeof NoirCaseStatusSchema>;
export type OperationClass = z.infer<typeof OperationClassSchema>;
