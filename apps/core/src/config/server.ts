import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { LogLevel } from "../logging.js";
import { assertNoLegacyJarvisVariables } from "./environment.js";

export class ConfigurationError extends Error {}

export interface CoreConfig {
  bindAddress: string;
  port: number;
  /** Bearer token for the client realm. Never logged, never sent to a WebView. */
  token: string;
  databasePath: string;
  /**
   * Browser origins permitted to issue commands. Empty by default: a native or
   * proxied client sends no Origin header and is unaffected, while a browser
   * page on an unlisted origin is refused. CORS is not treated as CSRF
   * protection (Section 9.2), so this list gates the request itself.
   */
  allowedOrigins: readonly string[];
  logLevel: LogLevel;
  /** How long a browser session lasts. A phone should not be asked to log in weekly. */
  sessionTtlHours: number;
  /**
   * The built web app, served at `/` when set. Unset in development, where Vite
   * serves the page and the core only allowlists its origin. Set where the core
   * is the front door: `tailscale serve` maps one hostname to one port, and
   * ADR-0028's `SameSite=Strict` cookie needs the page on the core's own origin.
   */
  webRoot?: string;
}

/** Noctis-only default. Deliberately not a port the donor or any common tool uses. */
export const DEFAULT_PORT = 7717;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * A token shorter than this is not a credential. 32 characters is the minimum
 * for the 256-bit random value the shell is expected to generate.
 */
const MIN_TOKEN_LENGTH = 32;

const LOG_LEVELS = new Set<string>(["debug", "info", "warn", "error"]);

function required(env: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = env[key]?.trim();

  if (value === undefined || value === "") {
    throw new ConfigurationError(`${key} is required`);
  }

  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }

  const port = Number(raw.trim());

  // 0 is valid and means "let the OS pick a free port" — what tests and a
  // shell that discovers the port from the core both want.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigurationError(`NOCTIS_CORE_PORT must be an integer 0-65535, got ${raw}`);
  }

  return port;
}

/** Thirty days. A phone is asked to log in monthly, and never more than yearly. */
const DEFAULT_SESSION_TTL_HOURS = 720;
const MAX_SESSION_TTL_HOURS = 8760;

function parseSessionTtlHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SESSION_TTL_HOURS;
  }

  const hours = Number(raw.trim());

  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_SESSION_TTL_HOURS) {
    throw new ConfigurationError(
      "NOCTIS_SESSION_TTL_HOURS must be a whole number of hours between 1 and 8760",
    );
  }

  return hours;
}

function parseOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      let parsed: URL;
      try {
        parsed = new URL(entry);
      } catch {
        throw new ConfigurationError(`NOCTIS_ALLOWED_ORIGINS entry is not a URL: ${entry}`);
      }

      // An origin is scheme + host + port and nothing else. Accepting a path or
      // credentials here would make the later string comparison meaningless,
      // because a browser only ever sends the bare origin.
      if (parsed.origin !== entry) {
        throw new ConfigurationError(
          `NOCTIS_ALLOWED_ORIGINS entry must be a bare origin, got ${entry}`,
        );
      }

      return parsed.origin;
    });
}

/**
 * Where the built page lives, resolved absolute so it does not move with the
 * process's working directory, and checked hard enough that a misconfiguration
 * stops the process instead of producing a front door that looks fine and does
 * nothing.
 *
 * Two refusals, both of which are otherwise silent failures:
 *
 * - A directory with no index.html serves 404 for every request, including `/`.
 * - An empty origin allowlist lets the page *load* — a browser sends no
 *   `Origin` on a same-origin GET navigation — and then refuses the login POST
 *   with 403, and `/events/live` too, because `EventSource` does send `Origin`
 *   even same-origin. The page appears, cannot log in, and cannot stream.
 *   There is no deployment where serving the page is wanted and an allowlist
 *   is not.
 */
function parseWebRoot(
  raw: string | undefined,
  allowedOrigins: readonly string[],
): string | undefined {
  const trimmed = raw?.trim();

  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }

  const root = resolve(trimmed);

  if (!existsSync(join(root, "index.html"))) {
    throw new ConfigurationError(
      `NOCTIS_WEB_ROOT has no index.html: ${root}. Point it at a built web app (\`npm run build:web\` writes apps/web/dist).`,
    );
  }

  if (allowedOrigins.length === 0) {
    throw new ConfigurationError(
      "NOCTIS_WEB_ROOT is set but NOCTIS_ALLOWED_ORIGINS is empty, so the page would load and then be unable to log in or stream. Set NOCTIS_ALLOWED_ORIGINS to the origin the page is served from, for example https://noctis.tailnet-name.ts.net",
    );
  }

  return root;
}

/**
 * Reads configuration and refuses to produce a usable value for anything
 * unsafe. There is no permissive fallback: an unset token, an unexplained
 * non-loopback bind, or an unparseable value stops the process here rather
 * than starting a listener that is wrong in a way nobody notices.
 */
export function loadCoreConfig(env: Readonly<Record<string, string | undefined>>): CoreConfig {
  assertNoLegacyJarvisVariables(env);

  const token = required(env, "NOCTIS_CORE_TOKEN");

  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigurationError(
      `NOCTIS_CORE_TOKEN must be at least ${String(MIN_TOKEN_LENGTH)} characters`,
    );
  }

  const bindAddress = env.NOCTIS_CORE_BIND?.trim() ?? "127.0.0.1";

  if (!LOOPBACK.has(bindAddress) && env.NOCTIS_ALLOW_NON_LOOPBACK?.trim() !== "true") {
    throw new ConfigurationError(
      `Refusing to bind ${bindAddress}: set NOCTIS_ALLOW_NON_LOOPBACK=true to expose the core beyond loopback`,
    );
  }

  const webRoot = parseWebRoot(env.NOCTIS_WEB_ROOT, parseOrigins(env.NOCTIS_ALLOWED_ORIGINS));
  const logLevel = env.NOCTIS_LOG_LEVEL?.trim() ?? "info";

  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigurationError(`NOCTIS_LOG_LEVEL must be one of debug, info, warn, error`);
  }

  return {
    bindAddress,
    port: parsePort(env.NOCTIS_CORE_PORT),
    token,
    databasePath: required(env, "NOCTIS_DATABASE_PATH"),
    allowedOrigins: parseOrigins(env.NOCTIS_ALLOWED_ORIGINS),
    logLevel: logLevel as LogLevel,
    sessionTtlHours: parseSessionTtlHours(env.NOCTIS_SESSION_TTL_HOURS),
    ...(webRoot === undefined ? {} : { webRoot }),
  };
}
