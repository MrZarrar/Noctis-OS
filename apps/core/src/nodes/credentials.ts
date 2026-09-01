import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Node credentials are derived, never stored.
 *
 * `migrations/0001_foundation.sql` opens with "No secrets are stored in this
 * database", and that rules out the obvious design: a random per-node secret,
 * kept so the core can both verify a connection and sign the jobs it sends. A
 * digest would satisfy the rule but cannot sign anything, because a digest is
 * not recoverable.
 *
 * So the credential is a pure function of the core token, the node id, and a
 * generation counter. The database holds one integer per node; the core
 * recomputes the credential whenever it needs to verify or sign, and the only
 * copy at rest lives in the node agent's own credential file on its own machine.
 *
 * ponytail: rotating NOCTIS_CORE_TOKEN invalidates every node credential at
 * once and every node must re-pair. That is the correct blast radius for a
 * compromised core token, but it does mean the two rotations are coupled. Give
 * nodes their own root key if they ever need to outlive a core token rotation.
 */
const CREDENTIAL_DOMAIN = "noctis.node.credential.v1";
const SIGNATURE_DOMAIN = "noctis.node.assignment.v1";

const BEARER = /^Bearer ([0-9a-f-]{36})\.([0-9a-f]{64})$/;

export interface NodeAuthorization {
  nodeId: string;
  credential: string;
}

export function deriveCredential(coreToken: string, nodeId: string, generation: number): string {
  return createHmac("sha256", coreToken)
    .update(`${CREDENTIAL_DOMAIN}:${nodeId}:${String(generation)}`)
    .digest("hex");
}

/**
 * Same digest-then-compare shape as the client bearer check in `api/auth.ts`:
 * `timingSafeEqual` throws on a length mismatch, and an exception thrown only
 * for wrong-length input is itself a timing signal.
 */
function constantTimeEquals(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left, "utf8").digest(),
    createHash("sha256").update(right, "utf8").digest(),
  );
}

export function parseNodeAuthorization(header: string | undefined): NodeAuthorization | undefined {
  const match = header === undefined ? null : BEARER.exec(header);

  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }

  return { nodeId: match[1], credential: match[2] };
}

export interface CredentialCheck {
  coreToken: string;
  nodeId: string;
  /** The node's current generation, as recorded in the `nodes` row. */
  generation: number;
  presented: string;
}

/**
 * Accepts the current generation and the one before it.
 *
 * The core rotates on every connection, and it commits the rotation before the
 * agent has persisted the new value. Without a two-generation window an agent
 * that dies in that gap could never reconnect: it would hold a credential the
 * core had already moved past, with no way to pair again except an operator
 * issuing a fresh code.
 */
export function verifyCredential(check: CredentialCheck): boolean {
  const current = constantTimeEquals(
    check.presented,
    deriveCredential(check.coreToken, check.nodeId, check.generation),
  );

  // Computed unconditionally rather than behind `||`, so the time taken does not
  // reveal which generation matched.
  const previous =
    check.generation > 0 &&
    constantTimeEquals(
      check.presented,
      deriveCredential(check.coreToken, check.nodeId, check.generation - 1),
    );

  return current || previous;
}

/**
 * Signs the exact JSON text of an assignment.
 *
 * Signing bytes rather than a re-serialised object means the two sides never
 * have to agree on key order — the usual way a signature over structured data
 * quietly stops verifying. The channel is already authenticated, so this is
 * defence in depth: it binds a job to the one node whose credential can verify
 * it, which is what stops a job frame being replayed onto a different socket.
 */
export function signAssignment(credential: string, assignmentJson: string): string {
  return createHmac("sha256", credential)
    .update(`${SIGNATURE_DOMAIN}:${assignmentJson}`)
    .digest("hex");
}

export function verifyAssignment(
  credential: string,
  assignmentJson: string,
  signature: string,
): boolean {
  return constantTimeEquals(signature, signAssignment(credential, assignmentJson));
}

/** 128 bits of one-time pairing code. Hex so it survives a copy-paste intact. */
export function newPairingCode(): string {
  return randomBytes(16).toString("hex");
}

/** Only the digest is persisted. A digest of a one-time code is not a secret. */
export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}
