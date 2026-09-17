import type { CoreTransport } from "./transport/CoreTransport.js";
import { BrowserTransport } from "./transport/BrowserTransport.js";
import { SessionTransport } from "./transport/SessionTransport.js";
import { tauriTransportFromGlobal } from "./transport/TauriTransport.js";

/**
 * The core's origin.
 *
 * The page's own origin by default, which is the deployed shape: the core
 * serves the built page (`NOCTIS_WEB_ROOT`), so the page and the core are one
 * origin — the only arrangement in which ADR-0028's `SameSite=Strict` session
 * cookie is ever sent. `VITE_CORE_URL` overrides it for a dev build, where Vite
 * serves the page and proxies the core.
 */
export function coreBaseUrl(): string {
  return (import.meta.env.VITE_CORE_URL as string | undefined) ?? window.location.origin;
}

/** True when there is no Tauri bridge and no build-time token: this page must log in. */
export function needsLogin(): boolean {
  const token = import.meta.env.VITE_CORE_TOKEN as string | undefined;

  return tauriTransportFromGlobal() === undefined && (token === undefined || token === "");
}

/**
 * The packaged shell is the only supported production path for a desktop —
 * Rust holds the core token there (Section 9.2). A `vite dev` build that was
 * handed a token keeps `BrowserTransport`, so the local iteration loop is
 * unchanged.
 *
 * Everything else is a page served over Tailscale with no token at all. It logs
 * in once, holds the CSRF value in memory, and gets the session realm — which
 * is the only realm an `EventSource` can authenticate, since it cannot carry an
 * `Authorization` header.
 *
 * `undefined` means "this page cannot reach the core", which is also what a
 * tokenless page says before it has logged in. Every caller already handles it.
 */
export function resolveCoreTransport(csrf?: string): CoreTransport | undefined {
  const tauri = tauriTransportFromGlobal();

  if (tauri !== undefined) {
    return tauri;
  }

  const token = import.meta.env.VITE_CORE_TOKEN as string | undefined;

  if (token !== undefined && token !== "") {
    return new BrowserTransport({ baseUrl: coreBaseUrl(), token });
  }

  return csrf === undefined ? undefined : new SessionTransport({ baseUrl: coreBaseUrl(), csrf });
}
