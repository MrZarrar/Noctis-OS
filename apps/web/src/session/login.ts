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
