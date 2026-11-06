import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  ArchivePalaceCommandSchema,
  PalaceListQuerySchema,
  PalaceReceiptSchema,
  SavePalaceCommandSchema,
  UuidSchema,
} from "@noctis/contracts";
import type {
  ArchivePalaceCommand,
  PalaceEntry,
  PalaceListQuery,
  PalaceReceipt,
  SavePalaceCommand,
} from "@noctis/contracts";
import { conflict } from "@noctis/domain";
import { ok, pagePalaceEntries, parsePalaceEntry, serializePalaceEntry } from "@noctis/domain";
import type { ParsedPalaceEntry, Result } from "@noctis/domain";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import { indexVault } from "../vault/indexer.js";
import { isUnlocked } from "../vault/passcode.js";
import type { VaultRoot } from "../vault/root.js";
import { isInsideRoot } from "../vault/root.js";
import {
  hashOf,
  resolveWritePath,
  VaultConflict,
  VaultWriteRefused,
  writeNoteAtomically,
} from "../vault/writes.js";

export interface PalaceDeps {
  kernel: Kernel;
  root: VaultRoot | undefined;
  env: Readonly<Record<string, string | undefined>>;
  principal: string;
}
export class PalaceUnavailable extends Error {}
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const pathFor = (id: string): string => `palace/entries/${UuidSchema.parse(id)}.md`;
function rootFor(deps: PalaceDeps): VaultRoot {
  if (deps.root === undefined) throw new PalaceUnavailable("Vault is not configured");
  return deps.root;
}
function unlocked(deps: PalaceDeps): boolean {
  return isUnlocked(deps.kernel.db, deps.kernel.clock.now(), deps.principal);
}

function guardedPath(root: VaultRoot, path: string): string {
  const absolute = resolveWritePath(root, path);
  let cursor = root.path;
  for (const segment of path.split("/")) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink() || !isInsideRoot(root.path, realpathSync(cursor)))
        throw new VaultWriteRefused("Palace paths cannot follow links outside their entry folder");
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return absolute;
}

function documentFor(deps: PalaceDeps, id: string): ParsedPalaceEntry | undefined {
  const absolute = guardedPath(rootFor(deps), pathFor(id));
  let bytes: Buffer;
  try {
    if (lstatSync(absolute).size > 2_000_000)
      throw new PalaceUnavailable("Palace entry is too large");
    bytes = readFileSync(absolute);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return parsePalaceEntry(raw, id, hashOf(bytes));
}

export function readPalaceEntry(deps: PalaceDeps, id: string): PalaceEntry | undefined {
  const parsed = documentFor(deps, id);
  return parsed === undefined || (parsed.entry.sensitive && !unlocked(deps))
    ? undefined
    : parsed.entry;
}

export function listPalaceEntries(deps: PalaceDeps, input: PalaceListQuery) {
  const options = PalaceListQuerySchema.parse(input);
  const root = rootFor(deps);
  const directory = guardedPath(root, "palace/entries");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (missing(error)) return { entries: [] };
    throw error;
  }
  const includeSensitive = unlocked(deps);
  const entries: PalaceEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md") || !UuidSchema.safeParse(name.slice(0, -3)).success) continue;
    try {
      const parsed = documentFor(deps, name.slice(0, -3));
      if (parsed !== undefined && (!parsed.entry.sensitive || includeSensitive))
        entries.push(parsed.entry);
    } catch {
      deps.kernel.logger.log("warn", "A palace entry could not be read");
    }
  }
  return pagePalaceEntries(entries, options);
}

function refreshIndex(
  deps: PalaceDeps,
  context: CommandContext,
  receipt: PalaceReceipt,
): PalaceReceipt {
  try {
    const indexed = indexVault(
      deps.kernel,
      context,
      rootFor(deps),
      `palace-index-${deps.kernel.ids.nextId()}`,
    );
    return { ...receipt, indexStatus: indexed.ok ? "current" : "pending" };
  } catch {
    deps.kernel.logger.log("warn", "Palace file saved; Vault indexing remains pending");
    return { ...receipt, indexStatus: "pending" };
  }
}

function mutate(
  deps: PalaceDeps,
  context: CommandContext,
  name: "save" | "archive" | "restore",
  command: SavePalaceCommand | ArchivePalaceCommand,
): Result<PalaceReceipt> {
  const current = documentFor(deps, command.entryId);
  if (
    (current?.entry.sensitive || ("contents" in command && command.contents.sensitive)) &&
    !unlocked(deps)
  )
    return conflict({ kind: "not_found", entity: "palace_entry", id: command.entryId });
  const scope = `palace.${name}`;
  const requestHash = hashOf(JSON.stringify(command));
  const previous = deps.kernel.db
    .prepare(
      `SELECT e.payload_json FROM idempotency_keys k JOIN orchestration_events e ON e.stream_id = k.result_id
     WHERE k.scope = ? AND k.key = ? AND e.type = 'palace.saved.v1' LIMIT 1`,
    )
    .get(scope, command.idempotencyKey) as { payload_json: string } | undefined;
  if (previous !== undefined) {
    const payload = JSON.parse(previous.payload_json) as { requestHash: string; receipt: unknown };
    if (payload.requestHash !== requestHash)
      return conflict({ kind: "idempotent_replay", key: command.idempotencyKey, existingId: "" });
    return ok(refreshIndex(deps, context, PalaceReceiptSchema.parse(payload.receipt)));
  }
  const path = pathFor(command.entryId);
  if (current?.entry.contentHash !== command.expectedHash)
    throw new VaultConflict(path, command.expectedHash, current?.entry.contentHash);
  if (name !== "save" && current === undefined)
    return conflict({ kind: "not_found", entity: "palace_entry", id: command.entryId });
  const now = new Date(deps.kernel.clock.now()).toISOString();
  const contents =
    "contents" in command ? command.contents : { ...current!.entry, archived: name === "archive" };
  const entry: PalaceEntry = {
    ...contents,
    id: command.entryId,
    createdAt: current?.entry.createdAt ?? now,
    updatedAt: now,
    contentHash: current?.entry.contentHash ?? "0".repeat(64),
  };
  const serialized = serializePalaceEntry(entry, current);
  const root = rootFor(deps);
  const receiptId = deps.kernel.ids.nextId();
  // ponytail: no crash journal; add recovery receipts if interrupted saves become a real problem.
  const outcome = runCommand<PalaceReceipt>(
    deps.kernel,
    { scope, key: command.idempotencyKey, resultId: receiptId },
    () => {
      guardedPath(root, path);
      const contentHash = writeNoteAtomically(
        { root, env: deps.env },
        {
          path,
          contents: serialized,
          ...(command.expectedHash === undefined ? {} : { expectedHash: command.expectedHash }),
        },
      );
      const receipt: PalaceReceipt = {
        entryId: entry.id,
        contentHash,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        indexStatus: "pending",
      };
      return ok({
        value: receipt,
        events: [
          {
            id: deps.kernel.ids.nextId(),
            streamType: "vault",
            streamId: receiptId,
            type: "palace.saved.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: { requestHash, receipt },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
  return outcome.ok ? ok(refreshIndex(deps, context, outcome.value)) : outcome;
}

export function savePalaceEntry(
  deps: PalaceDeps,
  context: CommandContext,
  command: SavePalaceCommand,
) {
  return mutate(deps, context, "save", SavePalaceCommandSchema.parse(command));
}
export function archivePalaceEntry(
  deps: PalaceDeps,
  context: CommandContext,
  command: ArchivePalaceCommand,
) {
  return mutate(deps, context, "archive", ArchivePalaceCommandSchema.parse(command));
}
export function restorePalaceEntry(
  deps: PalaceDeps,
  context: CommandContext,
  command: ArchivePalaceCommand,
) {
  return mutate(deps, context, "restore", ArchivePalaceCommandSchema.parse(command));
}
