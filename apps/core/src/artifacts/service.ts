import type {
  ArtifactRecord,
  ImportArtifactCommand,
  RecordArtifactCommand,
} from "@noctis/contracts";
import { ArtifactRecordSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import { getMission } from "../missions/service.js";
import { getObjective } from "../objectives/service.js";
import { getSource } from "../sources/service.js";

/**
 * Artifacts and lineage (Section 12.2).
 *
 * "An external reference is not a local artifact." The selected Suno song, the
 * Vinted draft, the GitHub PR — each stays an `external_reference` until an
 * explicit import produces a `local_artifact` with a host, a URI on that host,
 * and a checksum of the bytes.
 *
 * The import writes a second row. It would be shorter to change the first row's
 * kind in place, and it would lose exactly the thing the section asks for: after
 * the import, Noctis can still say which remote thing this local file came
 * from, and can still tell whether that remote thing has changed since.
 */

type ArtifactRow = {
  id: string;
  kind: string;
  title: string;
  uri: string;
  media_type: string | null;
  objective_id: string | null;
  mission_id: string | null;
  source_id: string | null;
  host_id: string | null;
  checksum: string | null;
  derived_from_artifact_id: string | null;
  provenance_version: number;
  provenance_json: string;
  created_at: string;
};

const ARTIFACT_COLUMNS = `id, kind, title, uri, media_type, objective_id, mission_id, source_id,
                          host_id, checksum, derived_from_artifact_id, provenance_version,
                          provenance_json, created_at`;

function toArtifact(row: ArtifactRow): ArtifactRecord {
  return ArtifactRecordSchema.parse({
    id: row.id,
    kind: row.kind,
    title: row.title,
    uri: row.uri,
    ...(row.media_type === null ? {} : { mediaType: row.media_type }),
    ...(row.objective_id === null ? {} : { objectiveId: row.objective_id }),
    ...(row.mission_id === null ? {} : { missionId: row.mission_id }),
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
    ...(row.host_id === null ? {} : { hostId: row.host_id }),
    ...(row.checksum === null ? {} : { checksum: row.checksum }),
    ...(row.derived_from_artifact_id === null
      ? {}
      : { derivedFromArtifactId: row.derived_from_artifact_id }),
    provenanceVersion: row.provenance_version,
    provenance: JSON.parse(row.provenance_json) as unknown,
    createdAt: row.created_at,
  });
}

export function getArtifact(db: NoctisDatabase, id: string): ArtifactRecord | undefined {
  const row = db.prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?`).get(id) as
    ArtifactRow | undefined;

  return row === undefined ? undefined : toArtifact(row);
}

export function listArtifacts(db: NoctisDatabase, limit: number): ArtifactRecord[] {
  const rows = db
    .prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as ArtifactRow[];

  return rows.map(toArtifact);
}

/** The local artifact an external reference was imported into, when one exists. */
export function importOf(db: NoctisDatabase, artifactId: string): ArtifactRecord | undefined {
  const row = db
    .prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE derived_from_artifact_id = ?`)
    .get(artifactId) as ArtifactRow | undefined;

  return row === undefined ? undefined : toArtifact(row);
}

function insert(
  tx: NoctisDatabase,
  artifact: {
    id: string;
    kind: string;
    title: string;
    uri: string;
    mediaType?: string;
    objectiveId?: string;
    missionId?: string;
    sourceId?: string;
    hostId?: string;
    checksum?: string;
    derivedFromArtifactId?: string;
    provenanceVersion: number;
    provenance: unknown;
    createdAt: string;
  },
): void {
  tx.prepare(
    `INSERT INTO artifacts
       (id, kind, title, uri, media_type, objective_id, mission_id, source_id, host_id,
        checksum, derived_from_artifact_id, provenance_version, provenance_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    artifact.id,
    artifact.kind,
    artifact.title,
    artifact.uri,
    artifact.mediaType ?? null,
    artifact.objectiveId ?? null,
    artifact.missionId ?? null,
    artifact.sourceId ?? null,
    artifact.hostId ?? null,
    artifact.checksum ?? null,
    artifact.derivedFromArtifactId ?? null,
    artifact.provenanceVersion,
    JSON.stringify(artifact.provenance ?? null),
    artifact.createdAt,
  );
}

export function recordArtifact(
  kernel: Kernel,
  context: CommandContext,
  command: RecordArtifactCommand,
): Result<ArtifactRecord> {
  const id = kernel.ids.nextId();
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<ArtifactRecord>(
    kernel,
    { scope: "artifact.record", key: command.idempotencyKey, resultId: id },
    (tx) => {
      if (
        command.objectiveId !== undefined &&
        getObjective(tx, command.objectiveId) === undefined
      ) {
        return conflict({ kind: "not_found", entity: "objective", id: command.objectiveId });
      }

      if (command.missionId !== undefined && getMission(tx, command.missionId) === undefined) {
        return conflict({ kind: "not_found", entity: "mission", id: command.missionId });
      }

      if (command.sourceId !== undefined && getSource(tx, command.sourceId) === undefined) {
        return conflict({ kind: "not_found", entity: "source", id: command.sourceId });
      }

      insert(tx, {
        id,
        kind: command.kind,
        title: command.title,
        uri: command.uri,
        ...(command.mediaType === undefined ? {} : { mediaType: command.mediaType }),
        ...(command.objectiveId === undefined ? {} : { objectiveId: command.objectiveId }),
        ...(command.missionId === undefined ? {} : { missionId: command.missionId }),
        ...(command.sourceId === undefined ? {} : { sourceId: command.sourceId }),
        ...(command.hostId === undefined ? {} : { hostId: command.hostId }),
        ...(command.checksum === undefined ? {} : { checksum: command.checksum }),
        provenanceVersion: command.provenanceVersion,
        provenance: command.provenance,
        createdAt: now,
      });

      const artifact = getArtifact(tx, id);

      if (artifact === undefined) {
        throw new Error(`Artifact ${id} vanished mid-transaction`);
      }

      return ok({
        value: artifact,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "artifact",
            streamId: id,
            type: "artifact.recorded.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              artifactId: id,
              kind: command.kind,
              title: command.title,
              ...(command.objectiveId === undefined ? {} : { objectiveId: command.objectiveId }),
              ...(command.sourceId === undefined ? {} : { sourceId: command.sourceId }),
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
 * Turns an external reference into a local artifact.
 *
 * Refuses on anything that is not an un-imported external reference: importing
 * a local artifact is a copy with no meaning, and importing the same reference
 * twice produces two local copies that will drift apart. The second is enforced
 * by a unique index as well as by this read, because a duplicate submit is a
 * concurrency problem and a read alone does not settle those.
 */
export function importArtifact(
  kernel: Kernel,
  context: CommandContext,
  command: ImportArtifactCommand,
): Result<ArtifactRecord> {
  const id = kernel.ids.nextId();
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<ArtifactRecord>(
    kernel,
    { scope: "artifact.import", key: command.idempotencyKey, resultId: id },
    (tx) => {
      const external = getArtifact(tx, command.artifactId);

      if (external === undefined) {
        return conflict({ kind: "not_found", entity: "artifact", id: command.artifactId });
      }

      if (external.kind !== "external_reference") {
        return conflict({
          kind: "authority_refused",
          requestId: command.artifactId,
          outcome: "deny",
          reasonCodes: ["not_an_external_reference"],
        });
      }

      if (importOf(tx, command.artifactId) !== undefined) {
        return conflict({
          kind: "authority_refused",
          requestId: command.artifactId,
          outcome: "deny",
          reasonCodes: ["already_imported"],
        });
      }

      insert(tx, {
        id,
        kind: "local_artifact",
        title: external.title,
        uri: command.uri,
        ...(command.mediaType === undefined
          ? external.mediaType === undefined
            ? {}
            : { mediaType: external.mediaType }
          : { mediaType: command.mediaType }),
        ...(external.objectiveId === undefined ? {} : { objectiveId: external.objectiveId }),
        ...(external.missionId === undefined ? {} : { missionId: external.missionId }),
        ...(external.sourceId === undefined ? {} : { sourceId: external.sourceId }),
        hostId: command.hostId,
        checksum: command.checksum,
        derivedFromArtifactId: external.id,
        provenanceVersion: external.provenanceVersion,
        provenance: {
          importedFrom: external.uri,
          importedAt: now,
          importedBy: context.actorId,
          original: external.provenance,
        },
        createdAt: now,
      });

      const artifact = getArtifact(tx, id);

      if (artifact === undefined) {
        throw new Error(`Artifact ${id} vanished mid-transaction`);
      }

      return ok({
        value: artifact,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "artifact",
            streamId: id,
            type: "artifact.imported.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              artifactId: id,
              derivedFromArtifactId: external.id,
              hostId: command.hostId,
              checksum: command.checksum,
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}
