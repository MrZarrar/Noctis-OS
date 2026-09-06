import type {
  ActivateIdentityCommand,
  ConversationalIdentityId,
  ConversationThread,
} from "@noctis/contracts";
import { ConversationThreadSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { ok } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";

const ACTIVE_IDENTITY_KEY = "active_identity";

type ThreadRow = {
  id: string;
  identity_id: string;
  active_objective_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

function toThread(row: ThreadRow): ConversationThread {
  return ConversationThreadSchema.parse({
    id: row.id,
    identityId: row.identity_id,
    ...(row.active_objective_id === null ? {} : { activeObjectiveId: row.active_objective_id }),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * At most one thread per identity: activating an identity reuses its thread
 * rather than branching a new one, which is what makes "JESTER never mutates
 * a Vesper thread" a structural fact — a lookup keyed by `identityId` can
 * never return the other identity's row.
 */
export function getThreadForIdentity(
  db: NoctisDatabase,
  identityId: string,
): ConversationThread | undefined {
  const row = db
    .prepare(
      `SELECT id, identity_id, active_objective_id, revision, created_at, updated_at
         FROM identity_threads WHERE identity_id = ? ORDER BY created_at ASC LIMIT 1`,
    )
    .get(identityId) as ThreadRow | undefined;

  return row === undefined ? undefined : toThread(row);
}

export function getActiveIdentity(db: NoctisDatabase): ConversationalIdentityId | undefined {
  const row = db
    .prepare(`SELECT value_json FROM runtime_kv WHERE key = ?`)
    .get(ACTIVE_IDENTITY_KEY) as { value_json: string } | undefined;

  return row === undefined ? undefined : (JSON.parse(row.value_json) as ConversationalIdentityId);
}

export interface IdentityActivation {
  activeIdentityId: ConversationalIdentityId;
  thread: ConversationThread;
}

export function replayActivation(
  db: NoctisDatabase,
  identityId: string,
): IdentityActivation | undefined {
  const thread = getThreadForIdentity(db, identityId);

  return thread === undefined
    ? undefined
    : { activeIdentityId: identityId as ConversationalIdentityId, thread };
}

export function activateIdentity(
  kernel: Kernel,
  context: CommandContext,
  command: ActivateIdentityCommand,
): Result<IdentityActivation> {
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<IdentityActivation>(
    kernel,
    { scope: "identity.activate", key: command.idempotencyKey, resultId: command.identityId },
    (tx) => {
      const existing = getThreadForIdentity(tx, command.identityId);

      const thread =
        existing ??
        ConversationThreadSchema.parse({
          id: kernel.ids.nextId(),
          identityId: command.identityId,
          revision: 0,
          createdAt: now,
          updatedAt: now,
        });

      if (existing === undefined) {
        tx.prepare(
          `INSERT INTO identity_threads (id, identity_id, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(thread.id, thread.identityId, thread.revision, thread.createdAt, thread.updatedAt);
      }

      tx.prepare(
        `INSERT INTO runtime_kv (key, value_version, value_json, updated_at)
           VALUES (?, 1, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           value_version = value_version + 1,
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      ).run(ACTIVE_IDENTITY_KEY, JSON.stringify(command.identityId), now);

      return ok({
        value: { activeIdentityId: command.identityId, thread },
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "identity",
            streamId: thread.id,
            type: "identity.activated.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: { identityId: command.identityId, threadId: thread.id },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}
