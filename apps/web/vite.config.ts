import { fileURLToPath } from "node:url";

import { CORE_PATH_PATTERN } from "@noctis/contracts";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

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
 *
 * The paths it claims come from `@noctis/contracts`, the same list the core's
 * `isApiPath` uses. They were two hand-maintained copies until this one was
 * found to be missing `session` — so `GET /session` was answered with the SPA's
 * own index.html and a 200, and session resume quietly did not work in dev.
 */
const proxy = {
  [CORE_PATH_PATTERN.source]: {
    target: process.env.NOCTIS_CORE_PROXY_TARGET ?? "http://127.0.0.1:8787",
    changeOrigin: false,
    ws: true,
  },
};

/**
 * A production bundle must never carry a development token.
 *
 * Vite inlines every `VITE_`-prefixed variable into the output at build time.
 * The dev loop and the E2E suites both set `VITE_CORE_TOKEN`, so a build run in
 * one of those shells writes the full core token into a file in `dist/` — and
 * the core serves `dist/` unauthenticated, before the credential gate, whenever
 * `NOCTIS_WEB_ROOT` points at it. Nothing looks wrong when that happens:
 * `needsLogin()` returns false, so the login screen never even appears.
 *
 * This is a throw rather than a warning on purpose. The operator most likely to
 * hit it is the one whose shell already exports the variable, and that operator
 * does not read warnings scrolling past a build.
 *
 * `loadEnv` rather than `process.env` so a `.env` file is caught too.
 */
function refuseTokenInBundle(mode: string): void {
  const token = loadEnv(
    mode,
    fileURLToPath(new URL(".", import.meta.url)),
    "VITE_",
  ).VITE_CORE_TOKEN;

  if (token !== undefined && token !== "") {
    throw new Error(
      "VITE_CORE_TOKEN is set, and `vite build` would inline it into apps/web/dist — which the core serves unauthenticated when NOCTIS_WEB_ROOT points at it. Build in a shell that does not have it: open a new terminal, or run `Remove-Item Env:VITE_CORE_TOKEN` (PowerShell) / `unset VITE_CORE_TOKEN` (sh) first. The dev server and the E2E suites are unaffected and still use it.",
    );
  }
}

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    refuseTokenInBundle(mode);
  }

  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
    build: {
      // Tauri's `frontendDist` reads this directory (apps/desktop/src-tauri/tauri.conf.json).
      outDir: "dist",
    },
  };
});
