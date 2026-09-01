import type { Result } from "../result.js";
import { conflict, ok } from "../result.js";

/**
 * Turns an allowed-transition table into a pure function returning Result.
 * A state missing from the table, or a target it does not list, is a refusal.
 */
export function defineTransition<TState extends string>(
  machine: string,
  table: Readonly<Record<TState, readonly TState[]>>,
): (from: TState, to: TState) => Result<TState> {
  return (from, to) => {
    const allowed = table[from];

    if (allowed === undefined || !allowed.includes(to)) {
      return conflict<TState>({ kind: "forbidden_transition", machine, from, to });
    }

    return ok(to);
  };
}
