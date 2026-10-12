import { z } from "zod";

import { UtcTimestampSchema, UuidSchema } from "./primitives.js";

/**
 * The live bridge: a session the owner runs in VS Code or the Codex app,
 * reported by that agent's own hooks so Noctis can show it as it happens.
 * Read-only from Noctis; typing into it stays with the agent's own app.
 */

export const BRIDGE_PROVIDERS = ["claude", "codex"] as const;
export const BridgeProviderSchema = z.enum(BRIDGE_PROVIDERS);

/** What a hook saw, as the PC's hook script sends it to `POST /node/bridge`. */
export const BridgeEventSchema = z
  .object({
    providerId: BridgeProviderSchema,
    kind: z.enum(["start", "prompt", "reply", "end"]),
    sessionRef: z.string().trim().min(1).max(200),
    cwd: z.string().trim().min(1).max(1024),
    /** The prompt for `prompt`, the agent's last message for `reply`. */
    text: z.string().max(20_000).optional(),
  })
  .strict();

export const LiveSessionSchema = z
  .object({
    id: UuidSchema,
    nodeId: UuidSchema,
    hostId: z.string(),
    providerId: BridgeProviderSchema,
    sessionRef: z.string(),
    cwd: z.string(),
    /** The first prompt, until the session has one. */
    title: z.string().optional(),
    status: z.enum(["live", "ended"]),
    startedAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const LiveEntrySchema = z
  .object({
    id: UuidSchema,
    role: z.enum(["user", "agent"]),
    body: z.string(),
    createdAt: UtcTimestampSchema,
  })
  .strict();

export type BridgeProviderId = z.infer<typeof BridgeProviderSchema>;
export type BridgeEvent = z.infer<typeof BridgeEventSchema>;
export type LiveSession = z.infer<typeof LiveSessionSchema>;
export type LiveEntry = z.infer<typeof LiveEntrySchema>;
