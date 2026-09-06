import type {
  ChangeObjectiveStatusCommand,
  CreateObjectiveCommand,
  EventName,
  ObjectiveRecord,
  ObjectiveStatus,
} from "@noctis/contracts";
import { ObjectiveRecordSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { checkRevision, conflict, ok, transitionObjectiveStatus } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import { ensureThread } from "../identities/service.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";

type ObjectiveRow = {
  id: string;
  title: string;
  intent: string;
  status: string;
  identity_id: string;
  protocol_ids_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  completed_at: string | null;
};

const SELECT_COLUMNS = `id, title, intent, status, identity_id, protocol_ids_json, revision,
                        created_at, updated_at, activated_at, completed_at`;

function toRecord(row: ObjectiveRow): ObjectiveRecord {
  return ObjectiveRecordSchema.parse({
    id: row.id,
    title: row.title,
    intent: row.intent,
    status: row.status,
    identityId: row.identity_id,
    protocolIds: JSON.parse(row.protocol_ids_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    revision: row.revision,
  });
}

export function getObjective(db: NoctisDatabase, id: string): ObjectiveRecord | undefined {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM objectives WHERE id = ?`).get(id) as
    ObjectiveRow | undefined;

  return row === undefined ? undefined : toRecord(row);
}

export function listObjectives(db: NoctisDatabase, limit: number): ObjectiveRecord[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM objectives ORDER BY id DESC LIMIT ?`)
    .all(limit) as ObjectiveRow[];

  return rows.map(toRecord);
}

export function createObjective(
  kernel: Kernel,
  context: CommandContext,
  command: CreateObjectiveCommand,
): Result<ObjectiveRecord> {
  const id = kernel.ids.nextId();
  const now = new Date(kernel.clock.now()).toISOString();

  // Validated before the insert, not after: an invalid record must never reach
  // the table, and the schema is the only definition of what valid means.
  const record = ObjectiveRecordSchema.parse({
    id,
    title: command.title,
    intent: command.intent,
    status: command.status,
    identityId: command.identityId,
    protocolIds: command.protocolIds,
    createdAt: now,
    updatedAt: now,
    revision: 0,
  });

  return runCommand<ObjectiveRecord>(
    kernel,
    { scope: "objective.create", key: command.idempotencyKey, resultId: id },
    (tx) => {
      tx.prepare(
        `INSERT INTO objectives
           (id, title, intent, status, identity_id, protocol_ids_json, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.title,
        record.intent,
        record.status,
        record.identityId,
        JSON.stringify(record.protocolIds),
        record.revision,
        record.createdAt,
        record.updatedAt,
      );

      return ok({
        value: record,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "objective",
            streamId: record.id,
            type: "objective.created.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              title: record.title,
              intent: record.intent,
              status: record.status,
              identityId: record.identityId,
              protocolIds: record.protocolIds,
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

/**
 * Activation is not a separate command. It is the `active` case of one status
 * transition, so there is exactly one path that can move an Objective and one
 * place the transition table is consulted. The audit stream still distinguishes
 * it, because a client subscribing to activations should not have to filter
 * every status change to find one.
 */
function statusEventName(status: ObjectiveStatus): EventName {
  return status === "active" ? "objective.activated.v1" : "objective.status_changed.v1";
}

export function changeObjectiveStatus(
  kernel: Kernel,
  context: CommandContext,
  command: ChangeObjectiveStatusCommand,
): Result<ObjectiveRecord> {
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<ObjectiveRecord>(
    kernel,
    {
      scope: "objective.change_status",
      key: command.idempotencyKey,
      resultId: command.objectiveId,
    },
    (tx) => {
      const current = getObjective(tx, command.objectiveId);

      if (current === undefined) {
        return conflict({ kind: "not_found", entity: "objective", id: command.objectiveId });
      }

      const revision = checkRevision(command.expectedRevision, current.revision);

      if (!revision.ok) {
        return conflict(revision.conflict);
      }

      const transition = transitionObjectiveStatus(current.status, command.status);

      if (!transition.ok) {
        return conflict(transition.conflict);
      }

      // First activation wins: a paused Objective returning to active keeps the
      // timestamp that says when the user actually started it.
      const activatedAt =
        command.status === "active" ? (current.activatedAt ?? now) : (current.activatedAt ?? null);
      const completedAt = command.status === "completed" ? now : (current.completedAt ?? null);

      tx.prepare(
        `UPDATE objectives
            SET status = ?, revision = ?, updated_at = ?, activated_at = ?, completed_at = ?
          WHERE id = ?`,
      ).run(command.status, revision.value, now, activatedAt, completedAt, command.objectiveId);

      const updated = getObjective(tx, command.objectiveId);

      if (updated === undefined) {
        throw new Error(`Objective ${command.objectiveId} vanished mid-transaction`);
      }

      // What the workbench restores to after a restart. It lives on the
      // identity's own thread rather than in a global runtime key, so Vesper
      // and Jester cannot restore into each other's work — the same structural
      // isolation that keeps their threads apart.
      if (command.status === "active") {
        // The identity may never have been activated in this database — a
        // Jester Objective activated while Vesper is present, say. Creating the
        // thread here rather than skipping the write is what stops the pointer
        // being silently lost in exactly that case.
        ensureThread(tx, kernel, updated.identityId, now);
        tx.prepare(
          `UPDATE identity_threads SET active_objective_id = ?, updated_at = ?
            WHERE identity_id = ?`,
        ).run(updated.id, now, updated.identityId);
      } else if (command.status === "completed" || command.status === "abandoned") {
        // Paused deliberately keeps its pointer: a paused Objective is still
        // the one the user was working on.
        tx.prepare(
          `UPDATE identity_threads SET active_objective_id = NULL, updated_at = ?
            WHERE identity_id = ? AND active_objective_id = ?`,
        ).run(now, updated.identityId, updated.id);
      }

      return ok({
        value: updated,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "objective",
            streamId: updated.id,
            type: statusEventName(command.status),
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: { from: current.status, to: updated.status, revision: updated.revision },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}
