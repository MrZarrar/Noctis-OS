import type {
  AllowLightsCommand,
  LightsEvidence,
  LightsSetCommand,
  LightsStatus,
  OrchestrationEvent,
} from "@noctis/contracts";
import { LIGHTS_CAPABILITIES, LightsEvidenceSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { ok } from "@noctis/domain";

import { grantStandingPermission, revokeStandingPermission } from "../authority/service.js";
import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import type { Dispatcher } from "../nodes/dispatch.js";
import type { NodeJobRecord } from "../nodes/jobs.js";
import { enqueueJobInTransaction } from "../nodes/jobs.js";
import { grantCapability } from "../nodes/registry.js";

/**
 * The owner's lights, asked of the one PC allowed to drive them. Like the file
 * gateway, a question is a job whose evidence is the answer, so the page waits
 * on the node and never on a stored copy that could be stale.
 */

/** A Tuya round trip plus a Tapo handshake; more than this and the PC is not answering. */
export const LIGHTS_ANSWER_MS = 20_000;

export class LightsUnavailable extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface LightsGateway {
  status(context: CommandContext): Promise<LightsStatus>;
  set(context: CommandContext, command: LightsSetCommand): Promise<LightsEvidence>;
  allow(context: CommandContext, command: AllowLightsCommand): Result<{ id: string }>;
  disallow(context: CommandContext, command: AllowLightsCommand): Result<{ id: string }>;
  close(): void;
}

const lightsNode = (db: NoctisDatabase, now: number): string | undefined =>
  (
    db
      .prepare(
        `SELECT node_id FROM node_capabilities c JOIN nodes n ON n.id = node_id
          WHERE n.status != 'revoked' AND capability = 'lights.set' AND c.revoked_at IS NULL
            AND (c.expires_at IS NULL OR c.expires_at > ?) ORDER BY granted_at DESC LIMIT 1`,
      )
      .get(new Date(now).toISOString()) as { node_id: string } | undefined
  )?.node_id;

export function createLightsGateway(deps: {
  kernel: Kernel;
  dispatcher: Pick<Dispatcher, "isConnected" | "pass">;
}): LightsGateway {
  const { kernel, dispatcher } = deps;
  const iso = (): string => new Date(kernel.clock.now()).toISOString();
  const waiting = new Map<
    string,
    { resolve(value: LightsEvidence): void; reject(reason: LightsUnavailable): void }
  >();

  const unsubscribe = kernel.broker.subscribe((events: readonly OrchestrationEvent[]) => {
    for (const event of events) {
      if (event.type !== "node.job_result.v1") continue;
      const entry = waiting.get(event.streamId);
      if (entry === undefined) continue;
      waiting.delete(event.streamId);
      const payload = event.payload as {
        outcome?: string;
        evidence?: unknown;
        failureReason?: string;
      };
      if (payload.outcome === "failed") {
        entry.reject(new LightsUnavailable(502, payload.failureReason ?? "the PC refused"));
        continue;
      }
      const evidence = LightsEvidenceSchema.safeParse(payload.evidence);
      if (evidence.success) entry.resolve(evidence.data);
      else entry.reject(new LightsUnavailable(502, "the PC answered in an unknown shape"));
    }
  });

  function ask(
    context: CommandContext,
    capability: "lights.state" | "lights.set",
    payload: Record<string, unknown>,
  ): Promise<LightsEvidence> {
    const nodeId = lightsNode(kernel.db, kernel.clock.now());
    if (nodeId === undefined)
      return Promise.reject(new LightsUnavailable(409, "lights are not set up on any PC"));
    if (!dispatcher.isConnected(nodeId))
      return Promise.reject(new LightsUnavailable(503, "the lights PC is offline"));
    const id = kernel.ids.nextId();
    const queued = runCommand<NodeJobRecord>(
      kernel,
      { scope: "node.job_enqueue", key: `lights:${id}`, resultId: id },
      (tx) =>
        enqueueJobInTransaction(tx, kernel, context, {
          id,
          capability,
          payload,
          idempotencyKey: `lights:${id}`,
          pinnedNodeId: nodeId,
        }),
    );
    if (!queued.ok)
      return Promise.reject(
        new LightsUnavailable(503, `could not ask the PC (${queued.conflict.kind})`),
      );
    return new Promise<LightsEvidence>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (waiting.delete(id)) reject(new LightsUnavailable(504, "the lights PC did not answer"));
      }, LIGHTS_ANSWER_MS);
      timer.unref();
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      // Post-commit: the frame must never describe a row a rollback erased.
      dispatcher.pass();
    });
  }

  return {
    async status(context) {
      const nodeId = lightsNode(kernel.db, kernel.clock.now());
      if (nodeId === undefined) return { granted: false, nodeId: null, nodeOnline: false };
      if (!dispatcher.isConnected(nodeId)) return { granted: true, nodeId, nodeOnline: false };
      try {
        return {
          granted: true,
          nodeId,
          nodeOnline: true,
          lights: await ask(context, "lights.state", {}),
        };
      } catch (error) {
        return {
          granted: true,
          nodeId,
          nodeOnline: true,
          error: (error instanceof Error ? error.message : "unknown").slice(0, 300),
        };
      }
    },

    set(context, command) {
      return ask(
        context,
        "lights.set",
        "scene" in command ? { scene: command.scene } : { changes: command.changes },
      );
    },

    allow(context, command) {
      // Each step replays under its own derived key, so a retry after a partial failure finishes the set.
      for (const capability of LIGHTS_CAPABILITIES) {
        const granted = grantCapability(kernel, context, {
          idempotencyKey: `${command.idempotencyKey}:${capability}`,
          nodeId: command.nodeId,
          capability,
          constraints: {},
        });
        if (!granted.ok && granted.conflict.kind !== "idempotent_replay") return granted;
      }
      const active = kernel.db
        .prepare(
          "SELECT id FROM standing_permissions WHERE actor_id = 'local' AND capability = 'lights.set' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
        )
        .get(iso());
      if (active === undefined) {
        const granted = grantStandingPermission(kernel, context, {
          idempotencyKey: `${command.idempotencyKey}:local:lights.set`,
          actorId: "local",
          capability: "lights.set",
          operationClass: "local_reversible_edit",
          constraints: { targetType: "capability", targetIds: ["lights.set"] },
        });
        if (!granted.ok && granted.conflict.kind !== "idempotent_replay") return granted;
      }
      return ok({ id: command.nodeId });
    },

    disallow(context, command) {
      const permissions = kernel.db
        .prepare(
          "SELECT id FROM standing_permissions WHERE capability LIKE 'lights.%' AND revoked_at IS NULL",
        )
        .all() as { id: string }[];
      for (const { id } of permissions) {
        const revoked = revokeStandingPermission(kernel, context, {
          idempotencyKey: `${command.idempotencyKey}:${id}`,
          permissionId: id,
          reason: "lights disallowed",
        });
        if (!revoked.ok && revoked.conflict.kind !== "idempotent_replay") return revoked;
      }
      return runCommand(
        kernel,
        { scope: "lights.disallow", key: command.idempotencyKey, resultId: command.nodeId },
        (tx) => {
          tx.prepare(
            "UPDATE node_capabilities SET revoked_at = ? WHERE node_id = ? AND capability LIKE 'lights.%' AND revoked_at IS NULL",
          ).run(iso(), command.nodeId);
          return ok({ value: { id: command.nodeId }, events: [] });
        },
      );
    },

    close() {
      unsubscribe();
      for (const [id, entry] of waiting) {
        waiting.delete(id);
        entry.reject(new LightsUnavailable(503, "the core is shutting down"));
      }
    },
  };
}
