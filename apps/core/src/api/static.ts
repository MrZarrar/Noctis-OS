import { readFile, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Serving the built page from the core, for the one deployment where it has to
 * be: `tailscale serve` maps the whole tailnet hostname to a single port, so a
 * phone opening that URL reaches the core and nothing else. Serving the page
 * from a second origin is not an alternative — ADR-0028's session cookie is
 * `SameSite=Strict`, and a page on another origin would never get it attached.
 *
 * Unauthenticated on purpose: these bytes are the login screen and the code
 * that draws it, they carry no user data, and the tailnet is the boundary. A
 * page that could not load before it had a session could never obtain one.
 */

/**
 * Every first path segment an API route answers. Static is consulted only for
 * paths outside this set, which is what makes it a last resort by path rather
 * than by position — it has to run before the credential gate, since the login
 * screen loads before there is a session to check.
 *
 * ponytail: hand-maintained, and a new top-level collection added to
 * `handleRead` must be added here too or the SPA fallback will answer it with
 * index.html. The same list already exists as `CORE_PATHS` in
 * `apps/web/vite.config.ts`. Upgrade path: make `handleRead`'s routes a table
 * and derive both from it.
 */
const API_SEGMENTS = new Set([
  "approvals",
  "artifacts",
  "commands",
  "diagnostics",
  "events",
  "health",
  "identities",
  "jobs",
  "missions",
  "models",
  "node",
  "nodes",
  "objectives",
  "permissions",
  "ready",
  "session",
  "sources",
  "threads",
  "turns",
  "vault",
  "ws",
]);

export function isApiPath(pathname: string): boolean {
  return API_SEGMENTS.has(pathname.split("/")[1] ?? "");
}

/**
 * A conservative allowlist. Anything not named here is `application/octet-stream`
 * rather than a guess: a wrong type on a script or a document is how a stored
 * file becomes executable content in someone's browser.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function contentTypeFor(pathname: string): string {
  return CONTENT_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

/** True when `candidate` is `root` itself or beneath it, decided lexically. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);

  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The path a request names, or `undefined` when it names nothing inside the
 * root. The check is on the *resolved* path, never on the spelling: `..`,
 * `%2e%2e`, a doubled slash and an absolute path all normalise to something
 * `isInside` can answer, while a string filter has to anticipate each of them.
 */
function candidateFor(root: string, pathname: string): string | undefined {
  let decoded: string;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is not a path any built page emits.
    return undefined;
  }

  if (decoded.includes("\0")) {
    return undefined;
  }

  const candidate = resolve(root, `.${decoded.startsWith("/") ? "" : "/"}${decoded}`);

  return isInside(root, candidate) ? candidate : undefined;
}

/**
 * Reads a file, or `undefined` for anything that is not one inside the root.
 *
 * `realpath` is what makes the symlink case safe: the lexical check above
 * cannot see that `/escape/secret.txt` leaves the root, because every segment
 * of it is innocent until the link is followed.
 */
async function readWithin(root: string, candidate: string): Promise<Buffer | undefined> {
  try {
    const real = await realpath(candidate);

    if (!isInside(await realpath(root), real)) {
      return undefined;
    }

    if (!(await stat(real)).isFile()) {
      return undefined;
    }

    // ponytail: the whole file into memory, because a built workbench is a few
    // hundred kilobytes. Upgrade to `createReadStream().pipe(res)` if anything
    // large — a video, a model — ever lands in the web root.
    return await readFile(real);
  } catch {
    return undefined;
  }
}

/**
 * A path with no extension on its last segment is a client route. A path with
 * one named a file, and if that file is gone it must 404: answering
 * `/assets/app.js` with index.html would serve HTML as JavaScript, which breaks
 * module loading in a way that reads as a syntax error in nobody's source.
 *
 * A trailing slash names a directory, not a route, so a directory with no
 * index.html is a 404 rather than the app shell under a misleading URL.
 */
function looksLikeRoute(pathname: string): boolean {
  return extname(pathname) === "" && !pathname.endsWith("/");
}

function respond(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": String(body.byteLength),
  });
  res.end(body);
}

/**
 * Answers a GET for the built page. Always answers something: this is the last
 * handler in the chain, and every refusal is a 404 — a 403 for a path outside
 * the root would confirm the root's shape to whoever probed for it.
 */
export async function serveStatic(
  root: string,
  pathname: string,
  res: ServerResponse,
): Promise<void> {
  const candidate = candidateFor(root, pathname);

  if (candidate === undefined) {
    // Outside the root. No SPA fallback here: laundering an escape attempt into
    // a 200 with the app shell would hide the attempt from every log that looks
    // at status codes.
    notFound(res);
    return;
  }

  const target = pathname.endsWith("/") ? join(candidate, "index.html") : candidate;
  const file = await readWithin(root, target);

  if (file !== undefined) {
    respond(res, 200, contentTypeFor(target), file);
    return;
  }

  if (looksLikeRoute(pathname)) {
    const index = await readWithin(root, join(root, "index.html"));

    if (index !== undefined) {
      respond(res, 200, "text/html; charset=utf-8", index);
      return;
    }
  }

  notFound(res);
}

function notFound(res: ServerResponse): void {
  respond(res, 404, "text/plain; charset=utf-8", Buffer.from("not found"));
}
