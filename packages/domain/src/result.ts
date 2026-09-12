/** An expected refusal. Never an exception: a refusal must produce no event. */
export type DomainConflict =
  | { kind: "forbidden_transition"; machine: string; from: string; to: string }
  | { kind: "revision_conflict"; expected: number; actual: number }
  | { kind: "idempotent_replay"; key: string; existingId: string }
  | { kind: "not_found"; entity: string; id: string }
  /**
   * Authority said no, or said "not like that".
   *
   * Its own kind rather than a `forbidden_transition`: a state machine refusal
   * is about what the record is, and this is about what the actor may do to it.
   * Conflating them would make one HTTP status stand for both, and a client
   * cannot retry the same way after each.
   */
  | {
      kind: "authority_refused";
      requestId: string;
      outcome: string;
      reasonCodes: readonly string[];
    }
  /**
   * A dependency is missing right now — no model, no node — and the caller may
   * retry later. Not a refusal of the act itself, so never a 4xx.
   */
  | { kind: "unavailable"; entity: string; reason: string };

export type Result<T> = { ok: true; value: T } | { ok: false; conflict: DomainConflict };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function conflict<T>(domainConflict: DomainConflict): Result<T> {
  return { ok: false, conflict: domainConflict };
}
