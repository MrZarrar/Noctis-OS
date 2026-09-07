import type { AuthorityTarget, OperationClass } from "@noctis/contracts";

/**
 * The typed confirmation rule (Section 9.1).
 *
 * Four operation classes are not confirmable with a click:
 *
 * | Operation             | What the plan requires                       |
 * | --------------------- | -------------------------------------------- |
 * | spend                 | typed confirmation with amount/provider      |
 * | destructive           | typed confirmation naming exact target       |
 * | production_deploy     | typed confirmation plus release gate         |
 * | credential_security   | typed confirmation; never delegated to model |
 *
 * The phrase is derived from the request, so it cannot be made easy to type by
 * accident: it names the thing that is about to happen, and typing it is a
 * second, deliberate reading of the target. Deterministic, so the phrase the
 * core stores at decision time and the phrase it checks at confirmation time
 * are the same string without either being trusted from a client.
 */

export interface ConfirmationSubject {
  operationClass: OperationClass;
  target: AuthorityTarget;
  estimatedCostGbp?: number;
}

/**
 * Only these four ever demand one. Kept as its own set rather than inferred
 * from the outcome table so that relaxing an outcome cannot quietly drop the
 * typing requirement with it.
 */
const TYPED: ReadonlySet<OperationClass> = new Set<OperationClass>([
  "spend",
  "destructive",
  "production_deploy",
  "credential_security",
]);

export function requiresTypedConfirmation(operationClass: OperationClass): boolean {
  return TYPED.has(operationClass);
}

/**
 * Pence, so a confirmation phrase never depends on float formatting.
 *
 * Two deliberate choices. The amount is normalised to millionths first, because
 * `1.005 * 100` is `100.49999999999999` in IEEE-754 and rounding that gives
 * `1.00` — a phrase understating the spend by a penny, which is a small error
 * of exactly the kind a typed confirmation exists to prevent. Then it rounds
 * **up**: a confirmation may state more than will be spent, never less.
 *
 * ponytail: the real fix is integer pence in the contract. This is the boundary
 * that made a float load-bearing, and it is the one that has to be right first.
 */
function formatGbp(amount: number): string {
  const pence = Math.ceil(Math.round(amount * 1e6) / 1e4);

  return `${String(Math.floor(pence / 100))}.${String(pence % 100).padStart(2, "0")}`;
}

/**
 * The exact phrase a human must type. `undefined` for every class that does not
 * demand one — a phrase for an operation that never asks for it would be a
 * ritual, and rituals get pasted.
 */
export function confirmationPhraseFor(subject: ConfirmationSubject): string | undefined {
  if (!TYPED.has(subject.operationClass)) {
    return undefined;
  }

  const target = `${subject.target.type}:${subject.target.id}`;

  switch (subject.operationClass) {
    case "spend":
      // The amount is part of the phrase because Section 9.1 asks for the
      // amount to be confirmed, not merely displayed next to a button.
      return `SPEND GBP ${formatGbp(subject.estimatedCostGbp ?? 0)} ON ${target}`;
    case "destructive":
      return `DESTROY ${target}`;
    case "production_deploy":
      return `DEPLOY ${target} TO PRODUCTION`;
    default:
      return `CHANGE CREDENTIALS FOR ${target}`;
  }
}

/**
 * Exact match after trimming the outer whitespace a paste or an input adds.
 *
 * Case-sensitive on purpose. The friction is the feature: a phrase that matches
 * case-insensitively is a phrase that can be typed without reading it, and the
 * whole point of typing it is to have read it.
 */
export function confirmationMatches(expected: string, typed: string | undefined): boolean {
  return typed !== undefined && typed.trim() === expected.trim();
}
