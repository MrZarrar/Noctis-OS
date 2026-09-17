import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class VaultRootRefused extends Error {}

export interface VaultRoot {
  /** Absolute, symlink-resolved. Every file read is checked to be inside it. */
  path: string;
  /**
   * True only when a live personal Vault was unlocked deliberately.
   *
   * Slice 2 (task 2.5) is what makes this a supported configuration rather than
   * a thing to refuse: the work PC points `NOCTIS_VAULT_ROOT` at its real
   * OneDrive MindVault so recall has something to recall. It stays read-only —
   * `NOCTIS_VAULT_ALLOW_WRITES` is a separate switch, and the only file it
   * opens for a runtime is the Agent Brain (`vault/brain.ts`).
   */
  live: boolean;
}

/** The one value that unlocks a live Vault. Compared exactly — see the tests. */
const ACTIVATION = "true";

const ACTIVATION_NOTE =
  "Indexing a live OneDrive/Obsidian Vault is supported from Slice 2 (task 2.5) and is read-only: the Vault service refuses every write unless NOCTIS_VAULT_ALLOW_WRITES is also set, and the only file that switch opens to a runtime is agent/brain.md.";

/**
 * Whether a path looks like somebody's real, synced notes rather than a fixture.
 *
 * Two independent signals, because either alone misses a real case: a synced
 * folder name catches a Vault that has not been opened in Obsidian yet, and a
 * `.obsidian` directory (checked by the caller, which can touch the disk)
 * catches one that lives somewhere unexpected. Matching is on whole path
 * segments, so `onedriveish` is not `OneDrive`.
 */
export function isLiveVaultPath(candidate: string): boolean {
  const segments = candidate.split(/[\\/]+/).filter((segment) => segment !== "");

  const synced = segments.some(
    (segment) => segment === "OneDrive" || segment.startsWith("OneDrive - "),
  );
  const named = segments.some((segment) => segment.toLowerCase() === "mindvault");

  return synced || named;
}

function isObsidianVault(directory: string): boolean {
  return existsSync(join(directory, ".obsidian"));
}

/**
 * Resolves the configured Vault root, or refuses.
 *
 * Absent configuration means the Vault is off, which is the default: Phase 7
 * adds the capability, it does not turn it on. A root that resolves to real
 * personal notes is refused outright unless `NOCTIS_VAULT_ALLOW_LIVE=true`,
 * so pointing the core at the canonical Vault by accident — a stale env var, a
 * copied command line — cannot happen quietly.
 */
export function resolveVaultRoot(
  env: Readonly<Record<string, string | undefined>>,
): VaultRoot | undefined {
  const configured = env.NOCTIS_VAULT_ROOT?.trim();

  if (configured === undefined || configured === "") {
    return undefined;
  }

  if (!existsSync(configured)) {
    throw new VaultRootRefused(`NOCTIS_VAULT_ROOT does not exist: ${configured}`);
  }

  // Resolved before every check: a symlink or junction pointing at the real
  // Vault must be judged by where it lands, not by what it is called.
  const path = realpathSync(resolve(configured));

  if (!statSync(path).isDirectory()) {
    throw new VaultRootRefused(`NOCTIS_VAULT_ROOT is not a directory: ${path}`);
  }

  const live = isLiveVaultPath(path) || isObsidianVault(path);
  const allowed = env.NOCTIS_VAULT_ALLOW_LIVE === ACTIVATION;

  if (live && !allowed) {
    throw new VaultRootRefused(
      `Refusing to index what looks like a live Vault at ${path}. ${ACTIVATION_NOTE} Set NOCTIS_VAULT_ALLOW_LIVE=true when that is what you meant.`,
    );
  }

  return { path, live };
}

/**
 * Whether a resolved file path is inside the root.
 *
 * Called after `realpathSync` on the file, which is the point: a symlink inside
 * the Vault that points at `C:\Users\...\OneDrive` resolves to a path outside
 * the root and is refused, so indexing cannot be walked out of its own tree.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);

  return (
    offset !== "" && !offset.startsWith("..") && !isAbsolute(offset) && !offset.includes(`..${sep}`)
  );
}
