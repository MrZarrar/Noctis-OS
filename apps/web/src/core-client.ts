import type { CoreTransport } from "./transport/CoreTransport.js";
import { BrowserTransport } from "./transport/BrowserTransport.js";
import { tauriTransportFromGlobal } from "./transport/TauriTransport.js";

/**
 * The packaged shell is the only supported production path — Rust holds the
 * core token there (Section 9.2). Falling back to `BrowserTransport` only
 * when `vite dev` is run outside Tauri and both env vars are set lets the
 * workbench be iterated on directly against a local core; it is refused by
 * construction everywhere else, since no other caller can supply a token.
 */
export function resolveCoreTransport(): CoreTransport | undefined {
  const tauri = tauriTransportFromGlobal();

  if (tauri !== undefined) {
    return tauri;
  }

  const baseUrl = import.meta.env.VITE_CORE_URL as string | undefined;
  const token = import.meta.env.VITE_CORE_TOKEN as string | undefined;

  return baseUrl === undefined || token === undefined
    ? undefined
    : new BrowserTransport({ baseUrl, token });
}
