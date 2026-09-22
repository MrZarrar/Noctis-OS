import { generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GATEWAY_TOKEN_LIFETIME_SECONDS, mintGatewayToken } from "./gateway-token.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("mintGatewayToken", () => {
  const now = Date.parse("2026-09-22T22:00:00.000Z");
  const minted = mintGatewayToken({
    privateKey,
    destination: "zarrarpc.tail9594ed.ts.net:3389",
    associationId: "0190f5a0-0000-7000-8000-000000000001",
    tokenId: "0190f5a0-0000-7000-8000-000000000002",
    now,
  });

  it("is the association token New-DGatewayToken mints, signed by the provisioner key", () => {
    const [header, payload, signature] = minted.token.split(".");

    expect(decode(header ?? "")).toEqual({ alg: "RS256", typ: "JWT", cty: "ASSOCIATION" });
    expect(decode(payload ?? "")).toEqual({
      iat: now / 1000,
      nbf: now / 1000,
      exp: now / 1000 + GATEWAY_TOKEN_LIFETIME_SECONDS,
      jti: "0190f5a0-0000-7000-8000-000000000002",
      jet_ap: "rdp",
      jet_cm: "fwd",
      jet_aid: "0190f5a0-0000-7000-8000-000000000001",
      dst_hst: "zarrarpc.tail9594ed.ts.net:3389",
    });
    // RS256 is RSASSA-PKCS1-v1_5 over SHA-256, which is node's default for an RSA key.
    expect(
      verify(
        "sha256",
        Buffer.from(`${header ?? ""}.${payload ?? ""}`),
        publicKey,
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
  });

  it("expires seconds after it is minted, because it only has to outlive the handshake", () => {
    // The Gateway adds ~5 min of leeway past exp and does not refuse a replayed
    // jti (remote-access.md §9.5), so the lifetime is the only part of the
    // replay window the core controls.
    expect(GATEWAY_TOKEN_LIFETIME_SECONDS).toBeLessThanOrEqual(30);
    expect(minted.expiresAt).toBe(
      new Date(now + GATEWAY_TOKEN_LIFETIME_SECONDS * 1000).toISOString(),
    );
  });

  it("is refused by the matching key once the destination is edited", () => {
    const [header, payload, signature] = minted.token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...decode(payload ?? ""), dst_hst: "elsewhere:3389" }),
    ).toString("base64url");

    expect(
      verify(
        "sha256",
        Buffer.from(`${header ?? ""}.${forged}`),
        publicKey,
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(false);
  });
});
