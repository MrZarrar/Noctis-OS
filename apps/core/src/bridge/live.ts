import type { BridgeEvent, LiveEntry, LiveSession } from "@noctis/contracts";
import { LiveEntrySchema, LiveSessionSchema } from "@noctis/contracts";
import { ok } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import { commitStateAndEvent } from "../db/transactions.js";
import type { Kernel } from "../kernel.js";

/** How many sessions the list shows. ponytail: no paging until someone has more. */
const MAX_LIVE_SESSIONS = 100;

type SessionRow = {
  id: string;
  node_id: string;
  host_id: string;
  provider_id: string;
  session_ref: string;
  cwd: string;
  title: string | null;
  status: string;
  started_at: string;
  updated_at: string;
};

const SESSION_SELECT = `SELECT s.id, s.node_id, n.host_id, s.provider_id, s.session_ref, s.cwd,
                               s.title, s.status, s.started_at, s.updated_at
                          FROM live_sessions s JOIN nodes n ON n.id = s.node_id`;

function toSession(row: SessionRow): LiveSession {
  return LiveSessionSchema.parse({
    id: row.id,
    nodeId: row.node_id,
    hostId: row.host_id,
    providerId: row.provider_id,
    sessionRef: row.session_ref,
    cwd: row.cwd,
    ...(row.title === null ? {} : { title: row.title }),
    status: row.status,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  });
}

/**
 * One hook's report from a PC. Not a command: a hook fires once and is never
 * retried, so there is no idempotency key to claim. Whatever arrives first
 * opens the session, since a hook can be installed after a session started.
 */
export function recordBridgeEvent(kernel: Kernel, nodeId: string, event: BridgeEvent): void {
  const now = new Date(kernel.clock.now()).toISOString();
  const outcome = commitStateAndEvent(kernel.db, (tx) => {
    const existing = tx
      .prepare(
        `SELECT id, title FROM live_sessions
          WHERE node_id = ? AND provider_id = ? AND session_ref = ?`,
      )
      .get(nodeId, event.providerId, event.sessionRef) as
      { id: string; title: string | null } | undefined;
    const id = existing?.id ?? kernel.ids.nextId();
    const status = event.kind === "end" ? "ended" : "live";
    const prompt = event.kind === "prompt" ? event.text?.trim() : undefined;

    if (existing === undefined) {
      tx.prepare(
        `INSERT INTO live_sessions
           (id, node_id, provider_id, session_ref, cwd, title, status, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        nodeId,
        event.providerId,
        event.sessionRef,
        event.cwd,
        prompt?.slice(0, 200) || null,
        status,
        now,
        now,
      );
    } else {
      tx.prepare(
        `UPDATE live_sessions
            SET status = ?, cwd = ?, title = COALESCE(title, ?), updated_at = ?
          WHERE id = ?`,
      ).run(status, event.cwd, prompt?.slice(0, 200) || null, now, id);
    }

    if ((event.kind === "prompt" || event.kind === "reply") && event.text?.trim()) {
      tx.prepare(
        `INSERT INTO live_session_entries (id, live_session_id, role, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(kernel.ids.nextId(), id, event.kind === "prompt" ? "user" : "agent", event.text, now);
    }

    return ok({
      value: id,
      events: [
        {
          id: kernel.ids.nextId(),
          streamType: "node",
          streamId: nodeId,
          type: "bridge.session_updated.v1",
          actorType: "node",
          actorId: nodeId,
          payloadVersion: 1,
          payload: { liveSessionId: id, kind: event.kind },
          correlationId: kernel.ids.nextId(),
          occurredAt: now,
        },
      ],
    });
  });

  if (outcome.ok) {
    kernel.broker.publish(outcome.value.committedEvents);
  }
}

/** Newest activity first. */
export function listLiveSessions(db: NoctisDatabase): LiveSession[] {
  const rows = db
    .prepare(`${SESSION_SELECT} ORDER BY s.updated_at DESC, s.id DESC LIMIT ?`)
    .all(MAX_LIVE_SESSIONS) as SessionRow[];

  return rows.map(toSession);
}

/** Undefined for a session that does not exist. Oldest first. */
export function listLiveEntries(db: NoctisDatabase, id: string): LiveEntry[] | undefined {
  if (db.prepare("SELECT 1 FROM live_sessions WHERE id = ?").get(id) === undefined) {
    return undefined;
  }

  const rows = db
    .prepare(
      `SELECT id, role, body, created_at FROM live_session_entries
        WHERE live_session_id = ? ORDER BY created_at, id`,
    )
    .all(id) as Array<{ id: string; role: string; body: string; created_at: string }>;

  return rows.map((row) =>
    LiveEntrySchema.parse({
      id: row.id,
      role: row.role,
      body: row.body,
      createdAt: row.created_at,
    }),
  );
}
