import type { OrchestrationEvent } from "@noctis/contracts";

/**
 * Which committed events are worth waking a phone for, and what the phone is
 * told. Pure: no database, no clock, no send — so the whole rule is one table
 * of examples in `triggers.test.ts`.
 *
 * Two events, and deliberately only two. Decision 0.25 names a third — Sense's
 * suggestions — and it has no producer until Slice 4.
 *
 * ponytail: two events, hard-coded, switched on inline. A category table with
 * one live member is configuration for a value that never changes; add one when
 * Sense (Slice 4) supplies the second producer and a reason to mute one without
 * the other.
 */
export interface PushPayload {
  title: string;
  body: string;
  /**
   * Where tapping the notification lands.
   *
   * ponytail: always `/`, because `apps/web` has no client-side routing — the
   * active destination is React state (`App.tsx`), and no URL but `/` is ever
   * used. `/approvals` would be worse than useless: `static.ts` claims that
   * first segment for the API, so the tap would open a JSON body rather than
   * the app. Upgrade path: when the web app grows a router, and the API is
   * prefixed so the two namespaces stop overlapping (the collision `static.ts`
   * already records), return the deep link here — the service worker already
   * navigates to whatever this says.
   */
  url: string;
  /**
   * The stream the event belongs to. For a turn that is the thread, so a second
   * failure in the same conversation replaces the first notification rather
   * than stacking. For an authority decision it is a fresh per-request id, so
   * two waiting approvals never collapse into one — they are two different
   * decisions to make.
   */
  tag: string;
}

/** A lock screen is not a log line. Long enough to be useful, short enough to read. */
const MAX_BODY = 140;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * ponytail: the payloads are read field by field, not parsed through a schema,
 * which is a deliberate exception to "every Zod object schema ends in
 * `.strict()`".
 *
 * The ceiling: nothing here proves a payload's shape, so a field that changes
 * type produces wrong wording on a lock screen rather than a failed parse.
 *
 * Why the exception, and it is narrow. This is not a trust boundary — the
 * broker is an in-process `Set` fed by this same process two stack frames
 * earlier, not a socket — and a `.strict()` parse would turn the rule's own
 * failure mode into the thing the rule exists to prevent.
 * `authority.decision_recorded.v1` already spreads four optional fields
 * conditionally (`objectiveId`, `missionId`, `nodeJobId`, `askId`), and the
 * first emitter to add a fifth would silence the phone with no error, no log
 * line, and no failing test — a strict parse of a payload you do not own fails
 * closed, and "closed" here means nobody is told their approval is waiting.
 *
 * Upgrade path: a deliberately loose schema declaring only the five fields
 * actually read (`outcome`, `capability`, `target`, `status`, `failureReason`)
 * and passing everything else through — which is exactly what the project's
 * blanket `.strict()` rule currently forbids. Recording the tension rather
 * than pretending it is absent: the day that rule grows an exception for
 * payloads a module consumes but does not define, this is its first customer.
 */
export function pushFor(event: OrchestrationEvent): PushPayload | undefined {
  const payload = record(event.payload);

  if (payload === undefined) {
    return undefined;
  }

  switch (event.type) {
    case "authority.decision_recorded.v1": {
      // `AuthorityOutcomeSchema` is allow | deny | require_confirmation |
      // require_typed_confirmation. The first two are already decided; a push
      // for a decision nobody has to make is the fastest way to get every
      // Noctis notification muted.
      if (
        payload.outcome !== "require_confirmation" &&
        payload.outcome !== "require_typed_confirmation"
      ) {
        return undefined;
      }

      const target = record(payload.target);
      const capability = text(payload.capability) ?? "an action";
      const named =
        target === undefined
          ? capability
          : `${capability} on ${text(target.type) ?? "target"} ${text(target.id) ?? "?"}`;

      // The capability and the target, not just "approval waiting". A
      // notification that forces an unlock and a navigation to learn whether it
      // matters is a notification that gets turned off.
      return {
        title: "Approval needed",
        body: clip(named, MAX_BODY),
        url: "/",
        tag: event.streamId,
      };
    }

    case "identity.turn_completed.v1": {
      // `TurnStatus` is queued | running | completed | failed | cancelled —
      // there is no `blocked`. A turn the runtime refused arrives here as
      // `failed` with `failureReason: "runtime_declined"`, so the blocked shape
      // is this case. `completed` is the ordinary success nobody wants buzzed
      // about, and `cancelled` was the owner's own doing.
      if (payload.status !== "failed") {
        return undefined;
      }

      return {
        title: "Turn failed",
        body: clip(text(payload.failureReason) ?? "no reason recorded", MAX_BODY),
        url: "/",
        tag: event.streamId,
      };
    }

    default:
      return undefined;
  }
}
