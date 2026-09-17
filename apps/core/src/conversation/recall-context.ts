import type { VaultRecallEvidence } from "@noctis/contracts";

import type { NoctisDatabase } from "../db/connection.js";
import { recallFor } from "../vault/recall.js";
import type { VaultRoot } from "../vault/root.js";

/**
 * What the Vault already knows, put in front of the turn that is about to run
 * (task 2.5).
 *
 * Section 7's rule is that recall is focused and carries its provenance: every
 * line names the note it came from and how fresh that note is, so a model
 * repeating something from the Vault can be checked, and the owner can see
 * which file an answer rests on. Nothing is summarised and nothing is inferred
 * — the quotes are the indexed spans, verbatim.
 */

/** How many quotes a prompt may carry. A prompt is not a context dump. */
const MAX_LINES = 6;

/** A quote long enough to be evidence and short enough not to become the prompt. */
const MAX_QUOTE = 240;

const PREAMBLE =
  "From the owner's Vault, which may be out of date — each line names its note and how fresh it is:";

/** Freshness a line is not worth carrying: nobody looked, or the note is gone. */
const CARRIED: ReadonlySet<string> = new Set(["current", "stale"]);

export interface RecallContextDeps {
  vaultRoot?: VaultRoot;
}

/**
 * Runs one recall for the prompt, or returns nothing.
 *
 * Failing quiet is deliberate and mirrors the Surface path: no Vault, or a
 * Vault with nothing to say about this prompt, should leave the turn exactly as
 * it was rather than adding a paragraph explaining its own absence — which the
 * model would then have to reason about.
 *
 * This is a read, so it runs inside the send transaction. Nothing is recorded:
 * `vault_recalls` is the audit table for a recall the owner asked for, and one
 * of these happens on every single turn.
 *
 * ponytail: the whole prompt is the query, matched with `recallFor`'s `LIKE`
 * over entity names and keys. A long prompt therefore matches nothing, because
 * no entity key contains a paragraph. The ceiling is real and the upgrade path
 * is term extraction (or FTS5, which `recall.ts` already names) — deliberately
 * not guessed at here, because which terms matter is the kind of thing the
 * live evidence should decide rather than this function.
 */
export function recallForPrompt(
  db: NoctisDatabase,
  prompt: string,
  deps: RecallContextDeps,
): VaultRecallEvidence[] {
  if (deps.vaultRoot === undefined) {
    return [];
  }

  const found = recallFor(db, prompt, { root: deps.vaultRoot });

  return found.evidence.filter((item) => CARRIED.has(item.freshness)).slice(0, MAX_LINES);
}

function clip(text: string, max: number): string {
  const single = text.replaceAll(/\s+/g, " ").trim();

  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

export function promptWithRecall(prompt: string, evidence: readonly VaultRecallEvidence[]): string {
  if (evidence.length === 0) {
    return prompt;
  }

  const lines = evidence
    .map((item) => `- ${item.path} (${item.freshness}): ${clip(item.quote, MAX_QUOTE)}`)
    .join("\n");

  // Before the prompt, not after: what the owner typed is the last thing the
  // model reads, so context never displaces the instruction.
  return `${PREAMBLE}\n${lines}\n\n${prompt}`;
}
