import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import type { VaultEntityType, VaultItem } from "@noctis/contracts";
import { VaultItemSchema } from "@noctis/contracts";
import type { ParsedNote, Result, SettleNode } from "@noctis/domain";
import {
  LAYOUT_VERSION,
  isGeneratedNote,
  isSensitiveNote,
  keysFor,
  normalizeKey,
  ok,
  parseNote,
  settle,
  titleFor,
} from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import type { VaultRoot } from "./root.js";
import { isInsideRoot } from "./root.js";

/** Directories that are never notes. `.obsidian` holds Obsidian's own config. */
const SKIP_DIRECTORIES = new Set([".obsidian", ".git", ".trash", "node_modules"]);

/** Section 7's PARA folders decide a note's type. Derived from the path alone. */
const TYPE_BY_FOLDER: Readonly<Record<string, VaultEntityType>> = {
  inbox: "capture",
  projects: "project",
  people: "person",
  reference: "reference",
  daily: "daily",
  agent: "agent",
};

export function typeForPath(vaultPath: string): VaultEntityType {
  return TYPE_BY_FOLDER[vaultPath.split("/")[0] ?? ""] ?? "note";
}

export interface IndexResult {
  scanned: number;
  added: number;
  updated: number;
  /** Notes whose hash was unchanged, so their derivations were left alone. */
  unchanged: number;
  removed: number;
  entities: number;
  edges: number;
}

interface ScannedFile {
  path: string;
  hash: string;
  byteLength: number;
  modifiedAt: string;
  note: ParsedNote;
}

/**
 * Every Markdown file under the root, read once.
 *
 * Each entry is realpath-resolved and checked to still be inside the root, so a
 * symlink in the Vault pointing at the real OneDrive folder is skipped rather
 * than followed — the guard that makes `root.ts`'s refusal hold at file level
 * too, not just at configuration time.
 */
function scan(root: VaultRoot): ScannedFile[] {
  const files: ScannedFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
          walk(absolute);
        }
        continue;
      }

      if (!entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }

      let resolved: string;

      try {
        resolved = realpathSync(absolute);
      } catch {
        continue;
      }

      if (!isInsideRoot(root.path, resolved)) {
        continue;
      }

      const raw = readFileSync(resolved);
      const text = raw.toString("utf8");
      const note = parseNote(text);

      if (isGeneratedNote(note)) {
        continue;
      }

      files.push({
        path: relative(root.path, resolved).split(sep).join(posix.sep),
        hash: createHash("sha256").update(raw).digest("hex"),
        byteLength: raw.byteLength,
        modifiedAt: new Date(statSync(resolved).mtimeMs).toISOString(),
        note,
      });
    }
  };

  walk(root.path);

  // Sorted so a reindex processes notes in the same order on every platform,
  // which is half of what makes repeated indexing produce identical rows.
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

type ItemRow = {
  id: string;
  path: string;
  title: string;
  content_hash: string;
  byte_length: number;
  modified_at: string;
  indexed_at: string;
};

function toItem(row: ItemRow): VaultItem {
  return VaultItemSchema.parse({
    id: row.id,
    path: row.path,
    title: row.title,
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
  });
}

export function getVaultItem(db: NoctisDatabase, id: string): VaultItem | undefined {
  const row = db
    .prepare(
      `SELECT id, path, title, content_hash, byte_length, modified_at, indexed_at
         FROM vault_items WHERE id = ?`,
    )
    .get(id) as ItemRow | undefined;

  return row === undefined ? undefined : toItem(row);
}

/** Sensitive notes are left out unless the caller holds a passcode unlock. */
export function listVaultItems(
  db: NoctisDatabase,
  options: { includeSensitive?: boolean } = {},
): VaultItem[] {
  const rows = db
    .prepare(
      `SELECT id, path, title, content_hash, byte_length, modified_at, indexed_at
         FROM vault_items WHERE ? = 1 OR sensitive = 0 ORDER BY path`,
    )
    .all(options.includeSensitive === true ? 1 : 0) as ItemRow[];

  return rows.map(toItem);
}

interface EntityRow {
  id: string;
  key: string;
  item_id: string | null;
}

/** `|alex-kerr|alex|` — see the `keys_index` comment in migration 0004. */
function keysIndex(keys: readonly string[]): string {
  return keys.length === 0 ? "" : `|${keys.join("|")}|`;
}

/**
 * Finds or creates the entity a note *is*.
 *
 * The keys are tried in a fixed order, and an existing placeholder — an entity
 * a link created before the note existed — is adopted rather than duplicated,
 * so writing the note that a link pointed at connects the graph instead of
 * growing a second node beside it.
 *
 * ponytail: adopts the first matching placeholder only. A note whose title and
 * alias were each linked before it existed leaves the second placeholder
 * standing as its own node. Merge them if that ever shows up in a real Vault;
 * it needs an edge-rewrite pass, which is more machinery than the case earns.
 */
function entityForNote(
  tx: NoctisDatabase,
  kernel: Kernel,
  file: ScannedFile,
  itemId: string,
  now: string,
): string {
  const type = typeForPath(file.path);
  const name = titleFor(file.path, file.note);
  const keys = keysFor(file.path, file.note);
  const canonical = keys[0] ?? normalizeKey(file.path);

  const index = keysIndex(keys);

  const owned = tx
    .prepare(`SELECT id, key, item_id FROM vault_entities WHERE item_id = ?`)
    .get(itemId) as EntityRow | undefined;

  if (owned !== undefined) {
    tx.prepare(`UPDATE vault_entities SET name = ?, type = ?, keys_index = ? WHERE id = ?`).run(
      name,
      type,
      index,
      owned.id,
    );
    return owned.id;
  }

  for (const key of keys) {
    const existing = tx
      .prepare(`SELECT id, key, item_id FROM vault_entities WHERE key = ?`)
      .get(key) as EntityRow | undefined;

    if (existing !== undefined && existing.item_id === null) {
      tx.prepare(
        `UPDATE vault_entities SET name = ?, type = ?, item_id = ?, keys_index = ? WHERE id = ?`,
      ).run(name, type, itemId, index, existing.id);
      return existing.id;
    }
  }

  const id = kernel.ids.nextId();

  tx.prepare(
    `INSERT INTO vault_entities (id, key, name, type, item_id, keys_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name, type = excluded.type,
       item_id = excluded.item_id, keys_index = excluded.keys_index`,
  ).run(id, canonical, name, type, itemId, index, now);

  const stored = tx
    .prepare(`SELECT id, key, item_id FROM vault_entities WHERE key = ?`)
    .get(canonical) as EntityRow | undefined;

  return stored?.id ?? id;
}

/**
 * Finds the entity a wikilink names, creating a placeholder if nothing answers.
 *
 * The alias lookup is the second step for a reason: `[[Alex]]` must reach the
 * "Alex Kerr" note that declares `Alex` as an alias, and giving the alias its
 * own entity would put two nodes in the graph for one note. A key that nothing
 * answers to becomes a placeholder, which is how a link to an unwritten note
 * stays a real, unresolved edge.
 */
function resolveOrCreateEntity(
  tx: NoctisDatabase,
  kernel: Kernel,
  key: string,
  name: string,
  now: string,
): EntityRow {
  const direct = tx
    .prepare(`SELECT id, key, item_id FROM vault_entities WHERE key = ?`)
    .get(key) as EntityRow | undefined;

  if (direct !== undefined) {
    return direct;
  }

  const byAlias = tx
    .prepare(
      `SELECT id, key, item_id FROM vault_entities
        WHERE keys_index LIKE ? AND item_id IS NOT NULL ORDER BY key LIMIT 1`,
    )
    .get(`%|${key}|%`) as EntityRow | undefined;

  if (byAlias !== undefined) {
    return byAlias;
  }

  const id = kernel.ids.nextId();

  tx.prepare(
    `INSERT INTO vault_entities (id, key, name, type, item_id, keys_index, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, key, name, "note", keysIndex([key]), now);

  return { id, key, item_id: null };
}

/**
 * Rebuilds the index from the Markdown on disk.
 *
 * A note whose hash is unchanged keeps its derived rows untouched: that is what
 * makes "changed notes invalidate only affected derivations" true, and it is
 * also why running this twice is a no-op rather than a churn of new ids.
 */
export function indexVault(
  kernel: Kernel,
  context: CommandContext,
  root: VaultRoot,
  idempotencyKey: string,
): Result<IndexResult> {
  const now = new Date(kernel.clock.now()).toISOString();
  const files = scan(root);

  return runCommand<IndexResult>(
    kernel,
    { scope: "vault.reindex", key: idempotencyKey, resultId: kernel.ids.nextId() },
    (tx) => {
      const result: IndexResult = {
        scanned: files.length,
        added: 0,
        updated: 0,
        unchanged: 0,
        removed: 0,
        entities: 0,
        edges: 0,
      };

      const seen = new Set<string>();
      const changed: Array<{ file: ScannedFile; itemId: string; entityId: string }> = [];

      for (const file of files) {
        seen.add(file.path);

        const existing = tx
          .prepare(`SELECT id, content_hash FROM vault_items WHERE path = ?`)
          .get(file.path) as { id: string; content_hash: string } | undefined;

        const title = titleFor(file.path, file.note);
        const sensitive = isSensitiveNote(file.note) ? 1 : 0;

        if (existing === undefined) {
          const itemId = kernel.ids.nextId();

          tx.prepare(
            `INSERT INTO vault_items (id, path, title, content_hash, byte_length, modified_at, indexed_at, sensitive)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            itemId,
            file.path,
            title,
            file.hash,
            file.byteLength,
            file.modifiedAt,
            now,
            sensitive,
          );

          result.added += 1;
          changed.push({ file, itemId, entityId: entityForNote(tx, kernel, file, itemId, now) });
          continue;
        }

        if (existing.content_hash === file.hash) {
          // Rows indexed before migration 0014 learn their flag without a rewrite.
          tx.prepare(`UPDATE vault_items SET sensitive = ? WHERE id = ? AND sensitive <> ?`).run(
            sensitive,
            existing.id,
            sensitive,
          );
          result.unchanged += 1;
          continue;
        }

        tx.prepare(
          `UPDATE vault_items SET title = ?, content_hash = ?, byte_length = ?, modified_at = ?, indexed_at = ?,
                  sensitive = ?
            WHERE id = ?`,
        ).run(title, file.hash, file.byteLength, file.modifiedAt, now, sensitive, existing.id);

        // Only this note's derivations are dropped. Every other note's edges and
        // mentions are untouched by a change here.
        tx.prepare(`DELETE FROM vault_edges WHERE source_item_id = ?`).run(existing.id);
        tx.prepare(`DELETE FROM vault_mentions WHERE item_id = ?`).run(existing.id);

        result.updated += 1;
        changed.push({
          file,
          itemId: existing.id,
          entityId: entityForNote(tx, kernel, file, existing.id, now),
        });
      }

      // A note that is gone takes its derivations with it, through the cascades
      // declared in migration 0004.
      for (const row of tx.prepare(`SELECT id, path FROM vault_items`).all() as Array<{
        id: string;
        path: string;
      }>) {
        if (!seen.has(row.path)) {
          tx.prepare(`DELETE FROM vault_items WHERE id = ?`).run(row.id);
          result.removed += 1;
        }
      }

      for (const { file, itemId, entityId } of changed) {
        for (const link of file.note.wikilinks) {
          const target = resolveOrCreateEntity(tx, kernel, link.key, link.target, now);
          const edgeId = kernel.ids.nextId();

          tx.prepare(
            `INSERT INTO vault_edges
               (id, src_entity_id, dst_entity_id, type, source_item_id, confidence, lifecycle, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (src_entity_id, dst_entity_id, type, source_item_id) DO NOTHING`,
          ).run(
            edgeId,
            entityId,
            target.id,
            "link",
            itemId,
            // A wikilink is an explicit human statement, not an inference.
            1,
            target.item_id === null ? "unresolved" : "resolved",
            now,
          );

          const stored = tx
            .prepare(
              `SELECT id FROM vault_edges
                WHERE src_entity_id = ? AND dst_entity_id = ? AND type = ? AND source_item_id = ?`,
            )
            .get(entityId, target.id, "link", itemId) as { id: string } | undefined;

          tx.prepare(
            `INSERT INTO vault_mentions
               (id, entity_id, item_id, edge_id, span_start, span_end, quote, content_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            kernel.ids.nextId(),
            target.id,
            itemId,
            stored?.id ?? null,
            link.span.start,
            link.span.end,
            file.note.raw.slice(link.span.start, link.span.end),
            file.hash,
            now,
          );
        }
      }

      // A link written before its note exists leaves a placeholder behind. Once
      // that note is indexed the placeholder is adopted, so every edge pointing
      // at it becomes resolved without being rewritten.
      tx.prepare(
        `UPDATE vault_edges SET lifecycle = 'resolved'
          WHERE lifecycle = 'unresolved'
            AND dst_entity_id IN (SELECT id FROM vault_entities WHERE item_id IS NOT NULL)`,
      ).run();

      // A note that goes away, or a link nobody writes any more, leaves a
      // placeholder with nothing pointing at it. Those would otherwise float in
      // the graph forever, so they go.
      tx.prepare(
        `DELETE FROM vault_entities
          WHERE item_id IS NULL
            AND id NOT IN (SELECT dst_entity_id FROM vault_edges)
            AND id NOT IN (SELECT src_entity_id FROM vault_edges)`,
      ).run();

      result.entities = (
        tx.prepare(`SELECT COUNT(*) AS count FROM vault_entities`).get() as { count: number }
      ).count;
      result.edges = (
        tx.prepare(`SELECT COUNT(*) AS count FROM vault_edges`).get() as { count: number }
      ).count;

      placeLayout(tx, now);

      return ok({
        value: result,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "vault",
            streamId: kernel.ids.nextId(),
            type: "vault.indexed.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: { ...result, live: root.live },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

/**
 * Rebalances the graph when indexed; unchanged content gets the same positions.
 */
function placeLayout(tx: NoctisDatabase, now: string): void {
  const entities = tx.prepare(`SELECT id, key, type FROM vault_entities`).all() as Array<{
    id: string;
    key: string;
    type: VaultEntityType;
  }>;

  const neighbours = new Map<string, string[]>();

  for (const edge of tx
    .prepare(`SELECT src_entity_id, dst_entity_id FROM vault_edges`)
    .all() as Array<{
    src_entity_id: string;
    dst_entity_id: string;
  }>) {
    neighbours.set(edge.src_entity_id, [
      ...(neighbours.get(edge.src_entity_id) ?? []),
      edge.dst_entity_id,
    ]);
    neighbours.set(edge.dst_entity_id, [
      ...(neighbours.get(edge.dst_entity_id) ?? []),
      edge.src_entity_id,
    ]);
  }

  const incoming: SettleNode[] = entities.map((entity) => ({
    entityId: entity.id,
    key: entity.key,
    type: entity.type,
    neighbourIds: neighbours.get(entity.id) ?? [],
  }));

  if (incoming.length === 0) {
    return;
  }

  const settled = settle({ placed: new Map(), incoming });
  const insert = tx.prepare(
    `INSERT INTO vault_layout (entity_id, version, x, y, z, settled_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (entity_id) DO UPDATE SET version = excluded.version, x = excluded.x,
       y = excluded.y, z = excluded.z, settled_at = excluded.settled_at`,
  );

  for (const node of incoming) {
    const coordinate = settled.placed.get(node.entityId);

    if (coordinate !== undefined) {
      insert.run(node.entityId, LAYOUT_VERSION, coordinate.x, coordinate.y, coordinate.z, now);
    }
  }
}
