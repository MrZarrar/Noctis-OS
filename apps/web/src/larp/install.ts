import { installLarpTransport } from "../core-client.js";
import { DemoTransport } from "./DemoTransport.js";
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
export function installLarp(): void {
  const url = new URL(window.location.href);
  const seeded = url.searchParams.get("larp") === "approval";

  if (seeded) {
    url.searchParams.delete("larp");
    history.replaceState(history.state, "", url);
  }

  installLarpTransport(
    new DemoTransport({
      areas: [vaultArea, healthArea, productivity, files, worldArea],
      notify: (title, body, target, tag) => {
        void notify(title, body, target, tag);
      },
      ...(seeded ? { seed: "approval" as const } : {}),
    }),
  );
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
