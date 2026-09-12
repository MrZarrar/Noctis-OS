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

export type ThreadRow = {
  id: string;
  identity_id: string;
  objective_id: string | null;
  active_objective_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export const THREAD_COLUMNS = `id, identity_id, objective_id, active_objective_id, revision,
                               created_at, updated_at`;

export function toThread(row: ThreadRow): ConversationThread {
  return ConversationThreadSchema.parse({
    id: row.id,
    identityId: row.identity_id,
    ...(row.objective_id === null ? {} : { objectiveId: row.objective_id }),
    ...(row.active_objective_id === null ? {} : { activeObjectiveId: row.active_objective_id }),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * The identity's free-chat thread. Since 0006 an identity also has one thread
 * per Objective (`conversation/threads.ts`); this is the one with no Objective,
 * and the partial unique index makes it at most one. A lookup keyed by
 * `identityId` still never returns the other identity's row, which is what
 * makes "JESTER never mutates a Vesper thread" a structural fact.
 */
export function getThreadForIdentity(
  db: NoctisDatabase,
  identityId: string,
): ConversationThread | undefined {
  const row = db
    .prepare(
      `SELECT ${THREAD_COLUMNS} FROM identity_threads
        WHERE identity_id = ? AND objective_id IS NULL`,
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

/**
 * Returns the identity's free-chat thread, creating it if this is the first
 * time anything needed one.
 *
 * Every caller that can be the first — activating the identity, activating an
 * Objective that belongs to it, a free-chat prompt — routes through here. A
 * second creation path would be a second chance to create a second free thread
 * for one identity, and the "one free-chat thread per identity" fact above is
 * what makes identity isolation structural. Objective threads are created by
 * `conversation/threads.ts`, under their own unique index.
 */
export function ensureThread(
  tx: NoctisDatabase,
  kernel: Kernel,
  identityId: ConversationalIdentityId,
  now: string,
): ConversationThread {
  const existing = getThreadForIdentity(tx, identityId);

  if (existing !== undefined) {
    return existing;
  }

  const thread = ConversationThreadSchema.parse({
    id: kernel.ids.nextId(),
    identityId,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });

  tx.prepare(
    `INSERT INTO identity_threads (id, identity_id, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(thread.id, thread.identityId, thread.revision, thread.createdAt, thread.updatedAt);

  return thread;
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
      const thread = ensureThread(tx, kernel, command.identityId, now);

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
