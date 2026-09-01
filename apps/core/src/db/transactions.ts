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
      db.exec("ROLLBACK");
      return outcome;
    }

    const committedEvents = outcome.value.events.map((draft) => appendEvent(db, draft));

    db.exec("COMMIT");

    return ok({ value: outcome.value.value, committedEvents });
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
