import { z } from "zod";

import { IdempotencyKeySchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

/* -------------------------------------------------------------------------- */
/* Task 3.9: the embedded remote desktop panel (ADR-0035).                    */
/* -------------------------------------------------------------------------- */

/**
 * The name of a remote-desktop target, as the core's own allowlist spells it.
 *
 * A bare lowercase label and nothing that could be an address: no dot, no
 * colon. The page names a host and the core decides where that host is, so
 * the destination signed into the Gateway token is never page input.
 */
export const RemoteHostNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

/**
 * Asks the core for a Gateway session token for one named host.
 *
 * Strict, and with no credential field at all: the Windows password is typed
 * per session and travels page -> Gateway -> RDP (ADR-0035 addendum). A page
 * that sent one anyway gets a 400 rather than having it quietly ignored.
 */
export const OpenRemoteDesktopCommandSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema, host: RemoteHostNameSchema })
  .strict();

/** A configured target as a page may see it: its name, and nothing it could redirect. */
export const RemoteDesktopTargetSchema = z.object({ host: RemoteHostNameSchema }).strict();

/**
 * What the page needs to connect, once.
 *
 * `token` is a Devolutions Gateway association token: RS256, it names
 * `destination` inside its signature, and it expires at `expiresAt`, minutes
 * after it was minted. It is returned and never stored — the ledger records
 * that a session was opened, not the key to it.
 *
 * `wss:` only. The PWA is an https page and a browser refuses `ws:` from it,
 * and the Tauri shell has no reason to be the one client that goes in clear.
 */
export const RemoteDesktopSessionSchema = z
  .object({
    host: RemoteHostNameSchema,
    gatewayUrl: z.url({ protocol: /^wss$/ }),
    destination: z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/),
    token: z.string().min(1),
    associationId: UuidSchema,
    expiresAt: UtcTimestampSchema,
  })
  .strict();

export type RemoteHostName = z.infer<typeof RemoteHostNameSchema>;
export type OpenRemoteDesktopCommand = z.infer<typeof OpenRemoteDesktopCommandSchema>;
export type RemoteDesktopTarget = z.infer<typeof RemoteDesktopTargetSchema>;
export type RemoteDesktopSession = z.infer<typeof RemoteDesktopSessionSchema>;
