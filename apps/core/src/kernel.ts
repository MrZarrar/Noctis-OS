import type { ActorType } from "@noctis/contracts";
import type { Clock, IdFactory, Result } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";

import type { NoctisDatabase } from "./db/connection.js";
import { claimIdempotencyKey } from "./db/idempotency.js";
import type { Mutation } from "./db/transactions.js";
import { commitStateAndEvent } from "./db/transactions.js";
import type { EventBroker } from "./events/broker.js";
import type { Logger } from "./logging.js";

export interface Kernel {
  db: NoctisDatabase;
  clock: Clock;
  ids: IdFactory;
  broker: EventBroker;
  logger: Logger;
}

/** Who is acting and under which correlation. Carried onto every event a command emits. */
export interface CommandContext {
  correlationId: string;
  actorType: ActorType;
  actorId: string;
}

export interface CommandClaim {
  /** Namespaces the key so unrelated commands cannot collide on the same string. */
  scope: string;
  key: string;
  /** The id the caller will return for this command, recorded so a replay can name it. */
  resultId: string;
}

/**
 * The only way a command mutates state.
 *
 * The idempotency claim happens inside the same transaction as the write, so a
 * service physically cannot commit without claiming first — the guard is the
 * call signature, not a convention. A replayed key short-circuits before
 * `mutate` runs, which is what makes an HTTP retry safe rather than merely
 * unlikely to duplicate.
 */
export function runCommand<T>(
  kernel: Kernel,
  claim: CommandClaim,
  mutate: (tx: NoctisDatabase) => Result<Mutation<T>>,
): Result<T> {
  const outcome = commitStateAndEvent<T>(kernel.db, (tx) => {
    const claimed = claimIdempotencyKey(tx, { ...claim, clock: kernel.clock });

    if (!claimed.ok) {
      return conflict<Mutation<T>>(claimed.conflict);
    }

    return mutate(tx);
  });

  if (!outcome.ok) {
    return outcome;
  }

  // After the commit returns, never before: an event delivered from inside the
  // transaction could describe state that a later rollback erased.
  kernel.broker.publish(outcome.value.committedEvents);

  return ok(outcome.value.value);
}
