import type { OrchestrationEvent } from "@noctis/contracts";
import type { Clock, IdFactory } from "@noctis/domain";
import { z } from "zod";

import type { NoctisDatabase } from "../db/connection.js";
import type { Logger } from "../logging.js";

import { pushFor } from "./triggers.js";

/**
 * Web push delivery.
 *
 * Ported from the donor's `server/lib/push.js` (`ee7b4527`, MIT, Copyright (c)
 * 2026 - Now, Son Nguyen). Retained: the endpoint-keyed subscription table, the
 * send-to-all loop, and the rule that a dead-subscription status prunes the row
 * instead of being retried. Changed, and the ledger says why: the VAPID keys
 * come from the environment rather than a JSON file beside the database, there
 * are no push categories, the Electron branch is gone, and sending is injected
 * so no test reaches the network. See `docs/architecture/DONOR-PORT-LEDGER.md`.
 *
 * The VAPID private key is a credential. It is held here, in memory, and is
 * never written to SQLite, never logged, and never named in an error.
 */

/** What the push service needs to encrypt to one browser. None of it is a Noctis secret. */
export type StoredSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

/**
 * Injected so the tests never touch the network, and so `web-push` is imported
 * in exactly one place (`server.ts`).
 *
 * The contract is a resolved status code, not a thrown error: a transport
 * failure with no status is a rejection, and the notifier keeps the row.
 */
export type SendPush = (
  subscription: StoredSubscription,
  payload: string,
) => Promise<{ statusCode: number }>;

export interface VapidKeys {
  publicKey: string;
  /** Never persisted, never logged. */
  privateKey: string;
  subject: string;
}

export interface NotifierDeps {
  db: NoctisDatabase;
  clock: Clock;
  ids: IdFactory;
  /** Absent when the core is configured without push, which is the default. */
  vapid: VapidKeys | undefined;
  send: SendPush;
  logger: Logger;
}

/**
 * Base64url, padded or not: `PushSubscription.toJSON()` is unpadded in every
 * browser that ships it, but the padded form decodes to the same bytes and
 * refusing it would be a rule about spelling rather than about keys.
 */
const BASE64URL = /^[A-Za-z0-9_-]+=*$/;

/** True when `value` is base64url that decodes to exactly `bytes` bytes. */
function decodesTo(value: string, bytes: number): boolean {
  // The charset first: `Buffer.from(…, "base64url")` silently drops what it
  // cannot read, so garbage with a few valid characters decodes to whatever
  // length it likes.
  return BASE64URL.test(value) && Buffer.from(value, "base64url").length === bytes;
}

/**
 * The body a browser POSTs to `/push/subscribe`, exactly as
 * `PushSubscription.toJSON()` writes it.
 *
 * The key material is checked for shape, not merely for presence. A row with
 * unusable keys is a row nothing can ever prune: `web-push` refuses it before
 * it reaches the network, so it rejects with no `statusCode`, the sender
 * rethrows, `notify` logs a warning and keeps the row — forever, once per
 * event. The lengths are the P-256 point (65 bytes) and the auth secret (16),
 * both fixed by RFC 8291.
 */
export const PushSubscriptionSchema = z
  .object({
    // `https:` specifically: a push service is a public HTTPS endpoint, and an
    // `http:` or `file:` endpoint is something that was never going to deliver.
    endpoint: z.url({ protocol: /^https$/ }),
    /**
     * Declared because the browser sends it, not because anything reads it.
     *
     * `PushSubscription.toJSON()` returns `{endpoint, expirationTime, keys}` —
     * `expirationTime` is in the Push API's `PushSubscriptionJSON` dictionary,
     * and every browser includes it, usually as `null`. This object is
     * `.strict()`, so leaving it undeclared rejected every real subscription
     * with a 400 while every test passed: the fixtures were written by hand
     * from the two fields the core uses, and no fixture is a browser.
     *
     * ponytail: the next field the spec adds breaks subscription again, the
     * same way and just as invisibly. The upgrade path is to stop treating a
     * browser-authored dictionary as a closed set — read the two fields and
     * ignore the rest — which is a deliberate exception to the project's
     * `.strict()` rule and wants its own decision rather than being smuggled
     * in here.
     */
    expirationTime: z.number().nullable().optional(),
    keys: z
      .object({
        p256dh: z.string().refine((value) => decodesTo(value, 65), "not a P-256 public key"),
        auth: z.string().refine((value) => decodesTo(value, 16), "not a 16-byte auth secret"),
      })
      .strict(),
  })
  .strict();

export type PushSubscriptionBody = z.infer<typeof PushSubscriptionSchema>;

export interface Notifier {
  subscribe(sessionId: string, subscription: PushSubscriptionBody): void;
  unsubscribe(endpoint: string): void;
  /** The public key a browser needs to subscribe, or `undefined` when push is off. */
  publicKey(): string | undefined;
  notify(events: readonly OrchestrationEvent[]): Promise<void>;
}

/**
 * The two statuses that mean the browser is gone and will not be back. Anything
 * else — a 500, a 429, a timeout — is the push service having a bad day, and
 * deleting the row there would lose a working phone.
 */
const GONE = new Set([404, 410]);

export function createNotifier(deps: NotifierDeps): Notifier {
  function subscriptions(): StoredSubscription[] {
    return deps.db
      .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions")
      .all() as StoredSubscription[];
  }

  function forget(endpoint: string): void {
    deps.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  return {
    /**
     * ponytail: a direct INSERT, no command, no event, no idempotency claim —
     * the same ceiling as `api/session.ts`, and for the same reason. A
     * subscription is transport state: it belongs to one session row, dies with
     * it through `ON DELETE CASCADE`, and replaying the POST must move the
     * endpoint to the session that presented it rather than return the earlier
     * row. Upgrade path: if the set of devices ever needs an audit trail, emit
     * a `push.subscribed.v1` carrying the session id and never the endpoint.
     */
    subscribe(sessionId, subscription) {
      deps.db
        .prepare(
          `INSERT INTO push_subscriptions (id, session_id, endpoint, p256dh, auth, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (endpoint) DO UPDATE SET
             session_id = excluded.session_id,
             p256dh     = excluded.p256dh,
             auth       = excluded.auth`,
        )
        .run(
          deps.ids.nextId(),
          sessionId,
          subscription.endpoint,
          subscription.keys.p256dh,
          subscription.keys.auth,
          new Date(deps.clock.now()).toISOString(),
        );
    },

    unsubscribe: forget,

    publicKey() {
      return deps.vapid?.publicKey;
    },

    async notify(events) {
      // No keys, nothing to sign with: a core configured without push is
      // quietly without push rather than broken. Checked before the payloads
      // are built so nothing is computed for a delivery that cannot happen.
      if (deps.vapid === undefined) {
        return;
      }

      const payloads = events.map(pushFor).filter((one) => one !== undefined);

      if (payloads.length === 0) {
        return;
      }

      // Read once, not per payload: two pushes in the same committed batch go
      // to the same set of phones.
      const targets = subscriptions();

      for (const payload of payloads) {
        const body = JSON.stringify(payload);
        const results = await Promise.allSettled(
          targets.map(async (target) => deps.send(target, body)),
        );

        results.forEach((result, index) => {
          const target = targets[index];

          if (target === undefined) {
            return;
          }

          if (result.status === "rejected") {
            // A transport failure carries no status, so it says nothing about
            // whether the browser still exists. Logged and left alone.
            deps.logger.log("warn", "push delivery failed", {
              reason: result.reason instanceof Error ? result.reason.message : "unknown",
            });
            return;
          }

          if (GONE.has(result.value.statusCode)) {
            forget(target.endpoint);
          }
        });
      }
    },
  };
}
