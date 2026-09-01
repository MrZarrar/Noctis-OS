import { describe, expect, it } from "vitest";

import {
  deriveCredential,
  hashPairingCode,
  newPairingCode,
  parseNodeAuthorization,
  signAssignment,
  verifyAssignment,
  verifyCredential,
} from "./credentials.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const NODE = "0199a000-0000-7000-8000-00000000000a";
const OTHER = "0199a000-0000-7000-8000-00000000000b";

describe("deriveCredential", () => {
  it("is deterministic for the same core token, node, and generation", () => {
    expect(deriveCredential(TOKEN, NODE, 3)).toBe(deriveCredential(TOKEN, NODE, 3));
  });

  it("differs per generation, per node, and per core token", () => {
    const base = deriveCredential(TOKEN, NODE, 3);

    expect(deriveCredential(TOKEN, NODE, 4)).not.toBe(base);
    expect(deriveCredential(TOKEN, OTHER, 3)).not.toBe(base);
    expect(deriveCredential(`${TOKEN}x`, NODE, 3)).not.toBe(base);
  });

  it("is 64 hex characters, so no credential leaks its own length", () => {
    expect(deriveCredential(TOKEN, NODE, 0)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyCredential", () => {
  it("accepts the current generation", () => {
    expect(
      verifyCredential({
        coreToken: TOKEN,
        nodeId: NODE,
        generation: 7,
        presented: deriveCredential(TOKEN, NODE, 7),
      }),
    ).toBe(true);
  });

  /**
   * The whole reason the window exists: the core rotates before the agent has
   * persisted the new value, so an agent that dies in that gap must still be
   * able to reconnect on what it already had.
   */
  it("accepts the previous generation", () => {
    expect(
      verifyCredential({
        coreToken: TOKEN,
        nodeId: NODE,
        generation: 7,
        presented: deriveCredential(TOKEN, NODE, 6),
      }),
    ).toBe(true);
  });

  it("rejects two generations back", () => {
    expect(
      verifyCredential({
        coreToken: TOKEN,
        nodeId: NODE,
        generation: 7,
        presented: deriveCredential(TOKEN, NODE, 5),
      }),
    ).toBe(false);
  });

  it("rejects another node's credential for the same generation", () => {
    expect(
      verifyCredential({
        coreToken: TOKEN,
        nodeId: NODE,
        generation: 2,
        presented: deriveCredential(TOKEN, OTHER, 2),
      }),
    ).toBe(false);
  });

  it("rejects a credential derived from a different core token", () => {
    expect(
      verifyCredential({
        coreToken: TOKEN,
        nodeId: NODE,
        generation: 2,
        presented: deriveCredential("a different core token that is long enough", NODE, 2),
      }),
    ).toBe(false);
  });

  it("does not look behind generation 0", () => {
    expect(verifyCredential({ coreToken: TOKEN, nodeId: NODE, generation: 0, presented: "" })).toBe(
      false,
    );
  });

  it("rejects a wrong-length value without throwing", () => {
    expect(
      verifyCredential({ coreToken: TOKEN, nodeId: NODE, generation: 1, presented: "short" }),
    ).toBe(false);
  });
});

describe("parseNodeAuthorization", () => {
  it("splits a well-formed node bearer header", () => {
    const credential = deriveCredential(TOKEN, NODE, 0);

    expect(parseNodeAuthorization(`Bearer ${NODE}.${credential}`)).toEqual({
      nodeId: NODE,
      credential,
    });
  });

  it.each([
    ["absent", undefined],
    ["not a bearer header", "Basic abc"],
    ["missing the credential", `Bearer ${NODE}`],
    ["missing the node id", `Bearer .${deriveCredential(TOKEN, NODE, 0)}`],
    ["a client token", `Bearer ${TOKEN}`],
    ["a non-hex credential", `Bearer ${NODE}.${"z".repeat(64)}`],
  ])("returns undefined when the header is %s", (_label, header) => {
    expect(parseNodeAuthorization(header)).toBeUndefined();
  });
});

describe("signAssignment", () => {
  const credential = deriveCredential(TOKEN, NODE, 1);
  const json = '{"jobId":"a","capability":"verification.noop"}';

  it("verifies the exact bytes it signed", () => {
    expect(verifyAssignment(credential, json, signAssignment(credential, json))).toBe(true);
  });

  it("fails when a single byte of the assignment changes", () => {
    const signature = signAssignment(credential, json);

    expect(verifyAssignment(credential, `${json} `, signature)).toBe(false);
  });

  it("fails under another node's credential, which is what binds a job to a node", () => {
    const signature = signAssignment(credential, json);

    expect(verifyAssignment(deriveCredential(TOKEN, OTHER, 1), json, signature)).toBe(false);
  });

  it("rejects a wrong-length signature without throwing", () => {
    expect(verifyAssignment(credential, json, "nope")).toBe(false);
  });
});

describe("pairing codes", () => {
  it("issues 128 bits of hex", () => {
    expect(newPairingCode()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("does not repeat", () => {
    const codes = new Set(Array.from({ length: 64 }, () => newPairingCode()));

    expect(codes.size).toBe(64);
  });

  it("hashes to a stable digest that is not the code", () => {
    const code = newPairingCode();

    expect(hashPairingCode(code)).toBe(hashPairingCode(code));
    expect(hashPairingCode(code)).not.toContain(code);
  });
});
