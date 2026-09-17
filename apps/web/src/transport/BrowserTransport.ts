import type {
  CoreMethod,
  CoreResponse,
  CoreTransport,
  SubscribeOptions,
  Subscription,
} from "./CoreTransport.js";
import { headerSafeFilename, isEvent, parseCoreBody, resolveCoreUrl } from "./CoreTransport.js";

/** The core caps a page at 500 (`MAX_PAGE_SIZE`); asking for more is a 400. */
const PAGE_SIZE = 500;
const DEFAULT_POLL_INTERVAL_MS = 500;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface BrowserTransportOptions {
  baseUrl: string;
  /**
   * Development only. A page that holds the core token is a page that can leak
   * it; the packaged shell uses `TauriTransport`, where the token stays in Rust.
   */
  token: string;
  fetch?: Fetch;
  pollIntervalMs?: number;
  /** Test seam. Production waits on a timer. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Talks to the core from a browser page.
 *
 * Events arrive by polling `/events`, not over `/ws/clients`, because a browser
 * WebSocket cannot send an `Authorization` header and the client realm requires
 * one. The packaged shell has no such limit: Rust holds that socket and pushes
 * frames to `TauriTransport`.
 *
 * ponytail: polling costs one request per interval and delivers at interval
 * latency. Fine for a development page; if this ever becomes a shipped surface,
 * give the core a browser-usable credential rather than making the poll faster.
 *
 * `onFrame` is accepted and never called: `/events` is the committed ledger,
 * and token deltas are never written to it (ADR-0022). A browser page shows
 * turn items as they commit and gets live deltas only once Slice 2's SSE
 * channel exists.
 */
export class BrowserTransport implements CoreTransport {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: Fetch;
  readonly #pollIntervalMs: number;
  readonly #wait: (ms: number) => Promise<void>;

  constructor(options: BrowserTransportOptions) {
    this.#baseUrl = options.baseUrl;
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#wait =
      options.wait ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  async request(method: CoreMethod, path: string, body?: unknown): Promise<CoreResponse> {
    const url = resolveCoreUrl(this.#baseUrl, path);
    const response = await this.#fetch(url.href, {
      method,
      headers:
        body === undefined
          ? { authorization: `Bearer ${this.#token}` }
          : { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: parseCoreBody(await response.text()) };
  }

  async upload(file: File): Promise<CoreResponse> {
    const url = resolveCoreUrl(this.#baseUrl, "/attachments");
    const response = await this.#fetch(url.href, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": file.type,
        "x-noctis-filename": headerSafeFilename(file.name),
      },
      body: file,
    });

    return { status: response.status, body: parseCoreBody(await response.text()) };
  }

  subscribe(options: SubscribeOptions): Promise<Subscription> {
    let cursor = options.afterSequence;
    let stopped = false;

    const pump = async (): Promise<void> => {
      while (!stopped) {
        let response: CoreResponse;

        try {
          response = await this.request(
            "GET",
            `/events?after=${String(cursor)}&limit=${String(PAGE_SIZE)}`,
          );
        } catch (error) {
          options.onError?.(error);
          await this.#wait(this.#pollIntervalMs);
          continue;
        }

        if (response.status !== 200) {
          // Deliberately does not advance the cursor: a refused read has told
          // us nothing about what the ledger holds.
          options.onError?.(response);
          await this.#wait(this.#pollIntervalMs);
          continue;
        }

        const page = response.body as { events?: unknown; latestSequence?: unknown };
        const events = Array.isArray(page.events) ? page.events : [];

        if (typeof page.latestSequence === "number" && cursor > page.latestSequence) {
          options.onGap?.(page.latestSequence, cursor);
          cursor = page.latestSequence;
        }

        for (const candidate of events) {
          if (!isEvent(candidate) || stopped) {
            continue;
          }

          options.onEvent(candidate);
          cursor = candidate.sequence;
        }

        // A full page means the ledger has more waiting. Draining before the
        // next wait is what keeps a reconnect from taking pages × interval.
        if (events.length < PAGE_SIZE) {
          await this.#wait(this.#pollIntervalMs);
        }
      }
    };

    void pump();

    return Promise.resolve({
      close: () => {
        stopped = true;
      },
    });
  }
}
