import type { CoreMethod, CoreResponse } from "../transport/CoreTransport.js";

/**
 * One slice of LARP mode's fictional core: the Vault, Health, Files and so on.
 *
 * `DemoTransport` asks each area in turn and takes the first answer, so an
 * area returns `undefined` for any path it does not own. Areas keep their
 * state in memory only: LARP mode writes nothing anywhere.
 */
export interface LarpArea {
  request?: (method: CoreMethod, path: string, body: unknown) => CoreResponse | undefined;
  /** A URL for `<img src>` and friends, for the core paths this area serves. */
  contentUrl?: (path: string) => string | undefined;
}

export const ok = (body: unknown): CoreResponse => ({ status: 200, body });

/**
 * The day the fixtures were written about. Every fixture timestamp is moved by
 * whole days so this day reads as today, which keeps "2 hours ago" and a glucose
 * day's midnight both true whenever the owner films.
 */
export const LARP_ANCHOR_DAY = "2026-10-22";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function rebase<T>(value: T, now: Date = new Date()): T {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const shift = today - Date.parse(`${LARP_ANCHOR_DAY}T00:00:00Z`);
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return ISO.test(node) ? new Date(Date.parse(node) + shift).toISOString() : node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    }
    return node;
  };

  return walk(value) as T;
}

/** Splits `/a/b?x=1` into its segments and its query. */
export function parsePath(path: string): { segments: string[]; query: URLSearchParams } {
  const url = new URL(path, "http://larp.invalid");

  return {
    segments: url.pathname
      .split("/")
      .filter((segment) => segment !== "")
      .map(decodeURIComponent),
    query: url.searchParams,
  };
}
