/** An expected refusal. Never an exception: a refusal must produce no event. */
export type DomainConflict =
  | { kind: "forbidden_transition"; machine: string; from: string; to: string }
  | { kind: "revision_conflict"; expected: number; actual: number }
  | { kind: "idempotent_replay"; key: string; existingId: string }
  | { kind: "not_found"; entity: string; id: string };

export type Result<T> = { ok: true; value: T } | { ok: false; conflict: DomainConflict };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function conflict<T>(domainConflict: DomainConflict): Result<T> {
  return { ok: false, conflict: domainConflict };
}
