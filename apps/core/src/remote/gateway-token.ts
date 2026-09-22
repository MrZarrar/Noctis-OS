import type { KeyObject } from "node:crypto";
import { sign } from "node:crypto";

/**
 * Thirty seconds, not `New-DGatewayToken`'s two-minute default. The token only
 * has to get the page through the RDCleanPath handshake, which it reaches
 * milliseconds after minting; the RDP session it opens outlives it.
 *
 * Short because it is most of the replay window this side controls. Measured
 * against Gateway 2026.3.0 (remote-access.md §9.5): it accepts the same token
 * twice, it still honours a token about five minutes past `exp`, and it took
 * one whose `nbf` was two minutes ahead — so clock skew between the core and
 * the Gateway needs no allowance here either.
 */
export const GATEWAY_TOKEN_LIFETIME_SECONDS = 30;

export interface MintGatewayTokenInput {
  /** The provisioner private key. The Gateway holds only the public half. */
  privateKey: KeyObject;
  /** `host:port` of the RDP listener, from the core's allowlist and never from a page. */
  destination: string;
  associationId: string;
  tokenId: string;
  /** Epoch milliseconds. */
  now: number;
}

export interface MintedGatewayToken {
  token: string;
  expiresAt: string;
}

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * A Devolutions Gateway association token for RDP forwarding.
 *
 * The claims are the ones the Gateway's own `New-DGatewayToken -Type
 * ASSOCIATION` writes, read from the installed module rather than recalled
 * (docs/operations/remote-access.md §9.2). `dst_hst` sits inside the
 * signature, so the Gateway will dial the destination the core chose and no
 * other.
 *
 * `node:crypto` rather than a JWT library: RS256 is `sign("sha256")` with an
 * RSA key, whose default padding is PKCS#1 v1.5, and one algorithm for one
 * token type is not worth a dependency.
 */
export function mintGatewayToken(input: MintGatewayTokenInput): MintedGatewayToken {
  const issuedAt = Math.floor(input.now / 1000);
  const expiresAt = issuedAt + GATEWAY_TOKEN_LIFETIME_SECONDS;
  const unsigned = `${segment({ alg: "RS256", typ: "JWT", cty: "ASSOCIATION" })}.${segment({
    iat: issuedAt,
    nbf: issuedAt,
    exp: expiresAt,
    jti: input.tokenId,
    jet_ap: "rdp",
    jet_cm: "fwd",
    jet_aid: input.associationId,
    dst_hst: input.destination,
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), input.privateKey).toString("base64url");

  return {
    token: `${unsigned}.${signature}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}
