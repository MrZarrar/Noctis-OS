import type {
  OpenRemoteDesktopCommand,
  RemoteDesktopSession,
  RemoteDesktopTarget,
} from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";

import type { RemoteDesktopConfig } from "../config/server.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";

import { mintGatewayToken } from "./gateway-token.js";

/** Names only. The Gateway URL and the destination are the core's to use, not a page's to choose. */
export function listRemoteHosts(remote: RemoteDesktopConfig | undefined): RemoteDesktopTarget[] {
  return (remote?.targets ?? []).map((target) => ({ host: target.host }));
}

/**
 * Mints a Gateway session token for one allowlisted host (ADR-0035).
 *
 * A user command, through the same idempotent, ledgered path as every other
 * command, so the audit trail shows who opened a remote session to where and
 * when. It is not an `authority.request`: that boundary exists for acts an
 * identity proposes, and a person pressing Connect in their own authenticated
 * session is the consequence boundary itself.
 *
 * The event carries everything about the session except the token. The token
 * is a bearer credential for two minutes; the ledger is forever. A replayed
 * key is answered by the conflict path and mints nothing — handing out a
 * second live token under an old key would make the key mean nothing.
 */
export function openRemoteDesktop(
  kernel: Kernel,
  context: CommandContext,
  command: OpenRemoteDesktopCommand,
  remote: RemoteDesktopConfig | undefined,
): Result<RemoteDesktopSession> {
  const target = remote?.targets.find((candidate) => candidate.host === command.host);

  if (remote === undefined || target === undefined) {
    return conflict({ kind: "not_found", entity: "remote_host", id: command.host });
  }

  const associationId = kernel.ids.nextId();
  const now = kernel.clock.now();
  const minted = mintGatewayToken({
    privateKey: remote.privateKey,
    destination: target.destination,
    associationId,
    tokenId: kernel.ids.nextId(),
    now,
  });

  return runCommand<RemoteDesktopSession>(
    kernel,
    { scope: "remote.open_session", key: command.idempotencyKey, resultId: associationId },
    () =>
      ok({
        value: {
          host: target.host,
          gatewayUrl: target.gatewayUrl,
          destination: target.destination,
          token: minted.token,
          associationId,
          expiresAt: minted.expiresAt,
        },
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "remote",
            streamId: associationId,
            type: "remote.session_opened.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              host: target.host,
              destination: target.destination,
              gatewayUrl: target.gatewayUrl,
              associationId,
              expiresAt: minted.expiresAt,
            },
            correlationId: context.correlationId,
            occurredAt: new Date(now).toISOString(),
          },
        ],
      }),
  );
}
