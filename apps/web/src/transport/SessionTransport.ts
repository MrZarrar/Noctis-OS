import type {
  CoreMethod,
  CoreResponse,
  CoreTransport,
  SubscribeOptions,
  Subscription,
} from "./CoreTransport.js";
import {
  headerSafeFilename,
  isEvent,
  parseCoreBody,
  readServerFrame,
  resolveCoreUrl,
} from "./CoreTransport.js";

type Fetch = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface SessionTransportOptions {
  baseUrl: string;
  /** Returned by `login` once. Held in memory only — never a cookie, never storage. */
  csrf: string;
  fetch?: Fetch;
  EventSourceImpl?: typeof EventSource;
}

/**
 * The transport a page uses when it holds no token.
 *
 * The credential is the `HttpOnly` cookie the browser attaches on its own, so
 * script never touches it: an XSS that reads every variable in this file still
 * cannot exfiltrate a usable credential. The CSRF value it *can* read is
 * useless without the cookie, which `SameSite=Strict` will not send cross-site.
 *
 * This is also the only transport an `EventSource` can authenticate at all —
 * it cannot carry an `Authorization` header, which is why `BrowserTransport`
 * polls and this one streams.
 */
export class SessionTransport implements CoreTransport {
  readonly #baseUrl: string;
  readonly #csrf: string;
  readonly #fetch: Fetch;
  readonly #EventSourceImpl: typeof EventSource | undefined;

  constructor(options: SessionTransportOptions) {
    this.#baseUrl = options.baseUrl;
    this.#csrf = options.csrf;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    // Resolved at subscribe time, not here: `EventSource` is a browser global,
    // and reading it in the constructor would make merely building a transport
    // fail anywhere it does not exist.
    this.#EventSourceImpl = options.EventSourceImpl;
  }

  async request(method: CoreMethod, path: string, body?: unknown): Promise<CoreResponse> {
    // `resolveCoreUrl` refuses a path that could name another host, so no
    // caller can talk the session cookie into leaving the core's origin.
    const url = resolveCoreUrl(this.#baseUrl, path);
    const headers: Record<string, string> = {};

    // Only on a mutation: the core's rule is that a session-authenticated
    // write needs a header a cross-site form cannot set.
    if (method !== "GET") {
      headers["x-noctis-csrf"] = this.#csrf;
    }

    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await this.#fetch(url.href, {
      method,
      credentials: "include",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: parseCoreBody(await response.text()) };
  }

  async upload(file: File): Promise<CoreResponse> {
    const url = resolveCoreUrl(this.#baseUrl, "/attachments");
    const response = await this.#fetch(url.href, {
      method: "POST",
      credentials: "include",
      headers: {
        "x-noctis-csrf": this.#csrf,
        // The file's own type, because that is what the core's allowlist is
        // checked against. An empty one is refused there rather than guessed at.
        "content-type": file.type,
        "x-noctis-filename": headerSafeFilename(file.name),
      },
      body: file,
    });

    return { status: response.status, body: parseCoreBody(await response.text()) };
  }

  subscribe(options: SubscribeOptions): Promise<Subscription> {
    const url = resolveCoreUrl(this.#baseUrl, "/events/live");
    url.searchParams.set("afterSequence", String(options.afterSequence));

    const Impl = this.#EventSourceImpl ?? EventSource;
    const source = new Impl(url.href, { withCredentials: true });

    source.addEventListener("event", (message) => {
      const parsed = parseCoreBody((message as MessageEvent<string>).data);

      if (isEvent(parsed)) {
        options.onEvent(parsed);
      }
    });

    source.addEventListener("frame", (message) => {
      const frame = readServerFrame((message as MessageEvent<string>).data);

      if (frame === undefined) {
        return;
      }

      // A gap is not something the page draws — it means this client's cursor
      // is ahead of the core's ledger and can never catch up. It goes to the
      // one caller that can act on it rather than down the frame channel,
      // where every consumer would have to learn a kind it has no use for.
      if (frame.kind === "gap") {
        options.onGap?.(frame.fromSequence, frame.toSequence);
        return;
      }

      options.onFrame?.(frame);
    });

    source.onerror = (error) => {
      // The browser reconnects an EventSource on its own and resumes from the
      // cursor in the URL, so this reports the interruption rather than tearing
      // the subscription down.
      options.onError?.(error);
    };

    return Promise.resolve({
      close: () => {
        source.close();
      },
    });
  }
}
