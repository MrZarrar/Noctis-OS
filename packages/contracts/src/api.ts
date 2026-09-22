/**
 * Every first path segment the core's HTTP API answers.
 *
 * One list, because three hand-maintained copies of it caused three separate
 * incidents. `apps/core/src/api/static.ts` consults it to decide whether a
 * request is API or page — and since static serving runs *before* the
 * credential gate, a segment missing there does not merely serve index.html
 * instead of JSON, it turns an unauthenticated 401 into a 200. `GET /push/key`
 * was exposed that way. `apps/web/vite.config.ts` builds its dev proxy from the
 * same list and was already out of step: it omitted `node` and `session`, which
 * silently disabled session resume behind `vite dev`.
 *
 * A segment belongs here the moment any route in `handleRequest`/`handleRead`
 * answers on it. Adding one is safe; omitting one is not.
 *
 * ponytail: a list maintained beside the routes rather than derived from them.
 * The ceiling is that nothing fails when a new collection is added to
 * `handleRead` and not named here — the sharper guard would be a route table
 * `handleRead` is generated from. Upgrade path is exactly that, and it is a
 * larger change than the bug it would prevent has so far been worth.
 *
 * The second ceiling points the other way and is unchanged by centralising:
 * a *client* route whose first segment is named here never reaches the SPA
 * fallback, because the credential gate claims it first. Four rail destinations
 * collide today (missions, artifacts, vault, nodes), so the day `apps/web`
 * grows a router, deep-linking to `/missions` answers 401. Upgrade path: prefix
 * the API (`/api/...`) or the client routes, so the namespaces stop overlapping.
 */
export const API_SEGMENTS = [
  "approvals",
  "artifacts",
  "attachments",
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
  "push",
  "ready",
  "remote",
  "session",
  "sources",
  "threads",
  "turns",
  "vault",
  "ws",
] as const;

/**
 * The same set as a path matcher, for Vite's dev and preview proxy.
 *
 * The trailing group must accept `?`: Vite matches against `req.url`, which
 * carries the query string, so a pattern anchored on `/` or end-of-string alone
 * misses `/objectives?limit=25` — and a missed core path is answered with the
 * SPA's index.html and a 200, which is far harder to spot than a 404.
 */
export const CORE_PATH_PATTERN = new RegExp(`^/(${API_SEGMENTS.join("|")})(/|\\?|$)`);
