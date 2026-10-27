import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { conflict, isSensitiveNote, ok, parseNote } from "@noctis/domain";
import type { Result } from "@noctis/domain";

import type { ConversationService } from "../conversation/service.js";
import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import type { VaultRoot } from "./root.js";
import { hashOf } from "./writes.js";

/**
 * A promoter run is an ordinary Vesper turn in its own "Vault upkeep" thread.
 * This picks which inbox notes it is given; the agent answers with Vault
 * proposals, and `promote.ts` decides what is written.
 */
export const BATCH = 8;
// Recall adds its own quotes and paths after this prompt is built.
const PROMPT_BUDGET = 12_000;

export interface InboxNote {
  path: string;
  hash: string;
  text: string;
}

/**
 * Inbox notes not yet given to a run that succeeded or is still going, oldest
 * name first. Read from disk rather than the index, so a note captured since
 * the last reindex is still offered.
 */
export function nextInboxBatch(db: NoctisDatabase, root: VaultRoot, max = BATCH): InboxNote[] {
  const inbox = join(root.path, "inbox");
  if (!existsSync(inbox)) return [];

  const settled = db.prepare(
    `SELECT 1 FROM vault_promotions p LEFT JOIN identity_turns t ON t.id = p.turn_id
      WHERE p.path = ? AND p.content_hash = ?
        AND COALESCE(t.status, 'running') NOT IN ('failed', 'cancelled')
      LIMIT 1`,
  );
  const notes: InboxNote[] = [];

  for (const name of readdirSync(inbox)
    .filter((file) => file.endsWith(".md"))
    .sort()) {
    if (notes.length >= max) break;
    const path = `inbox/${name}`;
    const raw = readFileSync(join(inbox, name));
    const text = raw.toString("utf8");
    const hash = hashOf(raw);
    if (isSensitiveNote(parseNote(text))) continue;
    if (settled.get(path, hash) !== undefined) continue;
    const note = { path, hash, text: text.slice(0, 6000) };
    if (promoterPrompt([...notes, note]).length > PROMPT_BUDGET) break;
    notes.push(note);
  }
  return notes;
}

export function offer(
  db: NoctisDatabase,
  batch: readonly InboxNote[],
  turnId: string,
  at: string,
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO vault_promotions (path, content_hash, turn_id, offered_at) VALUES (?, ?, ?, ?)`,
  );
  for (const note of batch) insert.run(note.path, note.hash, turnId, at);
}

export function promoterPrompt(batch: readonly InboxNote[]): string {
  return [
    "Vault upkeep. These inbox notes have not been filed into the owner's MindVault yet. For each durable fact about a person, project or topic:",
    "- if a note for it exists under people/, reference/ or projects/, call noctis_propose_vault_fact with one line and [[wikilinks]] for every name;",
    "- if none exists and it deserves one, call noctis_propose_vault_note;",
    "- if the inbox contradicts something the owner wrote, call noctis_propose_vault_revision quoting their exact words; the owner decides.",
    "Search the MindVault first so you link to notes that exist and never add a fact a note already states. Name the inbox note as the source. Skip chatter, tasks and anything already filed. Reply with one line per inbox note saying what you did.",
    "",
    ...batch.map((note) => `--- ${note.path} ---\n${note.text}`),
  ].join("\n");
}

export interface PromoterDeps {
  kernel: Kernel;
  conversations: Pick<ConversationService, "createThread" | "sendMessage">;
  root: VaultRoot | undefined;
}

export function promoteNow(
  deps: PromoterDeps,
  context: CommandContext,
  idempotencyKey: string,
): Result<{ turnId?: string; notes: number }> {
  if (deps.root === undefined) {
    return conflict({ kind: "unavailable", entity: "vault", reason: "no_vault" });
  }
  const { db } = deps.kernel;
  const batch = nextInboxBatch(db, deps.root);
  if (batch.length === 0) return ok({ notes: 0 });

  let threadId = (
    db.prepare(`SELECT thread_id FROM vault_promoter WHERE id = 1`).get() as
      { thread_id: string } | undefined
  )?.thread_id;

  if (threadId === undefined) {
    const thread = deps.conversations.createThread(context, {
      idempotencyKey: `${idempotencyKey}-thread`,
      identityId: "vesper",
      title: "Vault upkeep",
    });
    if (!thread.ok) return thread;
    threadId = thread.value.id;
    db.prepare(`INSERT OR REPLACE INTO vault_promoter (id, thread_id) VALUES (1, ?)`).run(threadId);
  }

  const turn = deps.conversations.sendMessage(context, {
    idempotencyKey,
    identityId: "vesper",
    threadId,
    text: promoterPrompt(batch),
  });
  if (!turn.ok) return turn;

  offer(db, batch, turn.value.id, new Date(deps.kernel.clock.now()).toISOString());
  return ok({ turnId: turn.value.id, notes: batch.length });
}
