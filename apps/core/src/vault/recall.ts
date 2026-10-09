import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  RecallVaultCommand,
  VaultFreshness,
  VaultRecall,
  VaultRecallEvidence,
} from "@noctis/contracts";
import { VaultRecallSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { normalizeKey, ok } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import type { VaultRoot } from "./root.js";

/** How many notes a focused recall may open. Section 7: not a miniature full Vault. */
const DEFAULT_LIMIT = 8;

interface MentionRow {
  mention_id: string;
  entity_id: string;
  item_id: string;
  span_start: number;
  span_end: number;
  quote: string;
  mention_hash: string;
  item_path: string;
}

/**
 * Ranks freshness so a recall can report the weakest thing it stands on.
 *
 * `unknown` and `unavailable` are separate on purpose: nobody looked, versus
 * the look failed. Collapsing them would let a missing file be reported as an
 * open question.
 */
const FRESHNESS_RANK: Readonly<Record<VaultFreshness, number>> = {
  current: 0,
  stale: 1,
  unknown: 2,
  unavailable: 3,
};

function weakest(values: readonly VaultFreshness[]): VaultFreshness {
  return values.reduce<VaultFreshness>(
    (worst, value) => (FRESHNESS_RANK[value] > FRESHNESS_RANK[worst] ? value : worst),
    "current",
  );
}

/**
 * How much a remembered claim can still be trusted.
 *
 * The note on disk is the authority, so the comparison is against the file as
 * it is right now, not against what the index last recorded. A mention derived
 * from a hash the file no longer has is `stale` — the claim may still be true,
 * but the evidence for it has moved.
 */
export function freshnessFor(
  root: VaultRoot | undefined,
  itemPath: string,
  mentionHash: string,
): VaultFreshness {
  if (root === undefined) {
    // No configured Vault means nobody can look, which is not the same as
    // looking and finding the note missing.
    return "unknown";
  }

  const absolute = join(root.path, itemPath);

  if (!existsSync(absolute)) {
    return "unavailable";
  }

  let onDisk: string;

  try {
    onDisk = createHash("sha256").update(readFileSync(absolute)).digest("hex");
  } catch {
    return "unavailable";
  }

  // Against the file as it is right now, not against what the index last
  // recorded. Comparing two database rows would agree with itself even when
  // the note had been rewritten in Obsidian since — which is precisely the
  // case this word exists to report.
  //
  // ponytail: re-hashes each cited note per recall. A focused recall touches a
  // few dozen files at most; cache on (path, mtime, size) if a recall ever
  // shows up in a performance budget.
  return mentionHash === onDisk ? "current" : "stale";
}

export interface RecallOptions {
  root: VaultRoot | undefined;
  limit?: number;
  /** Only a passcode unlock sets this. Agents' recall never does. */
  includeSensitive?: boolean;
}

/**
 * An entity a locked reader may see, written against the alias `e`: not a
 * sensitive note itself, and not a name that only sensitive notes mention.
 */
export const VISIBLE_ENTITY = `(e.item_id IS NULL OR e.item_id NOT IN (SELECT id FROM vault_items WHERE sensitive = 1))
  AND (e.item_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM vault_mentions vm JOIN vault_items vi ON vi.id = vm.item_id
     WHERE vm.entity_id = e.id AND vi.sensitive = 0))`;

/**
 * Opens the subgraph a query touches, and nothing else.
 *
 * Matching is on the normalized key and the entity name, which is the same
 * vocabulary a wikilink uses, so recall finds what a human would have linked.
 * ponytail: `LIKE` over entity names and keys. It is exact enough for a Vault
 * of thousands and needs no index beyond the unique key; reach for FTS5 when a
 * real corpus proves it too slow, not before.
 */
export function recallFor(
  db: NoctisDatabase,
  query: string,
  options: RecallOptions,
): { entityIds: string[]; evidence: VaultRecallEvidence[]; freshness: VaultFreshness } {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const key = normalizeKey(query);
  const pattern = `%${key}%`;
  const open = options.includeSensitive === true;

  const entities = db
    .prepare(
      `SELECT e.id FROM vault_entities e
        WHERE (e.key LIKE ? OR LOWER(e.name) LIKE ?)${open ? "" : ` AND ${VISIBLE_ENTITY}`}
        ORDER BY (e.key = ?) DESC, e.key
        LIMIT ?`,
    )
    .all(pattern, `%${query.trim().toLowerCase()}%`, key, limit) as Array<{ id: string }>;

  const entityIds = entities.map((entity) => entity.id);

  if (entityIds.length === 0) {
    // Nobody looked at anything, because nothing matched. That is `unknown`,
    // not `current`: an empty recall is not evidence of absence.
    return { entityIds: [], evidence: [], freshness: "unknown" };
  }

  const placeholders = entityIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT m.id AS mention_id, m.entity_id, m.item_id, m.span_start, m.span_end, m.quote,
              m.content_hash AS mention_hash, i.path AS item_path
         FROM vault_mentions m
         JOIN vault_items i ON i.id = m.item_id
        WHERE m.entity_id IN (${placeholders})${open ? "" : " AND i.sensitive = 0"}
        ORDER BY i.path, m.span_start
        LIMIT ?`,
    )
    .all(...entityIds, limit * 4) as unknown as MentionRow[];

  const evidence: VaultRecallEvidence[] = rows.map((row) => ({
    itemId: row.item_id,
    entityId: row.entity_id,
    path: row.item_path,
    span: { start: row.span_start, end: row.span_end },
    quote: row.quote,
    freshness: freshnessFor(options.root, row.item_path, row.mention_hash),
  }));

  return {
    entityIds,
    evidence,
    freshness: evidence.length === 0 ? "unknown" : weakest(evidence.map((item) => item.freshness)),
  };
}

export function getRecall(db: NoctisDatabase, id: string): VaultRecall | undefined {
  const row = db
    .prepare(
      `SELECT id, objective_id, query, entity_ids_json, evidence_json, freshness, recorded_at
         FROM vault_recalls WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        objective_id: string | null;
        query: string;
        entity_ids_json: string;
        evidence_json: string;
        freshness: string;
        recorded_at: string;
      }
    | undefined;

  return row === undefined
    ? undefined
    : VaultRecallSchema.parse({
        id: row.id,
        ...(row.objective_id === null ? {} : { objectiveId: row.objective_id }),
        query: row.query,
        entityIds: JSON.parse(row.entity_ids_json) as unknown,
        evidence: JSON.parse(row.evidence_json) as unknown,
        freshness: row.freshness,
        recordedAt: row.recorded_at,
      });
}

/**
 * Records a recall.
 *
 * Every recall is audited, including one that found nothing: Section 4.1 calls
 * `vault_recalls` an audit table, and a query that returned no evidence is
 * exactly the kind of thing worth being able to look back at.
 */
export function recordRecall(
  kernel: Kernel,
  context: CommandContext,
  command: RecallVaultCommand,
  root: VaultRoot | undefined,
): Result<VaultRecall> {
  const now = new Date(kernel.clock.now()).toISOString();
  const id = kernel.ids.nextId();

  return runCommand<VaultRecall>(
    kernel,
    { scope: "vault.recall", key: command.idempotencyKey, resultId: id },
    (tx) => {
      const found = recallFor(tx, command.query, {
        root,
        ...(command.limit === undefined ? {} : { limit: command.limit }),
      });

      const record = VaultRecallSchema.parse({
        id,
        ...(command.objectiveId === undefined ? {} : { objectiveId: command.objectiveId }),
        query: command.query,
        entityIds: found.entityIds,
        evidence: found.evidence,
        freshness: found.freshness,
        recordedAt: now,
      });

      tx.prepare(
        `INSERT INTO vault_recalls
           (id, objective_id, query, entity_ids_json, evidence_json, freshness, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.objectiveId ?? null,
        record.query,
        JSON.stringify(record.entityIds),
        JSON.stringify(record.evidence),
        record.freshness,
        record.recordedAt,
      );

      return ok({
        value: record,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "vault",
            streamId: record.id,
            type: "vault.recall_recorded.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              query: record.query,
              entityCount: record.entityIds.length,
              evidenceCount: record.evidence.length,
              freshness: record.freshness,
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}
