import { parseCoreBody, resolveCoreUrl } from "../transport/CoreTransport.js";

type Fetch = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number; text: () => Promise<string> }>;

export class LoginRefused extends Error {}

/**
 * The token leaves the page exactly once, in a request body — never in a URL,
 * where a reverse-proxy access log would keep a copy of it forever, and never
 * in `localStorage`, a cookie, or any other place script can read it back.
 *
 * `credentials: "include"` is what lets the browser store the `Set-Cookie` the
 * core answers with. Everything after this call authenticates with that cookie
 * and the returned CSRF value; the token is never needed again.
 */
export async function login(
  baseUrl: string,
  token: string,
  fetchImpl: Fetch = (url, init) => fetch(url, init),
): Promise<{ csrf: string }> {
  const url = resolveCoreUrl(baseUrl, "/session/login");
  const response = await fetchImpl(url.href, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });

  const body = parseCoreBody(await response.text());

  if (response.status !== 200) {
    // The core says only that a login failed, so neither does this. A 403 is
    // the origin gate rather than the token, and saying which status came back
    // is the only clue that distinguishes "wrong token" from "wrong origin".
    throw new LoginRefused(
      response.status === 401
        ? "That token is not valid"
        : `The core refused the login (${String(response.status)})`,
    );
  }

  const csrf = (body as { csrf?: unknown }).csrf;

  if (typeof csrf !== "string" || csrf === "") {
    throw new LoginRefused("The core issued no csrf value, so every command would be refused");
  }

  return { csrf };
}

/**
 * The CSRF value for a session this browser already has, or `undefined`.
 *
 * The cookie lasts thirty days; the value returned by `login` lasts until the
 * page is destroyed — which iOS Safari does to a backgrounded tab within
 * minutes, and which every reload, Home Screen cold start and notification tap
 * does outright. Without this call each of those met the token prompt again,
 * with a perfectly good session sitting in the cookie jar.
 *
 * Every refusal is `undefined` rather than a throw: the one caller's next move
 * is the login screen in all of them, and a core that cannot be reached at boot
 * is not a different answer from a session that has expired.
 */
export async function resumeSession(
  baseUrl: string,
  fetchImpl: Fetch = (url, init) => fetch(url, init),
): Promise<string | undefined> {
  const url = resolveCoreUrl(baseUrl, "/session");

  try {
    const response = await fetchImpl(url.href, { method: "GET", credentials: "include" });

    if (response.status !== 200) {
      return undefined;
    }

    const csrf = (parseCoreBody(await response.text()) as { csrf?: unknown }).csrf;

    return typeof csrf === "string" && csrf !== "" ? csrf : undefined;
  } catch {
    return undefined;
  }
}
