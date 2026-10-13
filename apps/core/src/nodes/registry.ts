import type {
  CapabilityGrant,
  GrantNodeCapabilityCommand,
  IssueNodePairingCodeCommand,
  NodeDescriptor,
  PairNodeRequest,
  RevokeNodeCommand,
  RuntimeProbe,
  RuntimeProviderId,
  RuntimeRoot,
  UnshareNodeFolderCommand,
} from "@noctis/contracts";
import {
  CAPABILITY_OPERATION_CLASS,
  CapabilityGrantSchema,
  FileSearchConstraintsSchema,
  NodeDescriptorSchema,
  RuntimeGrantConstraintsSchema,
  RuntimeProbeSchema,
} from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { EventDraft } from "../db/events.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import { deriveCredential, hashPairingCode, newPairingCode } from "./credentials.js";
import type { RouteCandidate } from "./router.js";

/** A pairing code is useless after this; the operator issues another. */
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

type NodeRow = {
  id: string;
  host_id: string;
  status: string;
  fingerprint: string;
  agent_version: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  providers_json: string;
  created_at: string;
  updated_at: string;
};

const NODE_COLUMNS = `id, host_id, status, fingerprint, agent_version, last_seen_at, revoked_at,
                      providers_json, created_at, updated_at`;

/** A bad row throws, like every other parse here: a node whose probes cannot be read is not a node to route to. */
const ProbesSchema = RuntimeProbeSchema.array();

function toDescriptor(row: NodeRow): NodeDescriptor {
  return NodeDescriptorSchema.parse({
    id: row.id,
    hostId: row.host_id,
    status: row.status,
    fingerprint: row.fingerprint,
    agentVersion: row.agent_version,
    ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    providers: ProbesSchema.parse(JSON.parse(row.providers_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function getNode(db: NoctisDatabase, id: string): NodeDescriptor | undefined {
  const row = db.prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`).get(id) as
    NodeRow | undefined;

  return row === undefined ? undefined : toDescriptor(row);
}

export function listNodes(db: NoctisDatabase, limit: number): NodeDescriptor[] {
  const rows = db
    .prepare(`SELECT ${NODE_COLUMNS} FROM nodes ORDER BY id LIMIT ?`)
    .all(limit) as NodeRow[];

  return rows.map(toDescriptor);
}

/** The generation a credential must be derived from. Absent means no such node. */
export function getCredentialGeneration(db: NoctisDatabase, nodeId: string): number | undefined {
  const row = db
    .prepare("SELECT credential_generation AS g FROM nodes WHERE id = ?")
    .get(nodeId) as { g: number } | undefined;

  return row?.g;
}

type GrantRow = {
  id: string;
  node_id: string;
  capability: string;
  operation_class: string;
  constraints_version: number;
  constraints_json: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

const GRANT_COLUMNS = `id, node_id, capability, operation_class, constraints_version,
                       constraints_json, granted_at, expires_at, revoked_at`;

function toGrant(row: GrantRow): CapabilityGrant {
  return CapabilityGrantSchema.parse({
    id: row.id,
    nodeId: row.node_id,
    capability: row.capability,
    operationClass: row.operation_class,
    constraintsVersion: row.constraints_version,
    constraints: JSON.parse(row.constraints_json) as unknown,
    grantedAt: row.granted_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  });
}

export function listGrants(db: NoctisDatabase, nodeId: string): CapabilityGrant[] {
  const rows = db
    .prepare(`SELECT ${GRANT_COLUMNS} FROM node_capabilities WHERE node_id = ? ORDER BY id`)
    .all(nodeId) as GrantRow[];

  return rows.map(toGrant);
}

/**
 * Everything the router needs except liveness, which the row cannot answer: a
 * `nodes.status` of `online` only means the last thing that happened was a
 * connect. The dispatcher fills `connected` from the sockets it actually holds.
 */
export function listRouteCandidates(db: NoctisDatabase): Array<Omit<RouteCandidate, "connected">> {
  const rows = db
    .prepare(
      `SELECT n.id AS id, n.host_id AS host_id, n.status AS status,
              (SELECT COUNT(*) FROM node_jobs j
                WHERE j.node_id = n.id AND j.status IN ('leased', 'running')) AS active_leases
         FROM nodes n
        ORDER BY n.id`,
    )
    .all() as Array<{ id: string; host_id: string; status: string; active_leases: number }>;

  return rows.map((row) => ({
    nodeId: row.id,
    hostId: row.host_id,
    status: NodeDescriptorSchema.shape.status.parse(row.status),
    activeLeases: row.active_leases,
    grants: listGrants(db, row.id).map((grant) => ({
      capability: grant.capability,
      ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
      ...(grant.revokedAt === undefined ? {} : { revokedAt: grant.revokedAt }),
    })),
  }));
}

/**
 * One node x one probed provider. The first six fields are what the domain's
 * `chooseProvider` reads; `roots` is what the dispatcher needs once it has chosen.
 */
export interface RuntimeCandidate {
  nodeId: string;
  hostId: string;
  connected: boolean;
  /** A live `runtime.turn` grant on this node names this provider. */
  granted: boolean;
  probe: RuntimeProbe;
  /** Every required root grant id is among this node's granted roots. */
  hasRoots: boolean;
  roots: RuntimeRoot[];
}

/**
 * Everything the provider chooser needs. Ordered by node then provider so the
 * same state always yields the same list, for the same reason `routeJob` sorts.
 */
export function listRuntimeCandidates(
  db: NoctisDatabase,
  isConnected: (nodeId: string) => boolean,
  requiredRootGrantIds: readonly string[],
  /** Epoch milliseconds from the injected clock, for grant expiry. */
  now: number,
): RuntimeCandidate[] {
  const nodes = db
    .prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE status != 'revoked' ORDER BY id`)
    .all() as NodeRow[];
  const candidates: RuntimeCandidate[] = [];

  for (const row of nodes) {
    const node = toDescriptor(row);
    const grants = listGrants(db, node.id).filter(
      (grant) =>
        grant.capability === "runtime.turn" &&
        grant.revokedAt === undefined &&
        (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now),
    );
    const probes = [...node.providers].sort((left, right) =>
      left.providerId.localeCompare(right.providerId),
    );

    for (const probe of probes) {
      // Every grant naming this agent counts, as it does on the node: a folder
      // shared later arrives as a grant of its own beside the first.
      const granted = grants
        .map((grant) => RuntimeGrantConstraintsSchema.parse(grant.constraints))
        .filter((constraints) => constraints.providers.includes(probe.providerId));
      const roots = [
        ...new Map(
          granted.flatMap((constraints) => constraints.roots).map((root) => [root.grantId, root]),
        ).values(),
      ];
      const rootIds = new Set(roots.map((root) => root.grantId));

      candidates.push({
        nodeId: node.id,
        hostId: node.hostId,
        connected: isConnected(node.id),
        granted: granted.length > 0,
        probe,
        hasRoots: requiredRootGrantIds.every((id) => rootIds.has(id)),
        roots,
      });
    }
  }

  return candidates;
}

/**
 * A folder a live node shares with its agents, read from the grants rather
 * than from the probed runtimes: a folder is shared whether or not an agent
 * happens to be installed beside it. Undefined for a revoked node, or a folder
 * no live `runtime.turn` grant names.
 */
export function sharedFolder(
  db: NoctisDatabase,
  nodeId: string,
  rootGrantId: string,
  /** Epoch milliseconds from the injected clock, for grant expiry. */
  now: number,
): { hostId: string; providers: RuntimeProviderId[] } | undefined {
  const node = getNode(db, nodeId);

  if (node === undefined || node.status === "revoked") {
    return undefined;
  }

  const providers = new Set<RuntimeProviderId>();

  for (const grant of listGrants(db, nodeId)) {
    if (
      grant.capability !== "runtime.turn" ||
      grant.revokedAt !== undefined ||
      (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now)
    ) {
      continue;
    }

    const constraints = RuntimeGrantConstraintsSchema.parse(grant.constraints);

    if (constraints.roots.some((root) => root.grantId === rootGrantId)) {
      constraints.providers.forEach((provider) => providers.add(provider));
    }
  }

  return providers.size === 0 ? undefined : { hostId: node.hostId, providers: [...providers] };
}

/** A granted root a turn can be pinned to, named for a person rather than for a router. */
export interface RuntimeRootOption {
  grantId: string;
  path: string;
  mode: "read" | "write";
  localOnly: boolean;
  nodeId: string;
  hostId: string;
  connected: boolean;
}

/**
 * Every root a turn could name, across every node.
 *
 * Offline nodes are included, and that is the point (task 2.6): a folder that
 * exists on a machine which happens to be asleep is still the folder the owner
 * means, and answering "that machine is offline" is more useful than quietly
 * omitting the only root they were looking for.
 *
 * Deduplicated by node and grant id. Two probes on the same node
 * both carry it, and listing it twice would make the page show it twice.
 */
export function listRuntimeRoots(
  db: NoctisDatabase,
  isConnected: (nodeId: string) => boolean,
  now: number,
): RuntimeRootOption[] {
  const seen = new Map<string, RuntimeRootOption>();

  for (const candidate of listRuntimeCandidates(db, isConnected, [], now)) {
    for (const root of candidate.roots) {
      const key = JSON.stringify([candidate.nodeId, root.grantId]);
      if (!seen.has(key)) {
        seen.set(key, {
          grantId: root.grantId,
          path: root.path,
          mode: root.mode,
          localOnly: root.localOnly,
          nodeId: candidate.nodeId,
          hostId: candidate.hostId,
          connected: candidate.connected,
        });
      }
    }
  }

  return [...seen.values()].sort(
    (left, right) => left.hostId.localeCompare(right.hostId) || left.path.localeCompare(right.path),
  );
}

export interface IssuedPairingCode {
  pairingCodeId: string;
  /** Returned exactly once. Only its digest is stored, so no replay can repeat it. */
  code: string;
  hostId: string;
  expiresAt: string;
}

export interface PairingCodeRecord {
  pairingCodeId: string;
  hostId: string;
  expiresAt: string;
  consumed: boolean;
}

/**
 * Reads back an issued code without its code.
 *
 * This is what an idempotent replay of `node.issue_pairing_code` answers with,
 * and it is deliberately a different shape from the first response: the core
 * kept only a digest, so it cannot hand the code out twice even to the caller
 * that asked for it. A retry learns that the code exists and when it expires.
 */
export function getPairingCode(
  db: NoctisDatabase,
  pairingCodeId: string,
): PairingCodeRecord | undefined {
  const row = db
    .prepare("SELECT id, host_id, expires_at, consumed_at FROM node_pairing_codes WHERE id = ?")
    .get(pairingCodeId) as
    { id: string; host_id: string; expires_at: string; consumed_at: string | null } | undefined;

  return row === undefined
    ? undefined
    : {
        pairingCodeId: row.id,
        hostId: row.host_id,
        expiresAt: row.expires_at,
        consumed: row.consumed_at !== null,
      };
}

export function issuePairingCode(
  kernel: Kernel,
  context: CommandContext,
  command: IssueNodePairingCodeCommand,
): Result<IssuedPairingCode> {
  const id = kernel.ids.nextId();
  const now = kernel.clock.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PAIRING_CODE_TTL_MS).toISOString();
  const code = newPairingCode();

  return runCommand<IssuedPairingCode>(
    kernel,
    { scope: "node.issue_pairing_code", key: command.idempotencyKey, resultId: id },
    (tx) => {
      tx.prepare(
        `INSERT INTO node_pairing_codes (id, code_hash, host_id, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, hashPairingCode(code), command.hostId, issuedAt, expiresAt);

      // No event: issuing a code authorises nothing on its own, and an event
      // naming the host a code was cut for is a list of pairing attempts an
      // audit reader would have to be told to ignore. `node.paired.v1` records
      // the moment the code is actually spent.
      return ok({
        value: { pairingCodeId: id, code, hostId: command.hostId, expiresAt },
        events: [],
      });
    },
  );
}

export interface PairedNode {
  nodeId: string;
  generation: number;
  credential: string;
  hostId: string;
}

/**
 * Redeems a one-time code and returns the node's first credential.
 *
 * A wrong code, an expired code, and a spent code are all reported as
 * `not_found`. The caller of this path is unauthenticated by construction — it
 * holds no core token — so telling it which of the three happened would help it
 * search for a code that exists.
 */
export function pairNode(
  kernel: Kernel,
  context: CommandContext,
  request: PairNodeRequest,
  coreToken: string,
): Result<PairedNode> {
  const codeHash = hashPairingCode(request.code);
  const now = kernel.clock.now();
  const nowIso = new Date(now).toISOString();
  const newNodeId = kernel.ids.nextId();

  return runCommand<PairedNode>(
    kernel,
    // Keyed by the code, so a retry after a lost response replays rather than
    // consuming a second code or creating a second node.
    { scope: "node.pair", key: codeHash, resultId: newNodeId },
    (tx) => {
      const code = tx
        .prepare(
          `SELECT id, host_id, expires_at, consumed_at
             FROM node_pairing_codes WHERE code_hash = ?`,
        )
        .get(codeHash) as
        { id: string; host_id: string; expires_at: string; consumed_at: string | null } | undefined;

      if (
        code === undefined ||
        code.consumed_at !== null ||
        Date.parse(code.expires_at) <= now ||
        code.host_id !== request.hostId
      ) {
        return conflict({ kind: "not_found", entity: "pairing_code", id: "redacted" });
      }

      // The unique key is (host_id, fingerprint): re-pairing the same agent on
      // the same machine renews it rather than accumulating rows. A revoked node
      // is renewed too — possession of a fresh operator-issued code is the
      // re-authorisation, and the status change stays in the audit log.
      const existing = tx
        .prepare(
          "SELECT id, credential_generation AS g, status FROM nodes WHERE host_id = ? AND fingerprint = ?",
        )
        .get(request.hostId, request.fingerprint) as
        { id: string; g: number; status: string } | undefined;

      const nodeId = existing?.id ?? newNodeId;
      const generation = existing === undefined ? 0 : existing.g + 1;

      if (existing === undefined) {
        tx.prepare(
          `INSERT INTO nodes (id, host_id, status, fingerprint, agent_version,
                              credential_generation, created_at, updated_at)
           VALUES (?, ?, 'paired', ?, ?, 0, ?, ?)`,
        ).run(nodeId, request.hostId, request.fingerprint, request.agentVersion, nowIso, nowIso);
      } else {
        tx.prepare(
          `UPDATE nodes
              SET status = 'paired', agent_version = ?, credential_generation = ?,
                  revoked_at = NULL, updated_at = ?
            WHERE id = ?`,
        ).run(request.agentVersion, generation, nowIso, nodeId);
      }

      tx.prepare("UPDATE node_pairing_codes SET consumed_at = ?, node_id = ? WHERE id = ?").run(
        nowIso,
        nodeId,
        code.id,
      );

      return ok({
        value: {
          nodeId,
          generation,
          credential: deriveCredential(coreToken, nodeId, generation),
          hostId: request.hostId,
        },
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "node",
            streamId: nodeId,
            type: "node.paired.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              hostId: request.hostId,
              agentVersion: request.agentVersion,
              generation,
              renewed: existing !== undefined,
              previousStatus: existing?.status ?? null,
            },
            correlationId: context.correlationId,
            occurredAt: nowIso,
          },
        ],
      });
    },
  );
}

/**
 * Re-derives the credential for a node that already exists. Used to answer a
 * replayed pair request: the core kept no copy, but it can always recompute one.
 *
 * Refuses unless the request describes the same node, so a spent code cannot be
 * turned into a credential for a different machine.
 */
export function currentCredential(
  db: NoctisDatabase,
  nodeId: string,
  coreToken: string,
  request: PairNodeRequest,
): PairedNode | undefined {
  const node = getNode(db, nodeId);
  const generation = getCredentialGeneration(db, nodeId);

  // A replay is only a replay if it is the same agent asking again. A second
  // machine presenting a spent code is not retrying, it is reusing.
  return node === undefined ||
    generation === undefined ||
    node.hostId !== request.hostId ||
    node.fingerprint !== request.fingerprint
    ? undefined
    : {
        nodeId,
        generation,
        credential: deriveCredential(coreToken, nodeId, generation),
        hostId: node.hostId,
      };
}

/**
 * Marks a node online and rotates its credential.
 *
 * Rotating on every connection means a leaked credential is useful only until
 * the node next reconnects, and it needs no scheduler to happen — rotation that
 * waits for someone to remember to run it is rotation that never happens.
 */
export function connectNode(
  kernel: Kernel,
  context: CommandContext,
  input: {
    nodeId: string;
    connectionId: string;
    agentVersion: string;
    providers: readonly RuntimeProbe[];
  },
  coreToken: string,
): Result<PairedNode> {
  const nowIso = new Date(kernel.clock.now()).toISOString();

  return runCommand<PairedNode>(
    kernel,
    {
      scope: "node.connect",
      key: `${input.nodeId}:${input.connectionId}`,
      resultId: input.nodeId,
    },
    (tx) => {
      const node = getNode(tx, input.nodeId);
      const generation = getCredentialGeneration(tx, input.nodeId);

      if (node === undefined || generation === undefined) {
        return conflict({ kind: "not_found", entity: "node", id: input.nodeId });
      }

      const rotated = generation + 1;

      tx.prepare(
        `UPDATE nodes
            SET status = 'online', agent_version = ?, credential_generation = ?,
                providers_json = ?, last_seen_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.agentVersion,
        rotated,
        JSON.stringify(input.providers),
        nowIso,
        nowIso,
        input.nodeId,
      );

      return ok({
        value: {
          nodeId: input.nodeId,
          generation: rotated,
          credential: deriveCredential(coreToken, input.nodeId, rotated),
          hostId: node.hostId,
        },
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "node",
            streamId: input.nodeId,
            type: "node.connected.v1",
            actorType: "node",
            actorId: input.nodeId,
            payloadVersion: 1,
            payload: {
              hostId: node.hostId,
              agentVersion: input.agentVersion,
              from: node.status,
              // Mode and availability only. The model list is on the row; an
              // event that repeated it would grow with every model a vendor ships.
              providers: input.providers.map((probe) => ({
                providerId: probe.providerId,
                available: probe.available,
                authMode: probe.authMode,
              })),
            },
            correlationId: context.correlationId,
            occurredAt: nowIso,
          },
        ],
      });
    },
  );
}

/**
 * `lastSeenAt` is written on connect and disconnect only. A pong every thirty
 * seconds would be a write per node per interval for a fact the open socket
 * already answers; what the column records is the last moment the core knew the
 * connection was good, which is exactly these two.
 */
export function disconnectNode(
  kernel: Kernel,
  context: CommandContext,
  input: { nodeId: string; connectionId: string },
): Result<NodeDescriptor> {
  const nowIso = new Date(kernel.clock.now()).toISOString();

  return runCommand<NodeDescriptor>(
    kernel,
    {
      scope: "node.disconnect",
      key: `${input.nodeId}:${input.connectionId}`,
      resultId: input.nodeId,
    },
    (tx) => {
      const node = getNode(tx, input.nodeId);

      if (node === undefined) {
        return conflict({ kind: "not_found", entity: "node", id: input.nodeId });
      }

      // A revoked node that drops stays revoked: offline would read as a node
      // that could come back.
      const status = node.status === "revoked" ? "revoked" : "offline";

      tx.prepare("UPDATE nodes SET status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?").run(
        status,
        nowIso,
        nowIso,
        input.nodeId,
      );

      const updated = getNode(tx, input.nodeId);

      if (updated === undefined) {
        throw new Error(`Node ${input.nodeId} vanished mid-transaction`);
      }

      return ok({
        value: updated,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "node",
            streamId: input.nodeId,
            type: "node.status_changed.v1",
            actorType: "system",
            actorId: "core",
            payloadVersion: 1,
            payload: { from: node.status, to: status, reason: "disconnected" },
            correlationId: context.correlationId,
            occurredAt: nowIso,
          },
        ],
      });
    },
  );
}

export function revokeNode(
  kernel: Kernel,
  context: CommandContext,
  command: RevokeNodeCommand,
): Result<NodeDescriptor> {
  const nowIso = new Date(kernel.clock.now()).toISOString();

  return runCommand<NodeDescriptor>(
    kernel,
    { scope: "node.revoke", key: command.idempotencyKey, resultId: command.nodeId },
    (tx) => {
      const node = getNode(tx, command.nodeId);

      if (node === undefined) {
        return conflict({ kind: "not_found", entity: "node", id: command.nodeId });
      }

      tx.prepare(
        `UPDATE nodes SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?`,
      ).run(nowIso, nowIso, command.nodeId);

      // Revoking the node revokes what it was allowed to do. Leaving the grants
      // live would mean a re-paired node silently regained them.
      tx.prepare(
        "UPDATE node_capabilities SET revoked_at = ? WHERE node_id = ? AND revoked_at IS NULL",
      ).run(nowIso, command.nodeId);

      const updated = getNode(tx, command.nodeId);

      if (updated === undefined) {
        throw new Error(`Node ${command.nodeId} vanished mid-transaction`);
      }

      return ok({
        value: updated,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "node",
            streamId: command.nodeId,
            type: "node.status_changed.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: { from: node.status, to: "revoked", reason: "operator_revoked" },
            correlationId: context.correlationId,
            occurredAt: nowIso,
          },
        ],
      });
    },
  );
}

export function getGrant(db: NoctisDatabase, id: string): CapabilityGrant | undefined {
  const row = db.prepare(`SELECT ${GRANT_COLUMNS} FROM node_capabilities WHERE id = ?`).get(id) as
    GrantRow | undefined;

  return row === undefined ? undefined : toGrant(row);
}

export function grantCapability(
  kernel: Kernel,
  context: CommandContext,
  command: GrantNodeCapabilityCommand,
): Result<CapabilityGrant> {
  const id = kernel.ids.nextId();
  const nowIso = new Date(kernel.clock.now()).toISOString();
  // Derived, never accepted from the caller: see CAPABILITY_OPERATION_CLASS.
  const operationClass = CAPABILITY_OPERATION_CLASS[command.capability];
  const constraints =
    command.capability === "file.search"
      ? FileSearchConstraintsSchema.parse(command.constraints)
      : command.capability === "runtime.turn"
        ? RuntimeGrantConstraintsSchema.parse(command.constraints)
        : (command.constraints ?? {});

  return runCommand<CapabilityGrant>(
    kernel,
    { scope: "node.grant_capability", key: command.idempotencyKey, resultId: id },
    (tx) => {
      const node = getNode(tx, command.nodeId);

      if (node === undefined) {
        return conflict({ kind: "not_found", entity: "node", id: command.nodeId });
      }

      if (node.status === "revoked") {
        // Not a transition failure of the grant, but of the node it names.
        return conflict({ kind: "not_found", entity: "node", id: command.nodeId });
      }

      tx.prepare(
        `INSERT INTO node_capabilities
           (id, node_id, capability, operation_class, constraints_version, constraints_json,
            granted_at, expires_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        id,
        command.nodeId,
        command.capability,
        operationClass,
        JSON.stringify(constraints),
        nowIso,
        command.expiresAt ?? null,
      );

      const grant = getGrant(tx, id);

      if (grant === undefined) {
        throw new Error(`Grant ${id} vanished mid-transaction`);
      }

      return ok({
        value: grant,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "node",
            streamId: command.nodeId,
            type: "node.capability_granted.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              grantId: id,
              capability: command.capability,
              operationClass,
              ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
            },
            correlationId: context.correlationId,
            occurredAt: nowIso,
          },
        ],
      });
    },
  );
}

/**
 * A folder stops being shared. Grants are never edited in place, so a grant
 * that also named other folders is revoked and granted again without this one:
 * the ledger keeps what was allowed when, and the rest stay shared.
 */
export function unshareFolder(
  kernel: Kernel,
  context: CommandContext,
  command: UnshareNodeFolderCommand,
): Result<NodeDescriptor> {
  const nowIso = new Date(kernel.clock.now()).toISOString();

  return runCommand<NodeDescriptor>(
    kernel,
    { scope: "node.unshare_folder", key: command.idempotencyKey, resultId: command.nodeId },
    (tx) => {
      const node = getNode(tx, command.nodeId);
      const naming = listGrants(tx, command.nodeId).flatMap((grant) => {
        if (
          grant.capability !== "runtime.turn" ||
          grant.revokedAt !== undefined ||
          (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= kernel.clock.now())
        ) {
          return [];
        }

        const constraints = RuntimeGrantConstraintsSchema.parse(grant.constraints);

        return constraints.roots.some((root) => root.grantId === command.rootGrantId)
          ? [{ grant, constraints }]
          : [];
      });

      if (node === undefined || naming.length === 0) {
        return conflict({ kind: "not_found", entity: "folder", id: command.rootGrantId });
      }

      const events: EventDraft[] = [];
      const draft = (type: EventDraft["type"], payload: unknown): EventDraft => ({
        id: kernel.ids.nextId(),
        streamType: "node",
        streamId: command.nodeId,
        type,
        actorType: context.actorType,
        actorId: context.actorId,
        payloadVersion: 1,
        payload,
        correlationId: context.correlationId,
        occurredAt: nowIso,
      });

      for (const { grant, constraints } of naming) {
        tx.prepare("UPDATE node_capabilities SET revoked_at = ? WHERE id = ?").run(
          nowIso,
          grant.id,
        );
        events.push(
          draft("node.capability_revoked.v1", {
            grantId: grant.id,
            capability: grant.capability,
            rootGrantId: command.rootGrantId,
          }),
        );

        const roots = constraints.roots.filter((root) => root.grantId !== command.rootGrantId);

        if (roots.length > 0) {
          const id = kernel.ids.nextId();

          tx.prepare(
            `INSERT INTO node_capabilities
               (id, node_id, capability, operation_class, constraints_version, constraints_json,
                granted_at, expires_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
          ).run(
            id,
            command.nodeId,
            grant.capability,
            grant.operationClass,
            JSON.stringify({ ...constraints, roots }),
            nowIso,
            grant.expiresAt ?? null,
          );
          events.push(
            draft("node.capability_granted.v1", {
              grantId: id,
              capability: grant.capability,
              operationClass: grant.operationClass,
              ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
            }),
          );
        }
      }

      return ok({ value: node, events });
    },
  );
}
