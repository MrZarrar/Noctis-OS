import type { OrchestrationEvent } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { ok } from "@noctis/domain";

import type { NoctisDatabase } from "./connection.js";
import { appendEvent, type EventDraft } from "./events.js";

export interface Mutation<T> {
  value: T;
  events: readonly EventDraft[];
}

export interface CommittedOutcome<T> {
  value: T;
  /** Publish these only after this call returns. Delivery is at-least-once. */
  committedEvents: readonly OrchestrationEvent[];
}

const MUTATE_CLOSED_TRANSACTION = "mutate closed the transaction it was given";

/**
 * Commits relational state and its audit events in one transaction.
 *
 * A refusal returned by `mutate` rolls back and appends nothing, so the
 * event-append path is unreachable unless the mutation succeeded.
 */
export function commitStateAndEvent<T>(
  db: NoctisDatabase,
  mutate: (tx: NoctisDatabase) => Result<Mutation<T>>,
): Result<CommittedOutcome<T>> {
  db.exec("BEGIN IMMEDIATE");

  try {
    const outcome = mutate(db);

    if (!outcome.ok) {
      // A refusal after mutate already committed (e.g. it called db.exec("COMMIT")
      // itself) cannot be undone by rolling back — there is nothing left to roll
      // back, and the state it wrote is permanent. Returning the refusal here
      // would lie to the caller by implying the write never happened, so the only
      // honest outcome is a loud error naming the real problem.
      if (!db.isTransaction) {
        throw new Error(MUTATE_CLOSED_TRANSACTION);
      }
      db.exec("ROLLBACK");
      return outcome;
    }

    const committedEvents = outcome.value.events.map((draft) => appendEvent(db, draft));

    if (!db.isTransaction) {
      throw new Error(MUTATE_CLOSED_TRANSACTION);
    }

    db.exec("COMMIT");

    return ok({ value: outcome.value.value, committedEvents });
  } catch (error) {
    // SQLite already auto-rolls-back on some errors (e.g. SQLITE_FULL), which
    // leaves no transaction open. Swallow only that rollback failure so the
    // original error still reaches the caller instead of being replaced by it.
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
}
