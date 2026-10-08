import type {
  ConversationalIdentityId,
  ConversationSummary,
  ConversationThread,
  RuntimeProviderId,
} from "@noctis/contracts";
import { ConversationSummarySchema, ConversationThreadSchema } from "@noctis/contracts";

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

/** How many conversations the list shows. ponytail: no paging until someone has more. */
const MAX_CONVERSATIONS = 100;

/**
 * An identity's conversations for the thread list: its free thread and every
 * named one, newest activity first. Objective and delegated threads are
 * reached from where they belong, not listed here.
 */
export function listConversations(db: NoctisDatabase, identityId: string): ConversationSummary[] {
  const rows = db
    .prepare(
      `SELECT ${THREAD_COLUMNS},
              (SELECT MAX(m.created_at) FROM identity_messages m WHERE m.thread_id = t.id) AS last_at,
              (SELECT c.body FROM identity_messages m
                 JOIN identity_message_content c ON c.message_id = m.id
                WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body
         FROM identity_threads t
        WHERE identity_id = ? AND objective_id IS NULL AND parent_thread_id IS NULL
        ORDER BY COALESCE(last_at, created_at) DESC, id DESC
        LIMIT ?`,
    )
    .all(identityId, MAX_CONVERSATIONS) as Array<
    ThreadRow & { last_at: string | null; last_body: string | null }
  >;

  return rows.map((row) =>
    ConversationSummarySchema.parse({
      ...toThread(row),
      lastActiveAt: row.last_at ?? row.created_at,
      ...(row.last_body === null ? {} : { preview: row.last_body.slice(0, 200) }),
    }),
  );
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
 * A thread the owner opened: a new conversation, or a session continued from
 * elsewhere. Any number per identity, beside its one free thread. A pinned
 * one runs on that node, in that folder, with that agent, every time.
 */
export function createNamedThread(
  tx: NoctisDatabase,
  kernel: Kernel,
  thread: {
    identityId: ConversationalIdentityId;
    title?: string;
    nodeId?: string;
    rootGrantId?: string;
    providerId?: RuntimeProviderId;
    adoptedSessionRef?: string;
  },
  now: string,
): ConversationThread {
  const id = kernel.ids.nextId();

  tx.prepare(
    `INSERT INTO identity_threads
       (id, identity_id, kind, title, node_id, root_grant_id, provider_id, adopted_session_ref,
        revision, created_at, updated_at)
     VALUES (?, ?, 'named', ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    thread.identityId,
    thread.title ?? null,
    thread.nodeId ?? null,
    thread.rootGrantId ?? null,
    thread.providerId ?? null,
    thread.adoptedSessionRef ?? null,
    now,
    now,
  );

  const created = getThread(tx, id);

  if (created === undefined) {
    throw new Error(`Thread ${id} vanished mid-transaction`);
  }

  return created;
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
