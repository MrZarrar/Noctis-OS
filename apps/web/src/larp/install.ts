import { installLarpTransport } from "../core-client.js";
import { DemoTransport } from "./DemoTransport.js";
import { ok, type LarpArea } from "./area.js";
import { files } from "./files.js";
import { healthArea } from "./health.js";
import { productivity } from "./productivity.js";
import { vaultArea } from "./vault.js";
import { worldArea } from "./world.js";

/**
 * Boots LARP mode. `main.tsx` imports this lazily, only when the toggle is on,
 * so none of the fixtures or demo code load in real mode.
 *
 * A tapped approval notification opens `/?larp=approval`: that page starts with
 * the demo task already waiting, the way a real approval would be on arrival.
 */
export async function installLarp(): Promise<void> {
  const url = new URL(window.location.href);
  const seeded = url.searchParams.get("larp") === "approval";

  if (seeded) {
    url.searchParams.delete("larp");
    history.replaceState(history.state, "", url);
  }

  installLarpTransport(
    new DemoTransport({
      areas: [await existingPushKey(), vaultArea, healthArea, productivity, files, worldArea],
      notify: (title, body, target, tag) => {
        void notify(title, body, target, tag);
      },
      ...(seeded ? { seed: "approval" as const } : {}),
    }),
  );
}

/**
 * This device's real push subscription, if it has one, was made with the real
 * core's key, and the browser refuses to subscribe again with any other. So LARP
 * mode offers that same key: the browser hands back the subscription it already
 * has, untouched, and real notifications keep working once LARP mode is off.
 */
async function existingPushKey(): Promise<LarpArea> {
  let key: string | undefined;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    const raw = (await registration?.pushManager.getSubscription())?.options.applicationServerKey;
    if (raw) {
      key = btoa(String.fromCharCode(...new Uint8Array(raw)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    }
  } catch {
    /* no subscription to match: the fixture's own key is used */
  }
  return {
    request: (method, path) =>
      key !== undefined && method === "GET" && path === "/push/key"
        ? ok({ publicKey: key })
        : undefined,
  };
}

/** Shown through the service worker, so it looks and taps exactly like a real push. */
async function notify(title: string, body: string, url: string, tag: string): Promise<void> {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration === undefined) {
      new Notification(title, { body, tag });
      return;
    }
    await registration.showNotification(title, {
      body,
      tag,
      data: { url },
    });
  } catch {
    /* the in-app approval, if this was one, is still there */
  }
}
