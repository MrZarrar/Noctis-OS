import type { OrchestrationEvent } from "@noctis/contracts";
import { createIdFactory, fixedClock } from "@noctis/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { createSession } from "../api/session.js";
import type { NoctisDatabase } from "../db/connection.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createLogger } from "../logging.js";
import { MIGRATIONS_DIRECTORY } from "../server.js";

import type { SendPush, StoredSubscription } from "./push.js";
import { PushSubscriptionSchema, createNotifier } from "./push.js";

const VAPID = { publicKey: "public-key", privateKey: "private-key", subject: "mailto:a@b.c" };

const clock = fixedClock(1_700_000_000_000);

function failedTurn(): OrchestrationEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    streamType: "identity",
    streamId: "00000000-0000-4000-8000-0000000000aa",
    type: "identity.turn_completed.v1",
    actorType: "user",
    actorId: "local",
    payloadVersion: 1,
    payload: { status: "failed", failureReason: "runtime_failed" },
    correlationId: "00000000-0000-4000-8000-0000000000bb",
    occurredAt: "2026-09-16T00:00:00.000Z",
  };
}

function completedTurn(): OrchestrationEvent {
  return { ...failedTurn(), payload: { status: "completed" } };
}

interface Sent {
  subscription: StoredSubscription;
  payload: string;
}

/** Records what would have gone out, and answers with the status the test names. */
function recorder(status: (endpoint: string) => number | "reject"): {
  send: SendPush;
  sent: Sent[];
} {
  const sent: Sent[] = [];

  return {
    sent,
    send: (subscription, payload) => {
      sent.push({ subscription, payload });

      const answer = status(subscription.endpoint);

      return answer === "reject"
        ? Promise.reject(new Error("socket hang up"))
        : Promise.resolve({ statusCode: answer });
    },
  };
}

describe("push notifier", () => {
  let db: NoctisDatabase;
  let sessionId: string;
  const logger = createLogger({ level: "error", sink: () => undefined, clock });

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db, { directory: MIGRATIONS_DIRECTORY, clock });
    sessionId = createSession({ db, clock, ids: createIdFactory(clock) }, 1).id;
  });

  function notifier(vapid: typeof VAPID | undefined, send: SendPush) {
    return createNotifier({ db, clock, ids: createIdFactory(clock), vapid, send, logger });
  }

  function subscriptionRows(): { endpoint: string }[] {
    return db.prepare("SELECT endpoint FROM push_subscriptions").all() as { endpoint: string }[];
  }

  function store(notify: ReturnType<typeof notifier>, endpoint: string): void {
    notify.subscribe(sessionId, {
      endpoint,
      // The shapes `PushSubscriptionSchema` enforces at the route, so these
      // rows look like the ones a browser actually produces.
      keys: {
        p256dh: Buffer.alloc(65).toString("base64url"),
        auth: Buffer.alloc(16).toString("base64url"),
      },
    });
  }

  it("has no public key and sends nothing when no VAPID keys are configured", async () => {
    const { send, sent } = recorder(() => 201);
    const push = notifier(undefined, send);

    store(push, "https://push.example/1");
    await push.notify([failedTurn()]);

    expect(push.publicKey()).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("offers the public key", () => {
    expect(notifier(VAPID, recorder(() => 201).send).publicKey()).toBe("public-key");
  });

  it("stores one row per endpoint, however many times it subscribes", () => {
    const push = notifier(VAPID, recorder(() => 201).send);

    store(push, "https://push.example/1");
    store(push, "https://push.example/1");
    store(push, "https://push.example/2");

    expect(subscriptionRows().map((row) => row.endpoint)).toEqual([
      "https://push.example/1",
      "https://push.example/2",
    ]);
  });

  it("sends one message per stored subscription, carrying pushFor's payload", async () => {
    const { send, sent } = recorder(() => 201);
    const push = notifier(VAPID, send);

    store(push, "https://push.example/1");
    store(push, "https://push.example/2");
    await push.notify([failedTurn()]);

    expect(sent.map((one) => one.subscription.endpoint)).toEqual([
      "https://push.example/1",
      "https://push.example/2",
    ]);
    expect(JSON.parse(sent[0]?.payload ?? "{}")).toEqual({
      title: "Turn failed",
      body: "runtime_failed",
      url: "/",
      tag: "00000000-0000-4000-8000-0000000000aa",
    });
  });

  it("sends nothing at all for an event pushFor ignores — not an empty send, no send", async () => {
    const { send, sent } = recorder(() => 201);
    const push = notifier(VAPID, send);

    store(push, "https://push.example/1");
    await push.notify([completedTurn()]);

    expect(sent).toEqual([]);
  });

  it("prunes a subscription the push service says is gone", async () => {
    const { send } = recorder((endpoint) => (endpoint.endsWith("/dead") ? 410 : 201));
    const push = notifier(VAPID, send);

    store(push, "https://push.example/dead");
    store(push, "https://push.example/live");
    await push.notify([failedTurn()]);

    expect(subscriptionRows().map((row) => row.endpoint)).toEqual(["https://push.example/live"]);
  });

  it("prunes a 404 too — an endpoint that is not there is not coming back", async () => {
    const { send } = recorder(() => 404);
    const push = notifier(VAPID, send);

    store(push, "https://push.example/1");
    await push.notify([failedTurn()]);

    expect(subscriptionRows()).toEqual([]);
  });

  it("keeps a subscription through a 500 — a bad day is not a dead browser", async () => {
    const { send } = recorder(() => 500);
    const push = notifier(VAPID, send);

    store(push, "https://push.example/1");
    await push.notify([failedTurn()]);

    expect(subscriptionRows().map((row) => row.endpoint)).toEqual(["https://push.example/1"]);
  });

  it("keeps sending to the rest when one send rejects, and keeps that row", async () => {
    const { send, sent } = recorder((endpoint) => (endpoint.endsWith("/1") ? "reject" : 201));
    const push = notifier(VAPID, send);

    store(push, "https://push.example/1");
    store(push, "https://push.example/2");
    await expect(push.notify([failedTurn()])).resolves.toBeUndefined();

    expect(sent).toHaveLength(2);
    expect(subscriptionRows()).toHaveLength(2);
  });

  it("forgets a subscription on unsubscribe, and says nothing about one it never had", () => {
    const push = notifier(VAPID, recorder(() => 201).send);

    store(push, "https://push.example/1");
    push.unsubscribe("https://push.example/1");
    push.unsubscribe("https://push.example/never");

    expect(subscriptionRows()).toEqual([]);
  });

  it("rebinds an endpoint to the session that re-registers it", () => {
    const push = notifier(VAPID, recorder(() => 201).send);

    store(push, "https://push.example/1");

    // The phone logs in again — a new session, the same browser and the same
    // endpoint. Without the ON CONFLICT rebind this is either a duplicate row
    // or a row still pointing at a session that is about to be swept, and the
    // sweep takes the phone's only subscription with it.
    const next = createSession({ db, clock, ids: createIdFactory(clock) }, 1).id;

    push.subscribe(next, {
      endpoint: "https://push.example/1",
      keys: {
        p256dh: Buffer.alloc(65).toString("base64url"),
        auth: Buffer.alloc(16).toString("base64url"),
      },
    });

    const rows = db.prepare("SELECT session_id AS sessionId FROM push_subscriptions").all() as {
      sessionId: string;
    }[];

    expect(rows).toEqual([{ sessionId: next }]);

    // And the row survives the old session going away, which is the whole point.
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);

    expect(subscriptionRows()).toHaveLength(1);
  });

  it("loses a phone's subscription with the session it belongs to", () => {
    const push = notifier(VAPID, recorder(() => 201).send);

    store(push, "https://push.example/1");
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);

    expect(subscriptionRows()).toEqual([]);
  });
});

describe("the subscription a real browser actually sends", () => {
  // `PushSubscription.toJSON()` returns the Push API's `PushSubscriptionJSON`
  // dictionary, which is three fields, not two. Every fixture in this file was
  // written by hand from the two the core reads — so the schema was `.strict()`
  // against a shape no browser has ever sent, and every test passed while every
  // real phone got a 400.
  const FROM_A_BROWSER = {
    endpoint: "https://web.push.apple.com/QF-abc123",
    expirationTime: null,
    keys: {
      p256dh: Buffer.alloc(65, 7).toString("base64url"),
      auth: Buffer.alloc(16, 9).toString("base64url"),
    },
  };

  it("accepts expirationTime, which the spec sends and nothing here reads", () => {
    const parsed = PushSubscriptionSchema.safeParse(FROM_A_BROWSER);

    expect(parsed.success).toBe(true);
  });

  it("accepts a numeric expirationTime as well as a null one", () => {
    expect(
      PushSubscriptionSchema.safeParse({ ...FROM_A_BROWSER, expirationTime: 1_767_225_600_000 })
        .success,
    ).toBe(true);
  });

  it("still refuses a field the spec does not define, so the closed set is not abandoned", () => {
    expect(
      PushSubscriptionSchema.safeParse({ ...FROM_A_BROWSER, somethingElse: "x" }).success,
    ).toBe(false);
  });

  it("still refuses an http endpoint and key material of the wrong length", () => {
    expect(
      PushSubscriptionSchema.safeParse({ ...FROM_A_BROWSER, endpoint: "http://push.example/x" })
        .success,
    ).toBe(false);
    expect(
      PushSubscriptionSchema.safeParse({
        ...FROM_A_BROWSER,
        keys: { ...FROM_A_BROWSER.keys, auth: Buffer.alloc(15, 9).toString("base64url") },
      }).success,
    ).toBe(false);
  });
});
