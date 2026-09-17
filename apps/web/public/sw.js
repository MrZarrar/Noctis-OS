/**
 * Slice 2, decision 0.25. The core sends JSON; this turns it into a
 * notification and makes tapping it land on the page.
 *
 * Served from the web root (`apps/web/public` is copied to the root of `dist`,
 * which the core serves), so its scope is the whole app. A worker served from a
 * subdirectory cannot control the pages above it, and would never receive a
 * push for them.
 *
 * Plain JavaScript on purpose: no build step, no imports, nothing to bundle.
 */

self.addEventListener("push", (event) => {
  if (!event.data) {
    return;
  }

  let payload;

  try {
    payload = event.data.json();
  } catch {
    // Not ours, or corrupt. A notification with no content is worse than none.
    return;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? "Noctis", {
      body: payload.body ?? "",
      tag: payload.tag,
      // A replaced notification should still be seen: without this, a silent
      // re-tag updates the text and the phone never lights up.
      renotify: Boolean(payload.tag),
      data: { url: payload.url ?? "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = event.notification.data?.url ?? "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus the tab that is already open rather than opening a second one.
      for (const client of clients) {
        if ("focus" in client) {
          return client.focus();
        }
      }

      return self.clients.openWindow(target);
    }),
  );
});
