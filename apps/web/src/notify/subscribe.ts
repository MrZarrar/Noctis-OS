import type { CoreTransport } from "../transport/CoreTransport.js";

/**
 * Turning notifications on for this device.
 *
 * Every step can fail for a reason that is not a bug — an old browser, a
 * refusal, a core with no keys — so nothing here throws. The three outcomes are
 * exactly what the Settings card has to say out loud.
 */
export type PushState = "enabled" | "denied" | "unsupported";

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

/** What the card says before anyone presses anything. `undefined` means "off, and can be turned on". */
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
): Promise<PushState> {
  if (!supported(scope) || scope.navigator?.serviceWorker === undefined) {
    return "unsupported";
  }

  const serviceWorker = scope.navigator.serviceWorker;

  try {
    // The key first, and before the permission prompt: a core with no VAPID
    // keys can deliver nothing, and asking for permission it cannot use spends
    // the one prompt a browser gives.
    const key = await transport.request("GET", "/push/key");

    if (key.status !== 200) {
      return "unsupported";
    }

    const publicKey = (key.body as { publicKey?: unknown }).publicKey;

    if (typeof publicKey !== "string" || publicKey === "") {
      return "unsupported";
    }

    if ((await scope.Notification?.requestPermission()) !== "granted") {
      return "denied";
    }

    const registration = await serviceWorker.register("/sw.js");
    const subscription = await registration.pushManager.subscribe({
      // Required by every browser: a push that shows nothing is a push that can
      // be used to track someone silently.
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    });

    const stored = await transport.request("POST", "/push/subscribe", subscription.toJSON());

    return stored.status === 200 ? "enabled" : "unsupported";
  } catch {
    // A registration a browser refuses, a network that is not there, a push
    // service that will not issue an endpoint. None of them is worth an
    // exception the card has to decode.
    return "unsupported";
  }
}
