import type { ConversationalIdentityId, ConversationThread } from "@noctis/contracts";
import { ConversationThreadSchema } from "@noctis/contracts";

import type { NoctisDatabase } from "../db/connection.js";
import type { ThreadRow } from "../identities/service.js";
import {
  ensureThread,
  getThreadForIdentity,
  THREAD_COLUMNS,
  toThread,
} from "../identities/service.js";
import type { Kernel } from "../kernel.js";

/**
 * 0.12: one runtime thread per Objective plus one free-chat thread per identity.
 * `objectiveId` undefined names the free thread; defined names the Objective's.
 * Reads only — creating is `threadFor`'s job, inside a command.
 */
export function findThread(
  db: NoctisDatabase,
  identityId: ConversationalIdentityId,
  objectiveId: string | undefined,
): ConversationThread | undefined {
  if (objectiveId === undefined) {
    return getThreadForIdentity(db, identityId);
  }

  const row = db
    .prepare(
      `SELECT ${THREAD_COLUMNS} FROM identity_threads
        WHERE identity_id = ? AND objective_id = ? AND parent_thread_id IS NULL`,
    )
    .get(identityId, objectiveId) as ThreadRow | undefined;

  return row === undefined ? undefined : toThread(row);
}

export function getThread(db: NoctisDatabase, id: string): ConversationThread | undefined {
  const row = db.prepare(`SELECT ${THREAD_COLUMNS} FROM identity_threads WHERE id = ?`).get(id) as
    ThreadRow | undefined;

  return row === undefined ? undefined : toThread(row);
}

export function listThreads(db: NoctisDatabase, identityId: string): ConversationThread[] {
  const rows = db
    .prepare(
      `SELECT ${THREAD_COLUMNS} FROM identity_threads WHERE identity_id = ? ORDER BY created_at, id`,
    )
    .all(identityId) as ThreadRow[];

  return rows.map(toThread);
}

/** The threads agents on `parentThreadId` delegated to, oldest first. */
export function listChildThreads(db: NoctisDatabase, parentThreadId: string): ConversationThread[] {
  const rows = db
    .prepare(
      `SELECT ${THREAD_COLUMNS} FROM identity_threads
        WHERE parent_thread_id = ? ORDER BY created_at, id`,
    )
    .all(parentThreadId) as ThreadRow[];

  return rows.map(toThread);
}

/**
 * A new thread for one delegation. It keeps the parent's identity and
 * Objective, so the child's asks are judged by the same scope as the parent's.
 */
export function createChildThread(
  tx: NoctisDatabase,
  kernel: Kernel,
  parent: ConversationThread,
  parentTurnId: string,
  now: string,
): ConversationThread {
  const id = kernel.ids.nextId();

  tx.prepare(
    `INSERT INTO identity_threads
       (id, identity_id, objective_id, parent_thread_id, parent_turn_id, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, parent.identityId, parent.objectiveId ?? null, parent.id, parentTurnId, now, now);

  const thread = getThread(tx, id);

  if (thread === undefined) {
    throw new Error(`Thread ${id} vanished mid-transaction`);
  }

  return thread;
}

/**
 * The thread a prompt belongs to, created on first use. The free thread reuses
 * `ensureThread` so there is still exactly one place that creates it; an
 * Objective thread is created once here, under `idx_identity_threads_objective`.
 */
export function threadFor(
  tx: NoctisDatabase,
  kernel: Kernel,
  identityId: ConversationalIdentityId,
  objectiveId: string | undefined,
  now: string,
): ConversationThread {
  if (objectiveId === undefined) {
    return ensureThread(tx, kernel, identityId, now);
  }

  const existing = findThread(tx, identityId, objectiveId);

  if (existing !== undefined) {
    return existing;
  }

  const thread = ConversationThreadSchema.parse({
    id: kernel.ids.nextId(),
    identityId,
    objectiveId,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });

  tx.prepare(
    `INSERT INTO identity_threads (id, identity_id, objective_id, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(thread.id, identityId, objectiveId, thread.revision, now, now);

  return thread;
}
