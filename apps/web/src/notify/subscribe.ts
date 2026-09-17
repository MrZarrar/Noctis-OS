import type { CoreTransport } from "../transport/CoreTransport.js";

/**
 * Turning notifications on for this device.
 *
 * Every step can fail for a reason that is not a bug — an old browser, a
 * refusal, a core with no keys — so nothing here throws. The four outcomes are
 * exactly what the Settings card has to say out loud, and each one is a
 * different thing for the owner to do next.
 *
 * `unsupported` means this browser cannot, which on an iPhone means "not from a
 * tab" and is the only case where the Home Screen advice helps. `failed` means
 * it could and something did not: the core refused the subscription, holds no
 * VAPID keys, or could not be reached. Collapsing the second into the first
 * sent the owner of a perfectly capable phone off to install an app they had
 * installed already.
 */
export type PushState = "enabled" | "denied" | "unsupported" | "failed";

interface SubscriptionLike {
  toJSON(): unknown;
}

interface RegistrationLike {
  pushManager: {
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array<ArrayBuffer>;
    }): Promise<SubscriptionLike>;
  };
}

/**
 * The browser surface push needs, passed in rather than read off the global —
 * the same shape `nativeWindowBridgeFrom` uses, and for the same reason: a test
 * supplies one instead of stubbing globals it does not own.
 */
export interface PushScope {
  navigator?: {
    serviceWorker?: { register(url: string): Promise<RegistrationLike> };
  };
  Notification?: {
    permission: string;
    requestPermission(): Promise<string>;
  };
}

/**
 * `applicationServerKey` wants raw bytes, and the core sends the key the way
 * every VAPID tool prints it: base64url, unpadded.
 *
 * The Push API also accepts the string form, which would delete this function —
 * but the bytes are what every browser has always supported, and a key that is
 * silently rejected on one phone is invisible until someone notices the phone
 * never rings.
 */
function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);

  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }

  return bytes;
}

function supported(scope: PushScope): boolean {
  // `Notification` is absent — not merely unpermitted — in Safari on iOS until
  // the page has been added to the Home Screen. That is a real device
  // constraint, not a broken browser, so it reads as "unsupported" and the card
  // says what to do about it.
  return scope.navigator?.serviceWorker !== undefined && scope.Notification !== undefined;
}

/**
 * What the card says before anyone presses anything. `undefined` means "off,
 * and can be turned on".
 *
 * This reads the *browser's* permission and nothing else, so `"enabled"` here
 * means "this device was granted permission at some point", not "the core holds
 * a subscription for it". The two come apart: `push_subscriptions` cascades
 * from `sessions`, so an expired session takes the row with it while the
 * browser keeps its permission and its `PushSubscription` forever. That is why
 * the card re-registers on mount rather than trusting this answer — see
 * `Settings.tsx`.
 */
export function initialPushState(scope: PushScope = globalThis): PushState | undefined {
  if (!supported(scope)) {
    return "unsupported";
  }

  const permission = scope.Notification?.permission;

  if (permission === "denied") {
    return "denied";
  }

  return permission === "granted" ? "enabled" : undefined;
}

export async function enablePush(
  transport: CoreTransport,
  scope: PushScope = globalThis,
  report: (detail: string) => void = () => undefined,
): Promise<PushState> {
  if (!supported(scope) || scope.navigator?.serviceWorker === undefined) {
    report("this browser exposes no Notification API or no service worker");
    return "unsupported";
  }

  const serviceWorker = scope.navigator.serviceWorker;

  // Which step we are on, so a refusal can name the step instead of the
  // feature. Four of the lines below can fail, each meaning something
  // different for the owner to do next, and the catch used to flatten all of
  // them into one sentence that said only that it had not worked.
  //
  // ponytail: a reporter rather than a richer return type, because ten tests
  // and one caller already agree on `PushState`. Return `{state, detail}` if a
  // second caller ever needs the detail too.
  let stage = "asking the core for its push key";

  try {
    // The key first, and before the permission prompt: a core with no VAPID
    // keys can deliver nothing, and asking for permission it cannot use spends
    // the one prompt a browser gives.
    const key = await transport.request("GET", "/push/key");

    if (key.status !== 200) {
      // 404 here is a core with no VAPID keys — nothing to do with this
      // browser, which is why it is not `unsupported`.
      report(`the core answered ${String(key.status)} for its push key`);
      return "failed";
    }

    const publicKey = (key.body as { publicKey?: unknown }).publicKey;

    if (typeof publicKey !== "string" || publicKey === "") {
      report("the core sent no public key");
      return "failed";
    }

    stage = "asking this device for permission";

    if ((await scope.Notification?.requestPermission()) !== "granted") {
      report("this device refused permission");
      return "denied";
    }

    stage = "registering the service worker";

    const registration = await serviceWorker.register("/sw.js");

    stage = "subscribing with the push service";
    const subscription = await registration.pushManager.subscribe({
      // Required by every browser: a push that shows nothing is a push that can
      // be used to track someone silently.
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    });

    stage = "sending the subscription to the core";

    const stored = await transport.request("POST", "/push/subscribe", subscription.toJSON());

    // A 403 is the credential gate and a 500 is the core; neither is a browser
    // that does not support notifications, and telling the owner it was would
    // send them to add a Home Screen icon they already have.
    if (stored.status !== 200) {
      report(`the core answered ${String(stored.status)} for the subscription`);
    }

    return stored.status === 200 ? "enabled" : "failed";
  } catch (error) {
    // A registration a browser refuses, a network that is not there, a push
    // service that will not issue an endpoint. None of them is worth an
    // exception the card has to decode — and none of them is the browser
    // lacking the API, which `supported` above already ruled out.
    report(`${stage} failed: ${error instanceof Error ? error.message : String(error)}`);

    return "failed";
  }
}
