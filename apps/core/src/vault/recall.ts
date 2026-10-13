import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import type {
  RecallVaultCommand,
  VaultFreshness,
  VaultRecall,
  VaultRecallEvidence,
} from "@noctis/contracts";
import { VaultRecallSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { normalizeKey, ok, parseNote } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import type { VaultRoot } from "./root.js";
import { isInsideRoot } from "./root.js";

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

  return recallOf(
    db,
    entities.map((entity) => entity.id),
    options,
  );
}

/** Shorter words name nothing worth recalling and match too much: "ok", "u", "hi". */
const MIN_TERM = 3;

/**
 * Recall for a sentence, by the names written in it.
 *
 * `recallFor` treats its query as one name, so a whole message — "what do you
 * know about tolga" — matches nothing. Every run of one to three words is
 * tried instead as a note's key or alias, the same vocabulary a wikilink uses.
 */
export function recallNamedIn(
  db: NoctisDatabase,
  text: string,
  options: RecallOptions,
): { entityIds: string[]; evidence: VaultRecallEvidence[]; freshness: VaultFreshness } {
  const words = text
    .toLowerCase()
    .replaceAll(/['’]s\b/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
  const terms = new Set<string>();

  for (let start = 0; start < words.length; start += 1) {
    for (let size = 1; size <= 3 && start + size <= words.length; size += 1) {
      const term = words.slice(start, start + size).join("-");

      if (term.length >= MIN_TERM) {
        terms.add(term);
      }
    }
  }

  if (terms.size === 0) {
    return recallOf(db, [], options);
  }

  const entities = db
    .prepare(
      `SELECT DISTINCT e.id, e.key, e.item_id FROM vault_entities e, json_each(?) t
        WHERE (e.key = t.value OR instr(e.keys_index, '|' || t.value || '|') > 0
               -- A person is called by one of their names: "huda" for kasha-huda-amer.
               OR (e.type = 'person' AND instr('-' || e.key || '-', '-' || t.value || '-') > 0))
          ${options.includeSensitive === true ? "" : `AND ${VISIBLE_ENTITY}`}
        ORDER BY (e.item_id IS NOT NULL) DESC,
                 (e.key = t.value OR instr(e.keys_index, '|' || t.value || '|') > 0) DESC,
                 length(e.key) DESC
        LIMIT ?`,
    )
    .all(JSON.stringify([...terms]), options.limit ?? DEFAULT_LIMIT) as Array<{ id: string }>;

  return recallOf(
    db,
    entities.map((entity) => entity.id),
    options,
  );
}

/** How much of a name's own note recall opens with: its opening, not the note. */
const OPENING_MAX = 600;

/** A paragraph past this is cut to a window around the link. */
const PARAGRAPH_MAX = 800;

const BLANK_LINE = /\r?\n[ \t]*\r?\n/g;

/** Trims whitespace off both ends of a span, so a quote never opens on a blank line. */
function tight(raw: string, start: number, end: number): { start: number; end: number } {
  let from = start;
  let to = end;

  while (from < to && /\s/.test(raw[from] ?? "")) from += 1;
  while (to > from && /\s/.test(raw[to - 1] ?? "")) to -= 1;

  return { start: from, end: to };
}

/** The paragraph a link sits in, never reaching back into the frontmatter. */
function paragraphAround(
  raw: string,
  span: { start: number; end: number },
): { start: number; end: number } {
  let start = parseNote(raw).bodyOffset;
  let end = raw.length;

  for (const blank of raw.matchAll(BLANK_LINE)) {
    const blankEnd = blank.index + blank[0].length;

    if (blankEnd <= span.start) {
      start = Math.max(start, blankEnd);
    } else if (blank.index >= span.end) {
      end = blank.index;
      break;
    }
  }

  if (end - start > PARAGRAPH_MAX) {
    start = Math.max(start, span.start - PARAGRAPH_MAX / 2);
    end = Math.min(end, span.end + PARAGRAPH_MAX / 2);
  }

  return tight(raw, start, end);
}

/** A note's opening after its frontmatter and title heading. */
function openingOf(raw: string): { start: number; end: number } {
  const note = parseNote(raw);
  const body = tight(raw, note.bodyOffset, raw.length);
  const heading = /^#\s[^\n]*\n?/.exec(raw.slice(body.start));
  const start = body.start + (heading?.[0].length ?? 0);

  return tight(raw, start, Math.min(raw.length, start + OPENING_MAX));
}

/**
 * The file as it is now, for a note whose index still matches it. A changed
 * note's indexed spans point at the wrong bytes, so it gets no fresh quote.
 */
function readCurrent(root: VaultRoot | undefined, path: string, hash: string): string | undefined {
  if (root === undefined) {
    return undefined;
  }

  try {
    const raw = readFileSync(join(root.path, path));

    return createHash("sha256").update(raw).digest("hex") === hash
      ? raw.toString("utf8")
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The evidence for a set of names: each name's own note first, by its opening,
 * then every note that links it, by the paragraph the link sits in. Quotes are
 * verbatim slices of the file at their spans; a note that changed since it was
 * indexed falls back to the link the index recorded.
 */
function recallOf(
  db: NoctisDatabase,
  entityIds: readonly string[],
  options: RecallOptions,
): { entityIds: string[]; evidence: VaultRecallEvidence[]; freshness: VaultFreshness } {
  if (entityIds.length === 0) {
    // Nobody looked at anything, because nothing matched. That is `unknown`,
    // not `current`: an empty recall is not evidence of absence.
    return { entityIds: [], evidence: [], freshness: "unknown" };
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const open = options.includeSensitive === true;
  const placeholders = entityIds.map(() => "?").join(", ");
  const owned = db
    .prepare(
      `SELECT e.id AS entity_id, i.id AS item_id, i.path, i.content_hash
         FROM vault_entities e
         JOIN vault_items i ON i.id = e.item_id
        WHERE e.id IN (${placeholders})${open ? "" : " AND i.sensitive = 0"}`,
    )
    .all(...entityIds) as Array<{
    entity_id: string;
    item_id: string;
    path: string;
    content_hash: string;
  }>;
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

  const openings: VaultRecallEvidence[] = entityIds.flatMap((entityId) => {
    const own = owned.find((row) => row.entity_id === entityId);
    const raw =
      own === undefined ? undefined : readCurrent(options.root, own.path, own.content_hash);

    if (own === undefined || raw === undefined) {
      return [];
    }

    const span = openingOf(raw);

    return span.end > span.start
      ? [
          {
            itemId: own.item_id,
            entityId,
            path: own.path,
            span,
            quote: raw.slice(span.start, span.end),
            freshness: "current" as const,
          },
        ]
      : [];
  });

  const mentions: VaultRecallEvidence[] = rows.map((row) => {
    const raw = readCurrent(options.root, row.item_path, row.mention_hash);
    const span =
      raw === undefined
        ? { start: row.span_start, end: row.span_end }
        : paragraphAround(raw, { start: row.span_start, end: row.span_end });

    return {
      itemId: row.item_id,
      entityId: row.entity_id,
      path: row.item_path,
      span,
      quote: raw === undefined ? row.quote : raw.slice(span.start, span.end),
      freshness:
        raw === undefined ? freshnessFor(options.root, row.item_path, row.mention_hash) : "current",
    };
  });

  const evidence = [...openings, ...mentions];

  return {
    entityIds: [...entityIds],
    evidence,
    freshness: evidence.length === 0 ? "unknown" : weakest(evidence.map((item) => item.freshness)),
  };
}

/** A note page long enough for any real note, short enough not to ship a dump. */
const NOTE_MAX = 20_000;

/**
 * The text of a name's own note, for the Vault page: read from disk when
 * asked, never stored. A sensitive note needs an unlock; a name nobody has
 * written a note for has nothing to read.
 */
export function readNoteFor(
  db: NoctisDatabase,
  root: VaultRoot | undefined,
  entityId: string,
  options: { includeSensitive?: boolean } = {},
): { path: string; title: string; text: string } | undefined {
  const row = db
    .prepare(
      `SELECT i.path, i.title, i.sensitive FROM vault_entities e
         JOIN vault_items i ON i.id = e.item_id WHERE e.id = ?`,
    )
    .get(entityId) as { path: string; title: string; sensitive: number } | undefined;

  if (root === undefined || row === undefined) {
    return undefined;
  }

  if (row.sensitive === 1 && options.includeSensitive !== true) {
    return undefined;
  }

  try {
    const file = realpathSync(join(root.path, row.path));

    if (!isInsideRoot(realpathSync(root.path), file)) {
      return undefined;
    }

    const raw = readFileSync(file, "utf8");
    const body = raw.slice(parseNote(raw).bodyOffset).trim();

    return { path: row.path, title: row.title, text: body.slice(0, NOTE_MAX) };
  } catch {
    return undefined;
  }
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
