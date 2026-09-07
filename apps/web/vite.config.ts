import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Everything the core answers. The web app itself serves only `/` and
 * `/assets`, so an explicit list is safer than a catch-all: a path added to the
 * core later is proxied on purpose, not by accident.
 *
 * The trailing group must accept `?`. Vite matches this against `req.url`,
 * which carries the query string, so a pattern anchored on `/` or end-of-string
 * alone silently misses `/objectives?limit=25` — and a missed core path is
 * served the SPA's index.html with a 200, which is far harder to spot than a
 * 404 would have been.
 */
const CORE_PATHS =
  /^\/(commands|objectives|identities|missions|nodes|jobs|events|vault|approvals|permissions|sources|artifacts|ready|diagnostics|health|ws)(\/|\?|$)/;

/**
 * The dev and preview servers proxy the core so the page and the core share an
 * origin.
 *
 * This is not a convenience. Section 9.2 says "CORS is not treated as CSRF
 * protection", so the core deliberately emits no permissive CORS headers and a
 * cross-origin browser request cannot succeed — which would leave
 * `BrowserTransport` unusable for the local iteration `core-client.ts` says it
 * exists for. Same origin is the only arrangement that works, and it is also
 * what the packaged Tauri shell provides in production.
 */
const proxy = {
  [CORE_PATHS.source]: {
    target: process.env.NOCTIS_CORE_PROXY_TARGET ?? "http://127.0.0.1:8787",
    changeOrigin: false,
    ws: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
  build: {
    // Tauri's `frontendDist` reads this directory (apps/desktop/src-tauri/tauri.conf.json).
    outDir: "dist",
  },
});
