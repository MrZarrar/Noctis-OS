import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";

import { isSensitiveNote, parseNote } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { Kernel } from "../kernel.js";
import type { VaultRoot } from "./root.js";
import {
  VaultConflict,
  VaultWriteRefused,
  hashOf,
  resolveWritePath,
  writeNoteAtomically,
  writesEnabled,
} from "./writes.js";

/**
 * The promoter's only writer. The model proposes a fact, a new note or a
 * revision; this decides. Facts land inside a Noctis-owned block and new notes
 * only where none exists, so both apply without asking and can be undone.
 * Anything that would change the owner's own words waits as `pending`.
 */
export const FACTS_OPEN = "<!-- noctis:facts -->";
export const FACTS_CLOSE = "<!-- /noctis:facts -->";
const ALLOWED = /^(people|reference|projects)\/[^\\:]+\.md$/;

export type VaultEditStatus = "applied" | "undone" | "pending" | "declined" | "refused";
export interface VaultEdit {
  id: string;
  kind: "fact" | "note" | "revision";
  path: string;
  source: string;
  text: string;
  replaceText?: string;
  status: VaultEditStatus;
  reason?: string;
  turnId?: string;
  createdAt: string;
  decidedAt?: string;
}
export interface PromoteDeps {
  kernel: Kernel;
  root: VaultRoot | undefined;
  env: Readonly<Record<string, string | undefined>>;
  /** Tests only: runs between the read and the write, to stage a conflict. */
  beforeWrite?: () => void;
}

interface Row {
  id: string;
  kind: VaultEdit["kind"];
  path: string;
  source: string;
  text: string;
  replace_text: string | null;
  status: VaultEditStatus;
  reason: string | null;
  before_contents: string | null;
  after_hash: string | null;
  turn_id: string | null;
  created_at: string;
  decided_at: string | null;
}

const toEdit = (row: Row): VaultEdit => ({
  id: row.id,
  kind: row.kind,
  path: row.path,
  source: row.source,
  text: row.text,
  ...(row.replace_text === null ? {} : { replaceText: row.replace_text }),
  status: row.status,
  ...(row.reason === null ? {} : { reason: row.reason }),
  ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
  createdAt: row.created_at,
  ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
});

const now = (deps: PromoteDeps): string => new Date(deps.kernel.clock.now()).toISOString();

function record(deps: PromoteDeps, edit: Omit<Row, "id" | "created_at" | "decided_at">): VaultEdit {
  const id = deps.kernel.ids.nextId();
  deps.kernel.db
    .prepare(
      `INSERT INTO vault_edits (id, kind, path, source, text, replace_text, status, reason, before_contents, after_hash, turn_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      edit.kind,
      edit.path,
      edit.source,
      edit.text,
      edit.replace_text,
      edit.status,
      edit.reason,
      edit.before_contents,
      edit.after_hash,
      edit.turn_id,
      now(deps),
    );
  return getEdit(deps.kernel.db, id) as VaultEdit;
}

function getRow(db: NoctisDatabase, id: string): Row | undefined {
  return db.prepare(`SELECT * FROM vault_edits WHERE id = ?`).get(id) as Row | undefined;
}

export function getEdit(db: NoctisDatabase, id: string): VaultEdit | undefined {
  const row = getRow(db, id);
  return row === undefined ? undefined : toEdit(row);
}

export function listEdits(db: NoctisDatabase, limit: number): VaultEdit[] {
  return (
    db
      .prepare(`SELECT * FROM vault_edits ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as unknown as Row[]
  ).map(toEdit);
}

/** Why a write may not happen, before any bytes are read. */
function refusalFor(deps: PromoteDeps, path: string): string | undefined {
  if (deps.root === undefined) return "no_vault";
  if (!writesEnabled(deps.env)) return "writes_disabled";
  if (!ALLOWED.test(path) || path.split("/").includes("..")) return "path_not_allowed";
  return undefined;
}

/** Writes, mapping the write service's refusals to reasons. */
function write(
  deps: PromoteDeps,
  path: string,
  contents: string,
  expectedHash: string | undefined,
): string | undefined {
  try {
    deps.beforeWrite?.();
    writeNoteAtomically(
      { root: deps.root as VaultRoot, env: deps.env },
      { path, contents, ...(expectedHash === undefined ? {} : { expectedHash }) },
    );
    return undefined;
  } catch (error) {
    if (error instanceof VaultConflict) return "conflict";
    if (error instanceof VaultWriteRefused) return "path_not_allowed";
    throw error;
  }
}

const sourceLink = (source: string): string => `[[${basename(source, ".md")}]]`;

/** The note's text, or why the promoter may not touch it. */
function readEditable(deps: PromoteDeps, path: string): { raw: string } | { reason: string } {
  const early = refusalFor(deps, path);
  if (early !== undefined) return { reason: early };
  const file = resolveWritePath(deps.root as VaultRoot, path);
  if (!existsSync(file)) return { reason: "note_missing" };
  const raw = readFileSync(file, "utf8");
  return isSensitiveNote(parseNote(raw)) ? { reason: "sensitive" } : { raw };
}

export function addFact(
  deps: PromoteDeps,
  input: { path: string; fact: string; source: string; turnId?: string },
): VaultEdit {
  const base = {
    kind: "fact" as const,
    path: input.path,
    source: input.source,
    text: input.fact,
    replace_text: null,
    turn_id: input.turnId ?? null,
  };
  const refused = (reason: string): VaultEdit =>
    record(deps, { ...base, status: "refused", reason, before_contents: null, after_hash: null });

  const read = readEditable(deps, input.path);
  if ("reason" in read) return refused(read.reason);
  const { raw } = read;

  const fact = input.fact.trim();
  const line = `- ${fact} (from ${sourceLink(input.source)})`;
  const open = raw.indexOf(FACTS_OPEN);
  const close = raw.indexOf(FACTS_CLOSE);
  let next: string;

  if (open !== -1 && close > open) {
    if (raw.slice(open, close).toLowerCase().includes(`- ${fact.toLowerCase()}`)) {
      return refused("already_known");
    }
    next = `${raw.slice(0, close)}${line}\n${raw.slice(close)}`;
  } else {
    next = `${raw.trimEnd()}\n\n${FACTS_OPEN}\n${line}\n${FACTS_CLOSE}\n`;
  }

  const failed = write(deps, input.path, next, hashOf(raw));
  if (failed !== undefined) return refused(failed);

  return record(deps, {
    ...base,
    status: "applied",
    reason: null,
    before_contents: raw,
    after_hash: hashOf(next),
  });
}

export function createNote(
  deps: PromoteDeps,
  input: { path: string; title: string; body: string; source: string; turnId?: string },
): VaultEdit {
  const base = {
    kind: "note" as const,
    path: input.path,
    source: input.source,
    text: input.body,
    replace_text: null,
    turn_id: input.turnId ?? null,
  };
  const refused = (reason: string): VaultEdit =>
    record(deps, { ...base, status: "refused", reason, before_contents: null, after_hash: null });
  const early = refusalFor(deps, input.path);
  if (early !== undefined) return refused(early);
  if (existsSync(resolveWritePath(deps.root as VaultRoot, input.path))) {
    return refused("note_exists");
  }

  const created = now(deps).slice(0, 10);
  const contents = `---\ntitle: ${JSON.stringify(input.title)}\ntags: []\ncreated: ${created}\nsource: noctis-promoter\n---\n\n# ${input.title}\n\n${input.body.trim()}\n\nFrom ${sourceLink(input.source)}.\n`;
  const failed = write(deps, input.path, contents, undefined);
  if (failed !== undefined) return refused(failed === "conflict" ? "note_exists" : failed);

  return record(deps, {
    ...base,
    status: "applied",
    reason: null,
    before_contents: null,
    after_hash: hashOf(contents),
  });
}

export function proposeRevision(
  deps: PromoteDeps,
  input: {
    path: string;
    find: string;
    replace: string;
    reason: string;
    source: string;
    turnId?: string;
  },
): VaultEdit {
  const read = readEditable(deps, input.path);
  const reason =
    "reason" in read
      ? read.reason
      : read.raw.split(input.find).length !== 2
        ? "find_not_found"
        : undefined;

  return record(deps, {
    kind: "revision",
    path: input.path,
    source: input.source,
    text: input.find,
    replace_text: input.replace,
    turn_id: input.turnId ?? null,
    status: reason === undefined ? "pending" : "refused",
    reason: reason ?? input.reason,
    before_contents: null,
    after_hash: null,
  });
}

function decide(
  deps: PromoteDeps,
  id: string,
  status: VaultEditStatus,
  reason: string | null,
  fields: { before?: string; after?: string } = {},
): VaultEdit {
  deps.kernel.db
    .prepare(
      `UPDATE vault_edits SET status = ?, reason = COALESCE(?, reason), decided_at = ?,
         before_contents = COALESCE(?, before_contents), after_hash = COALESCE(?, after_hash)
       WHERE id = ?`,
    )
    .run(status, reason, now(deps), fields.before ?? null, fields.after ?? null, id);
  return getEdit(deps.kernel.db, id) as VaultEdit;
}

export function applyRevision(deps: PromoteDeps, id: string): VaultEdit {
  const row = getRow(deps.kernel.db, id);
  if (row === undefined || row.status !== "pending" || row.replace_text === null) {
    throw new VaultWriteRefused("Only a pending revision can be applied.");
  }
  const read = readEditable(deps, row.path);
  if ("reason" in read) return decide(deps, id, "pending", read.reason);
  if (read.raw.split(row.text).length !== 2) return decide(deps, id, "refused", "find_not_found");

  const next = read.raw.replace(row.text, () => row.replace_text as string);
  const failed = write(deps, row.path, next, hashOf(read.raw));
  return failed === undefined
    ? decide(deps, id, "applied", null, { before: read.raw, after: hashOf(next) })
    : decide(deps, id, "pending", failed);
}

export function declineRevision(deps: PromoteDeps, id: string): VaultEdit {
  const row = getRow(deps.kernel.db, id);
  if (row === undefined || row.status !== "pending") {
    throw new VaultWriteRefused("Only a pending revision can be declined.");
  }
  return decide(deps, id, "declined", null);
}

export function undoEdit(deps: PromoteDeps, id: string): VaultEdit {
  const row = getRow(deps.kernel.db, id);
  if (row === undefined || row.status !== "applied" || row.after_hash === null) {
    throw new VaultWriteRefused("Only an applied edit can be undone.");
  }
  const early = refusalFor(deps, row.path);
  if (early !== undefined) return decide(deps, id, "applied", early);

  const file = resolveWritePath(deps.root as VaultRoot, row.path);
  const onDisk = existsSync(file) ? hashOf(readFileSync(file)) : undefined;
  if (onDisk !== row.after_hash) return decide(deps, id, "applied", "changed_since");

  if (row.before_contents === null) {
    unlinkSync(file);
    return decide(deps, id, "undone", null);
  }

  const failed = write(deps, row.path, row.before_contents, row.after_hash);
  return failed === undefined
    ? decide(deps, id, "undone", null)
    : decide(deps, id, "applied", failed);
}

/**
 * An agent's capture: a new note in `inbox/`, written by the core under the
 * same Vault switch, so no agent needs a write share on the folder. Never
 * overwrites: a taken name gets a number.
 */
export function captureToInbox(
  deps: PromoteDeps,
  input: { title: string; body: string; identityId: string },
): { path: string } | { reason: string } {
  if (deps.root === undefined) return { reason: "no_vault" };
  if (!writesEnabled(deps.env)) return { reason: "writes_disabled" };

  const date = now(deps).slice(0, 10);
  const slug =
    input.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "note";
  const contents = `---\ntitle: ${JSON.stringify(input.title)}\ntags: []\ncreated: ${date}\nsource: noctis-${input.identityId}\n---\n\n${input.body.trim()}\n`;

  for (let n = 1; n <= 20; n += 1) {
    const path = `inbox/${date}-${slug}${n === 1 ? "" : `-${String(n)}`}.md`;
    if (write(deps, path, contents, undefined) === undefined) return { path };
  }
  return { reason: "name_taken" };
}
