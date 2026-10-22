import type {
  CoreMethod,
  CoreResponse,
  CoreTransport,
  SubscribeOptions,
  Subscription,
} from "../transport/CoreTransport.js";
import { assertCorePath } from "../transport/CoreTransport.js";
import type { LarpArea } from "./area.js";
import { createLarpCore, type LarpCoreOptions } from "./core.js";

export interface DemoTransportOptions extends LarpCoreOptions {
  /** The fixture areas, tried in order after the conversation core. */
  areas?: readonly LarpArea[];
  /** Milliseconds each answer takes. Absent is a believable LAN delay; tests pass 0. */
  latencyMs?: number;
}

/**
 * LARP mode's transport: a whole fictional core in the page.
 *
 * Every page already reaches the core through `CoreTransport`, so swapping
 * this in is the entire switch. Nothing it does leaves the page: no fetch, no
 * socket, no storage. A path no area answers is a 404, as it would be from a
 * core that does not have that route.
 */
export class DemoTransport implements CoreTransport {
  readonly #core;
  readonly #areas: readonly LarpArea[];
  readonly #latencyMs: number | undefined;
  /** Controls the Settings page offers while filming. */
  readonly larp: { raiseApprovalIn: (ms: number) => void; raiseBannerIn: (ms: number) => void };

  constructor(options: DemoTransportOptions = {}) {
    this.#core = createLarpCore(options);
    this.#areas = options.areas ?? [];
    this.#latencyMs = options.latencyMs;
    this.larp = {
      raiseApprovalIn: this.#core.raiseApprovalIn,
      raiseBannerIn: this.#core.raiseBannerIn,
    };
  }

  request(method: CoreMethod, path: string, body?: unknown): Promise<CoreResponse> {
    assertCorePath(path);
    const answer =
      this.#core.request(method, path, body) ??
      this.#areas.reduce<CoreResponse | undefined>(
        (found, area) => found ?? area.request?.(method, path, body),
        undefined,
      ) ??
      ({
        status: 404,
        body: { error: { code: "not_found", message: "No such resource" } },
      } as const);

    // A beat of latency, as a real core over the LAN has: a page that renders
    // in the same tick it asked looks wrong on camera.
    const copy = structuredClone(answer);
    if (this.#latencyMs === 0) return Promise.resolve(copy);
    return new Promise((resolve) => {
      setTimeout(() => resolve(copy), this.#latencyMs ?? 40 + Math.random() * 80);
    });
  }

  subscribe(options: SubscribeOptions): Promise<Subscription> {
    const close = this.#core.subscribe(options);
    return Promise.resolve({ close });
  }

  contentUrl(path: string): string {
    for (const area of this.#areas) {
      const url = area.contentUrl?.(path);
      if (url !== undefined) return url;
    }
    // An empty image rather than a request the page would send to the core.
    return "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  }
}
