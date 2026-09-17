import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, posix, sep } from "node:path";

import type { VaultRoot } from "./root.js";
import { isInsideRoot } from "./root.js";

export class VaultWriteRefused extends Error {}

/**
 * Section 7: "Add atomic write/conflict primitives but keep automated writes
 * disabled" and "no automatic bulk rewrite of user notes".
 *
 * The switch is off by default and stays that way. `NOCTIS_VAULT_ALLOW_WRITES`
 * is separate from `NOCTIS_VAULT_ALLOW_LIVE` on purpose — reading a real Vault
 * and writing to one are different consequences, and neither implies the other,
 * which is why Slice 2 turns live *reading* on without touching this.
 *
 * Even when it is on, nothing here rewrites a note the owner wrote: the
 * conflict check below refuses a file that changed since it was read, and the
 * only caller that appends is `vault/brain.ts`, under the Agent Brain's rules.
 */
const ACTIVATION = "true";

export interface VaultWriteContext {
  root: VaultRoot;
  env: Readonly<Record<string, string | undefined>>;
}

export function writesEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.NOCTIS_VAULT_ALLOW_WRITES === ACTIVATION;
}

/**
 * Turns a Vault-relative path into an absolute one, or refuses.
 *
 * `..` is rejected before resolution rather than after, so a traversal never
 * gets far enough to touch the filesystem, and the resolved result is checked
 * against the root regardless.
 */
export function resolveWritePath(root: VaultRoot, vaultPath: string): string {
  const trimmed = vaultPath.trim();

  if (trimmed === "" || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    throw new VaultWriteRefused(`A Vault path must be relative: ${vaultPath}`);
  }

  if (/(^|[\\/])\.\.([\\/]|$)/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    throw new VaultWriteRefused(`A Vault path may not escape the root: ${vaultPath}`);
  }

  const absolute = normalize(join(root.path, trimmed.split(posix.sep).join(sep)));

  if (!isInsideRoot(root.path, absolute)) {
    throw new VaultWriteRefused(`A Vault path may not escape the root: ${vaultPath}`);
  }

  return absolute;
}

export function hashOf(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export interface AtomicWrite {
  path: string;
  contents: string;
  /**
   * The hash the file is expected to have right now. Absent means the file must
   * not exist. Either way the check is against the disk, not against the index.
   */
  expectedHash?: string;
}

export class VaultConflict extends Error {
  constructor(
    readonly path: string,
    readonly expected: string | undefined,
    readonly actual: string | undefined,
  ) {
    super(`${path} changed since it was read`);
  }
}

/**
 * Writes a note atomically, or not at all.
 *
 * Temp file in the same directory, fsync, then rename: a rename within one
 * filesystem is atomic, so a reader sees either the old note or the new one and
 * never a half-written file. The conflict check reads the file immediately
 * before the rename, which is what makes "no automatic bulk rewrite of user
 * notes" enforceable — a note edited in Obsidian since the caller read it
 * refuses the write instead of overwriting the human's version.
 */
export function writeNoteAtomically(context: VaultWriteContext, write: AtomicWrite): string {
  if (!writesEnabled(context.env)) {
    throw new VaultWriteRefused(
      "Vault writes are disabled. Automated writes stay off by default; NOCTIS_VAULT_ALLOW_WRITES=true opens exactly two things and nothing else — the inbox grant a runtime writes through, and the Agent Brain append in vault/brain.ts.",
    );
  }

  const absolute = resolveWritePath(context.root, write.path);

  let actual: string | undefined;

  try {
    actual = hashOf(readFileSync(absolute));
  } catch {
    actual = undefined;
  }

  if (actual !== write.expectedHash) {
    throw new VaultConflict(write.path, write.expectedHash, actual);
  }

  mkdirSync(dirname(absolute), { recursive: true });

  const temporary = `${absolute}.noctis-${String(process.pid)}-${String(Date.now())}.tmp`;

  try {
    // Written through the same descriptor that is then flushed. Without the
    // fsync the rename can land before the bytes do, which turns a crash into
    // an atomically-renamed empty file — and fsync on a read-only handle is
    // EPERM on Windows, so the handle has to be the writing one.
    const handle = openSync(temporary, "w");

    try {
      writeFileSync(handle, write.contents, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }

    renameSync(temporary, absolute);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temp file never existed, or is already gone.
    }

    throw error;
  }

  return hashOf(write.contents);
}
