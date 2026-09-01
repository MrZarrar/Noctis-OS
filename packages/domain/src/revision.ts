import type { Result } from "./result.js";
import { conflict, ok } from "./result.js";

/**
 * Optimistic concurrency. Returns the revision the caller should persist,
 * or a conflict when the stored record has moved on.
 */
export function checkRevision(expected: number, actual: number): Result<number> {
  if (expected !== actual) {
    return conflict<number>({ kind: "revision_conflict", expected, actual });
  }

  return ok(actual + 1);
}
