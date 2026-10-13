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
/** `EventSource.CLOSED`, spelled out so a test's stand-in need not carry the constant. */
const CLOSED = 2;
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 15_000;
/** How long the stream may be down before the page is told; a blip is not news. */
const OUTAGE_REPORT_MS = 30_000;

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

  async request(
    method: CoreMethod,
    path: string,
    body?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<CoreResponse> {
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
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      credentials: "include",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: parseCoreBody(await response.text()) };
  }

  /** The browser attaches the session cookie to an `<img>` on the core's origin by itself. */
  contentUrl(path: string): string {
    return resolveCoreUrl(this.#baseUrl, path).href;
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

  /**
   * The live stream, kept alive. The browser retries a dropped EventSource by
   * itself, but gives up for good on a response it cannot read (a proxy's 502
   * while the core restarts), after which the page would never hear another
   * event. So a stream the browser has given up on is reopened here, from the
   * last event it delivered, and only an outage that lasts is reported.
   */
  subscribe(options: SubscribeOptions): Promise<Subscription> {
    const Impl = this.#EventSourceImpl ?? EventSource;
    let cursor = options.afterSequence;
    let source: EventSource | undefined;
    let closed = false;
    let retryMs = RETRY_FIRST_MS;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let outage: ReturnType<typeof setTimeout> | undefined;

    const connected = (): void => {
      retryMs = RETRY_FIRST_MS;
      clearTimeout(outage);
      outage = undefined;
    };

    const connect = (): void => {
      const url = resolveCoreUrl(this.#baseUrl, "/events/live");
      url.searchParams.set("afterSequence", String(cursor));

      const current = new Impl(url.href, { withCredentials: true });
      source = current;

      current.onopen = connected;
      current.addEventListener("event", (message) => {
        const parsed = parseCoreBody((message as MessageEvent<string>).data);

        if (isEvent(parsed)) {
          cursor = Math.max(cursor, parsed.sequence);
          connected();
          options.onEvent(parsed);
        }
      });

      current.addEventListener("frame", (message) => {
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

      current.onerror = (error) => {
        outage ??= setTimeout(() => {
          options.onError?.(error);
        }, OUTAGE_REPORT_MS);

        // Still connecting means the browser is retrying; closed means it gave up.
        if (current.readyState === CLOSED && !closed) {
          current.close();
          retry = setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        }
      };
    };

    connect();

    return Promise.resolve({
      close: () => {
        closed = true;
        clearTimeout(retry);
        clearTimeout(outage);
        source?.close();
      },
    });
  }
}
