import { readFileSync } from "node:fs";

import { normalizeKey } from "@noctis/domain";

import type { VaultRoot } from "./root.js";
import { hashOf, resolveWritePath, writeNoteAtomically, writesEnabled } from "./writes.js";

/**
 * The Agent Brain: `agent/brain.md`, the one file in the Vault a runtime may
 * add a line to (task 2.5).
 *
 * The rules are the file's own, and they are what makes appending to it safe.
 * A brain that grows without bound is a brain nobody reads, and a brain with
 * the same lesson recorded five ways is worse than one that never learned it —
 * so a bullet is refused when the file is at its cap, and refused when
 * something close enough to it is already there.
 *
 * Every other Vault write stays off. `NOCTIS_VAULT_ALLOW_WRITES` is the switch,
 * and it is the same one `writeNoteAtomically` checks: this module adds the
 * rules, not an exemption.
 */

export const BRAIN_PATH = "agent/brain.md";

/**
 * 150 lines, from the plan (task 2.5).
 *
 * Counted over the whole file rather than over its bullets, because the cap
 * exists to keep the file readable in one sitting and a heading costs a reader
 * the same as a bullet does.
 */
export const BRAIN_MAX_LINES = 150;

export type BrainRefusal =
  "writes_disabled" | "no_vault" | "brain_missing" | "brain_full" | "already_known";

export type BrainOutcome = { ok: true; bullet: string } | { ok: false; refusal: BrainRefusal };

/**
 * Whether the brain already says this.
 *
 * Compared on `normalizeKey`, the same vocabulary recall matches on, so case
 * and whitespace do not make one lesson into two.
 *
 * ponytail: substring containment over normalized text, which catches a
 * verbatim repeat and nothing cleverer — a rephrasing, or the same sentence
 * with a full stop added, gets through. That is the right size of check for a
 * file with a hard line cap: the cap is what actually bounds the damage. The
 * upgrade path, if the brain ever fills with near-duplicates, is to ask the
 * local model whether a bullet is already covered, which is a Slice 4
 * capability rather than this one.
 */
export function alreadyKnown(existing: string, bullet: string): boolean {
  const known = normalizeKey(existing);
  const candidate = normalizeKey(bullet);

  return candidate !== "" && known.includes(candidate);
}

export interface BrainContext {
  root: VaultRoot | undefined;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Appends one bullet to the Agent Brain, or says why it did not.
 *
 * The read-then-write is guarded by the hash the read produced, so a brain
 * edited in Obsidian between the two refuses rather than overwriting the
 * human's version — the same conflict rule every other Vault write obeys.
 *
 * The file must already exist. Creating it would mean a runtime could bring a
 * Vault structure into being that the owner never made, and "no brain here" is
 * a fact worth reporting rather than fixing.
 */
export function rememberPreference(context: BrainContext, bullet: string): BrainOutcome {
  if (context.root === undefined) {
    return { ok: false, refusal: "no_vault" };
  }

  if (!writesEnabled(context.env)) {
    return { ok: false, refusal: "writes_disabled" };
  }

  const absolute = resolveWritePath(context.root, BRAIN_PATH);
  let existing: string;

  try {
    existing = readFileSync(absolute, "utf8");
  } catch {
    return { ok: false, refusal: "brain_missing" };
  }

  if (alreadyKnown(existing, bullet)) {
    return { ok: false, refusal: "already_known" };
  }

  // Counted before the append, so a file already at the cap refuses rather than
  // going one over. The last line of a file that ends in a newline is empty and
  // is not a line anybody reads.
  const lines = existing.split("\n");

  if ((lines.at(-1) === "" ? lines.length - 1 : lines.length) >= BRAIN_MAX_LINES) {
    return { ok: false, refusal: "brain_full" };
  }

  const line = `- ${bullet.trim()}`;
  const separator = existing.endsWith("\n") || existing === "" ? "" : "\n";

  writeNoteAtomically(
    { root: context.root, env: context.env },
    {
      path: BRAIN_PATH,
      contents: `${existing}${separator}${line}\n`,
      expectedHash: hashOf(existing),
    },
  );

  return { ok: true, bullet: line };
}
