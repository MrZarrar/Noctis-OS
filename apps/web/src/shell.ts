import type { OrchestrationEvent } from "@noctis/contracts";

import type { CoreTransport } from "./transport/CoreTransport.js";
import type { Listen } from "./transport/TauriTransport.js";
import { tauriTransportFromGlobal } from "./transport/TauriTransport.js";

/**
 * The Phase 4 canary.
 *
 * Not the workbench — that is Phase 5. This page exists to prove the shell end
 * to end: that the WebView can reach the core only through Rust, that events
 * arrive over the socket Rust holds, that a deep link and the tray reach the
 * page, and that the one granted plugin works while nothing else is reachable.
 */
const STATUS_EVENT = "core:status";
const DEEP_LINK_EVENT = "core:deep-link";
const MAX_LISTED_EVENTS = 50;

interface NotificationBridge {
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<string>;
  sendNotification: (options: { title: string; body: string }) => void;
}

interface Bridge {
  event: { listen: Listen };
  notification: NotificationBridge;
}

function bridge(): Bridge | undefined {
  return (globalThis as { __TAURI__?: Bridge }).__TAURI__;
}

function field(id: string): Element | null {
  return document.querySelector(`#${id}`);
}

function write(id: string, text: string): void {
  const target = field(id);

  if (target !== null) {
    target.textContent = text;
  }
}

function list(event: OrchestrationEvent): void {
  const target = field("events");

  if (target === null) {
    return;
  }

  const row = document.createElement("li");

  row.textContent = `${String(event.sequence)}  ${event.type}`;
  target.prepend(row);

  while (target.childElementCount > MAX_LISTED_EVENTS) {
    target.lastElementChild?.remove();
  }
}

async function readReady(transport: CoreTransport): Promise<void> {
  const response = await transport.request("GET", "/ready");

  write("ready", `HTTP ${String(response.status)} ${JSON.stringify(response.body)}`);
}

function wireNotification(notification: NotificationBridge): void {
  field("notify")?.addEventListener("click", () => {
    void (async () => {
      const granted =
        (await notification.isPermissionGranted()) ||
        (await notification.requestPermission()) === "granted";

      if (granted) {
        notification.sendNotification({ title: "Noctis OS", body: "The shell is running." });
      }
    })();
  });
}

async function start(): Promise<void> {
  const shell = bridge();
  const transport = tauriTransportFromGlobal();

  if (shell === undefined || transport === undefined) {
    write("connection", "Not running inside the Noctis shell.");
    return;
  }

  await shell.event.listen(STATUS_EVENT, ({ payload }) => {
    write("connection", typeof payload === "string" ? payload : "unknown");
  });

  await shell.event.listen(DEEP_LINK_EVENT, ({ payload }) => {
    write("link", JSON.stringify(payload));
  });

  wireNotification(shell.notification);

  try {
    await readReady(transport);
  } catch (error) {
    write("ready", error instanceof Error ? error.message : String(error));
  }

  // From zero, because this page keeps nothing between runs. A real client
  // resumes from the last sequence it committed.
  await transport.subscribe({
    afterSequence: 0,
    onEvent: list,
    onGap: (from, to) =>
      write("connection", `gap: core holds ${String(from)}, asked ${String(to)}`),
    onError: (error) => write("connection", `stream error: ${JSON.stringify(error)}`),
  });
}

void start();
