import type { KeyObject } from "node:crypto";
import { createPrivateKey, ECDH } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { RemoteHostNameSchema } from "@noctis/contracts";
import { z } from "zod";

import type { LogLevel } from "../logging.js";
import type { VapidKeys } from "../notify/push.js";
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
  /**
   * Web push credentials, or absent — and absent is the default. A core without
   * them is quietly without push: `/push/key` answers 404 and the Settings card
   * says so. The private key is a credential and lives only here, in memory.
   */
  vapid?: VapidKeys;
  /**
   * The embedded remote desktop (ADR-0035), or absent — the default. Absent,
   * `/remote/hosts` lists nothing and `remote.open_session` answers 404.
   */
  remoteDesktop?: RemoteDesktopConfig;
}

export interface RemoteDesktopTargetConfig {
  /** What a page asks for. */
  host: string;
  /** The Gateway's RDCleanPath endpoint, `wss://…/jet/rdp`. */
  gatewayUrl: string;
  /** `host:port` of the RDP listener, signed into every token for this host. */
  destination: string;
}

export interface RemoteDesktopConfig {
  targets: readonly RemoteDesktopTargetConfig[];
  /**
   * The Gateway provisioner private key. The one secret on this path: it signs
   * tokens, and it is read once from a file and held only in memory. The
   * Windows password is not here and never is.
   */
  privateKey: KeyObject;
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
 * - A directory with an index.html and no `assets/` is the *source* tree, not a
 *   build. `apps/web/index.html` exists as Vite's entry, so `NOCTIS_WEB_ROOT=
 *   apps/web` — one missing `/dist` — used to start cleanly and serve `/src/**`,
 *   `/vite.config.ts`, `/node_modules/**` (which does not match the `node` API
 *   segment) and any `.env` sitting there, all unauthenticated and ahead of the
 *   credential gate. That `.env` is exactly where `VITE_CORE_TOKEN` lives.
 *   `refuseTokenInBundle` guards the token reaching `dist`; nothing guarded it
 *   being served from beside the source. Every Vite build writes `assets/`, so
 *   requiring it is the cheapest way to say "a build, not a source tree".
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

  if (!existsSync(join(root, "assets"))) {
    throw new ConfigurationError(
      `NOCTIS_WEB_ROOT has an index.html but no assets directory: ${root}. That is the web app's source tree, not its build, and serving it would publish the sources — and any .env beside them — to anyone who can reach the port. Point it at apps/web/dist (\`npm run build:web\`).`,
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
 * All three VAPID variables or none of them.
 *
 * One or two set is a misconfiguration and stops the process, because a core
 * that silently has no push is indistinguishable from one whose key was
 * mistyped — and the symptom in both cases is a phone that simply never rings,
 * which nobody investigates for weeks.
 *
 * The message names which variables are missing and never their values: the
 * private key is a credential, and an error message is a place text goes to be
 * copied into a terminal, a screenshot, and an issue.
 */
/**
 * A P-256 key pair, url-safe base64 and unpadded, as every VAPID tool prints it
 * and as `web-push` requires: 65 bytes for the public point, 32 for the scalar.
 *
 * Checked here rather than left to `setVapidDetails` so a truncated paste looks
 * like every other misconfiguration — a `ConfigurationError` from config load —
 * instead of a raw `Error` thrown from inside a library halfway through
 * `startCore`. Both stop the process; only one of them is recognisable at 7am.
 *
 * The name is named, never the value.
 */
const URL_SAFE_BASE64 = /^[A-Za-z0-9_-]+$/;

function assertVapidKey(name: string, value: string, bytes: number): void {
  // `Buffer.from(…, "base64url")` silently drops anything it cannot read, so the
  // charset is checked first — otherwise a key with a stray character decodes to
  // the right length and passes.
  if (!URL_SAFE_BASE64.test(value) || Buffer.from(value, "base64url").length !== bytes) {
    throw new ConfigurationError(
      `${name} is not a VAPID key: it must be url-safe base64, unpadded, and ${String(bytes)} bytes when decoded. Generate a pair with \`npx web-push generate-vapid-keys\` and copy it whole.`,
    );
  }
}

/**
 * The right length is not the same as a real key.
 *
 * A public key is a point on the P-256 curve, and one mistyped character leaves
 * one that is still 65 bytes and still url-safe base64 — so every check above
 * passes it, `/push/key` serves it, and the only thing that ever objects is the
 * push service on the device itself, at the last step of a subscription, with
 * an error the page had no reason to be holding on to.
 *
 * `setPublicKey` refuses a point that is not on the curve, which is exactly the
 * question, and it asks it at config load where every other misconfiguration is
 * already answered.
 */
function assertVapidPublicKeyIsOnCurve(value: string): void {
  try {
    ECDH.convertKey(value, "prime256v1", "base64url", "base64url", "uncompressed");
  } catch {
    throw new ConfigurationError(
      "NOCTIS_VAPID_PUBLIC_KEY is the right length but is not a point on the P-256 curve, which means a character is wrong. Re-copy the pair from `npx web-push generate-vapid-keys`; a public key that does not belong to the private key beside it fails only on the device, never here.",
    );
  }
}

function parseVapid(env: Readonly<Record<string, string | undefined>>): VapidKeys | undefined {
  const keys = ["NOCTIS_VAPID_PUBLIC_KEY", "NOCTIS_VAPID_PRIVATE_KEY", "NOCTIS_VAPID_SUBJECT"];
  const present = keys.filter((key) => (env[key]?.trim() ?? "") !== "");

  if (present.length === 0) {
    return undefined;
  }

  if (present.length !== keys.length) {
    throw new ConfigurationError(
      `Web push needs all three of ${keys.join(", ")} or none of them. Missing: ${keys
        .filter((key) => !present.includes(key))
        .join(", ")}. Generate a pair with \`npx web-push generate-vapid-keys\`.`,
    );
  }

  const subject = required(env, "NOCTIS_VAPID_SUBJECT");

  // `web-push` signs the VAPID JWT with this as the `sub` claim, and push
  // services reject anything that is not a mailto: or https: URL — at delivery
  // time, silently, long after the core started.
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new ConfigurationError(
      "NOCTIS_VAPID_SUBJECT must be a mailto: or https:// URL, for example mailto:you@example.com",
    );
  }

  const publicKey = required(env, "NOCTIS_VAPID_PUBLIC_KEY");
  const privateKey = required(env, "NOCTIS_VAPID_PRIVATE_KEY");

  assertVapidKey("NOCTIS_VAPID_PUBLIC_KEY", publicKey, 65);
  assertVapidPublicKeyIsOnCurve(publicKey);
  assertVapidKey("NOCTIS_VAPID_PRIVATE_KEY", privateKey, 32);

  return { publicKey, privateKey, subject };
}

const RemoteDesktopTargetsSchema = z
  .array(
    z
      .object({
        host: RemoteHostNameSchema,
        gatewayUrl: z.url({ protocol: /^wss$/ }),
        destination: z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/),
      })
      .strict(),
  )
  .min(1)
  .refine((targets) => new Set(targets.map((target) => target.host)).size === targets.length, {
    message: "host names must be unique",
  });

const REMOTE_TARGETS_EXAMPLE =
  '[{"host":"zarrarpc","gatewayUrl":"wss://zarrarpc.tail9594ed.ts.net/jet/rdp","destination":"zarrarpc.tail9594ed.ts.net:3389"}]';

/**
 * Both variables or neither, as with VAPID: an allowlist with no key could
 * never sign, and a key with no allowlist has nowhere to send anyone.
 *
 * The key is checked for the one thing the Gateway will need of it — an RSA
 * private key big enough for RS256 — here, at load, so a public key pasted
 * into the wrong file is a `ConfigurationError` today rather than a 403 from
 * the Gateway on the first connect. Refusals name the variable and the file,
 * never the key's contents.
 */
function parseRemoteDesktop(
  env: Readonly<Record<string, string | undefined>>,
): RemoteDesktopConfig | undefined {
  const rawTargets = env.NOCTIS_REMOTE_DESKTOPS?.trim() ?? "";
  const keyFile = env.NOCTIS_GATEWAY_PROVISIONER_KEY_FILE?.trim() ?? "";

  if (rawTargets === "" && keyFile === "") {
    return undefined;
  }

  if (rawTargets === "" || keyFile === "") {
    throw new ConfigurationError(
      `The remote desktop needs both NOCTIS_REMOTE_DESKTOPS and NOCTIS_GATEWAY_PROVISIONER_KEY_FILE, or neither. Missing: ${
        rawTargets === "" ? "NOCTIS_REMOTE_DESKTOPS" : "NOCTIS_GATEWAY_PROVISIONER_KEY_FILE"
      }.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(rawTargets) as unknown;
  } catch {
    json = undefined;
  }

  const targets = RemoteDesktopTargetsSchema.safeParse(json);

  if (!targets.success) {
    throw new ConfigurationError(
      `NOCTIS_REMOTE_DESKTOPS must be a JSON array of unique {host, gatewayUrl, destination}, with a bare lowercase host name, a wss:// gatewayUrl and a host:port destination, for example ${REMOTE_TARGETS_EXAMPLE}`,
    );
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(readFileSync(resolve(keyFile)));
  } catch {
    throw new ConfigurationError(
      `NOCTIS_GATEWAY_PROVISIONER_KEY_FILE is not a readable PEM private key: ${resolve(keyFile)}`,
    );
  }

  if (
    privateKey.asymmetricKeyType !== "rsa" ||
    (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new ConfigurationError(
      `NOCTIS_GATEWAY_PROVISIONER_KEY_FILE must be an RSA private key of at least 2048 bits, which is what the Gateway's RS256 tokens are signed with: ${resolve(keyFile)}`,
    );
  }

  return { targets: targets.data, privateKey };
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
  const vapid = parseVapid(env);
  const remoteDesktop = parseRemoteDesktop(env);
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
    ...(vapid === undefined ? {} : { vapid }),
    ...(remoteDesktop === undefined ? {} : { remoteDesktop }),
  };
}
