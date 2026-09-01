import type {
  ChangeMissionStatusCommand,
  CreateMissionCommand,
  EventName,
  MissionRecord,
  MissionStatus,
} from "@noctis/contracts";
import { MissionRecordSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { checkRevision, conflict, ok, transitionMissionStatus } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import { getObjective } from "../objectives/service.js";

type MissionRow = {
  id: string;
  objective_id: string;
  title: string;
  status: string;
  operation_class: string;
  host_policy: string;
  host_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

const SELECT_COLUMNS = `id, objective_id, title, status, operation_class, host_policy, host_id,
                        revision, created_at, updated_at, started_at, completed_at`;

function toRecord(row: MissionRow): MissionRecord {
  return MissionRecordSchema.parse({
    id: row.id,
    objectiveId: row.objective_id,
    title: row.title,
    status: row.status,
    operationClass: row.operation_class,
    hostPolicy: row.host_policy,
    ...(row.host_id === null ? {} : { hostId: row.host_id }),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  });
}

export function getMission(db: NoctisDatabase, id: string): MissionRecord | undefined {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM missions WHERE id = ?`).get(id) as
    MissionRow | undefined;

  return row === undefined ? undefined : toRecord(row);
}

export function listMissionsForObjective(
  db: NoctisDatabase,
  objectiveId: string,
  limit: number,
): MissionRecord[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM missions WHERE objective_id = ? ORDER BY id LIMIT ?`)
    .all(objectiveId, limit) as MissionRow[];

  return rows.map(toRecord);
}

export function createMission(
  kernel: Kernel,
  context: CommandContext,
  command: CreateMissionCommand,
): Result<MissionRecord> {
  const id = kernel.ids.nextId();
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<MissionRecord>(
    kernel,
    { scope: "mission.create", key: command.idempotencyKey, resultId: id },
    (tx) => {
      // The foreign key would also reject this, but as an exception rather than
      // a refusal. A missing Objective is an expected client mistake, not a bug.
      if (getObjective(tx, command.objectiveId) === undefined) {
        return conflict({ kind: "not_found", entity: "objective", id: command.objectiveId });
      }

      const record = MissionRecordSchema.parse({
        id,
        objectiveId: command.objectiveId,
        title: command.title,
        status: "draft",
        operationClass: command.operationClass,
        hostPolicy: command.hostPolicy,
        ...(command.hostId === undefined ? {} : { hostId: command.hostId }),
        revision: 0,
        createdAt: now,
        updatedAt: now,
      });

      tx.prepare(
        `INSERT INTO missions
           (id, objective_id, title, status, operation_class, host_policy, host_id,
            revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.objectiveId,
        record.title,
        record.status,
        record.operationClass,
        record.hostPolicy,
        record.hostId ?? null,
        record.revision,
        record.createdAt,
        record.updatedAt,
      );

      tx.prepare(
        `INSERT INTO objective_links (objective_id, related_type, related_id, relation, created_at)
         VALUES (?, 'mission', ?, 'owns', ?)`,
      ).run(record.objectiveId, record.id, now);

      return ok({
        value: record,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "mission",
            streamId: record.id,
            type: "mission.created.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              objectiveId: record.objectiveId,
              title: record.title,
              operationClass: record.operationClass,
              hostPolicy: record.hostPolicy,
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
 * Three mission statuses have a dedicated event name in the contract because
 * clients react to them specifically. The rest share one name rather than being
 * forced into the nearest specific one — an audit stream that calls a failure a
 * verification is worse than one that calls it a status change.
 */
const STATUS_EVENT: Readonly<Partial<Record<MissionStatus, EventName>>> = {
  awaiting_approval: "mission.approval_requested.v1",
  running: "mission.dispatched.v1",
  succeeded: "mission.verified.v1",
};

const TERMINAL: ReadonlySet<MissionStatus> = new Set<MissionStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

export function changeMissionStatus(
  kernel: Kernel,
  context: CommandContext,
  command: ChangeMissionStatusCommand,
): Result<MissionRecord> {
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<MissionRecord>(
    kernel,
    { scope: "mission.change_status", key: command.idempotencyKey, resultId: command.missionId },
    (tx) => {
      const current = getMission(tx, command.missionId);

      if (current === undefined) {
        return conflict({ kind: "not_found", entity: "mission", id: command.missionId });
      }

      const revision = checkRevision(command.expectedRevision, current.revision);

      if (!revision.ok) {
        return conflict(revision.conflict);
      }

      const transition = transitionMissionStatus(current.status, command.status);

      if (!transition.ok) {
        return conflict(transition.conflict);
      }

      const startedAt =
        command.status === "running" ? (current.startedAt ?? now) : (current.startedAt ?? null);
      const completedAt = TERMINAL.has(command.status) ? now : (current.completedAt ?? null);

      tx.prepare(
        `UPDATE missions
            SET status = ?, revision = ?, updated_at = ?, started_at = ?, completed_at = ?
          WHERE id = ?`,
      ).run(command.status, revision.value, now, startedAt, completedAt, command.missionId);

      const updated = getMission(tx, command.missionId);

      if (updated === undefined) {
        throw new Error(`Mission ${command.missionId} vanished mid-transaction`);
      }

      return ok({
        value: updated,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "mission",
            streamId: updated.id,
            type: STATUS_EVENT[command.status] ?? "mission.status_changed.v1",
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
