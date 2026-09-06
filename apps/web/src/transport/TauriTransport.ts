import type {
  CoreMethod,
  CoreResponse,
  CoreTransport,
  SubscribeOptions,
  Subscription,
} from "./CoreTransport.js";
import { assertCorePath, parseCoreBody, readServerFrame } from "./CoreTransport.js";

/** The Tauri event the Rust client socket forwards raw server frames on. */
export const FRAME_EVENT = "core:frame";

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type Unlisten = () => void;
export type Listen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<Unlisten>;

export interface TauriTransportOptions {
  invoke: Invoke;
  listen: Listen;
}

interface ProxyResponse {
  status: number;
  /** The core's body verbatim. Rust is a pipe, not a parser. */
  body: string;
}

/**
 * Talks to the core through Rust.
 *
 * The WebView never sees the core token and never opens a socket: it names a
 * method and a rooted path, and the shell decides whether that is a request it
 * is willing to sign (Section 9.2).
 */
export class TauriTransport implements CoreTransport {
  readonly #invoke: Invoke;
  readonly #listen: Listen;

  constructor(options: TauriTransportOptions) {
    this.#invoke = options.invoke;
    this.#listen = options.listen;
  }

  async request(method: CoreMethod, path: string, body?: unknown): Promise<CoreResponse> {
    // Refused here as well as in Rust. Rust's check is the one that protects the
    // token; this one keeps a page from believing a cross-origin call was made.
    assertCorePath(path);

    const response = (await this.#invoke("core_request", {
      method,
      path,
      body: body === undefined ? null : body,
    })) as ProxyResponse;

    return { status: response.status, body: parseCoreBody(response.body) };
  }

  async subscribe(options: SubscribeOptions): Promise<Subscription> {
    let delivered = options.afterSequence;

    // Listen first. Rust starts sending the moment `core_subscribe` returns, and
    // a frame that arrives before the listener exists is simply lost.
    const unlisten = await this.#listen(FRAME_EVENT, ({ payload }) => {
      if (typeof payload !== "string") {
        options.onError?.(payload);
        return;
      }

      const frame = readServerFrame(payload);

      if (frame === undefined) {
        options.onError?.(payload);
        return;
      }

      if (frame.kind === "gap") {
        options.onGap?.(frame.fromSequence, frame.toSequence);
        delivered = frame.fromSequence;
        return;
      }

      // A reconnect resumes from the cursor Rust holds, which can be behind
      // this one for frames already handed over.
      if (frame.event.sequence <= delivered) {
        return;
      }

      delivered = frame.event.sequence;
      options.onEvent(frame.event);
    });

    await this.#invoke("core_subscribe", { afterSequence: options.afterSequence });

    return {
      close: () => {
        unlisten();
        void this.#invoke("core_unsubscribe");
      },
    };
  }
}

interface TauriGlobal {
  core: { invoke: Invoke };
  event: { listen: Listen };
}

/**
 * Reads the transport off the `withGlobalTauri` bridge. Phase 4 serves the page
 * as plain ES modules with no bundler, so `@tauri-apps/api` is not importable —
 * and not depending on it is one fewer thing between the page and the shell.
 */
export function tauriTransportFromGlobal(scope: unknown = globalThis): TauriTransport | undefined {
  const bridge = (scope as { __TAURI__?: TauriGlobal }).__TAURI__;

  return bridge === undefined
    ? undefined
    : new TauriTransport({ invoke: bridge.core.invoke, listen: bridge.event.listen });
}
