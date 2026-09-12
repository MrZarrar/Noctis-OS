import type { OrchestrationEvent, ServerFrame } from "@noctis/contracts";
import { ServerFrameSchema } from "@noctis/contracts";

/**
 * The one interface the workbench sees. Everything below it is a delivery
 * detail: `BrowserTransport` talks to the core directly with a token the page
 * holds, `TauriTransport` asks Rust, which holds the token the WebView must
 * never see (Section 9.2).
 */
export interface CoreTransport {
  request: (method: CoreMethod, path: string, body?: unknown) => Promise<CoreResponse>;
  subscribe: (options: SubscribeOptions) => Promise<Subscription>;
}

/** The core answers reads with GET and commands with POST. Nothing else. */
export type CoreMethod = "GET" | "POST";

export interface CoreResponse {
  status: number;
  body: unknown;
}

export interface SubscribeOptions {
  /** Resume point. The core replays committed events after this sequence. */
  afterSequence: number;
  onEvent: (event: OrchestrationEvent) => void;
  /**
   * The cursor is ahead of the core's ledger — a different database, or a
   * restored backup. Delivering nothing and saying nothing would make a
   * client that can never catch up look like a quiet one.
   */
  onGap?: (fromSequence: number, toSequence: number) => void;
  onError?: (error: unknown) => void;
  /**
   * Frames that are not committed events — today only `runtime_delta`, the one
   * ephemeral channel (ADR-0022). Unsequenced, so never deduplicated or resumed;
   * a transport with no live socket simply never calls this.
   */
  onFrame?: (frame: ServerFrame) => void;
}

export interface Subscription {
  close: () => void;
}

export class CorePathRefused extends Error {}

/**
 * A core path is rooted and relative, always. The bearer token is attached by
 * whoever performs the request, so a path that can name a host is a path that
 * can send the token to that host — the one thing neither transport may do.
 */
export function assertCorePath(path: string): string {
  if (!path.startsWith("/")) {
    throw new CorePathRefused("A core path must start with /");
  }

  // `//host` and `/\host` are both read as authority-relative by URL parsers,
  // so a leading slash alone does not prove a path is same-origin.
  if (path.startsWith("//") || path.startsWith("/\\")) {
    throw new CorePathRefused("A core path may not name a host");
  }

  return path;
}

export function resolveCoreUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const resolved = new URL(assertCorePath(path), base);

  if (resolved.origin !== base.origin) {
    throw new CorePathRefused("A core path may not leave the core origin");
  }

  return resolved;
}

/**
 * The real Zod parse. Phase 4 used a structural check here because it served
 * the page as plain ES modules with no bundler; Phase 5 introduces Vite, so
 * the authoritative schema can be imported directly instead of re-approximated.
 */
export function readServerFrame(raw: string): ServerFrame | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }

  const result = ServerFrameSchema.safeParse(parsed);

  return result.success ? result.data : undefined;
}

/**
 * The core answers JSON everywhere. A body that is not JSON came from something
 * in front of it — a proxy, a captive portal — and the caller should see it
 * rather than a parse error that hides it.
 */
export function parseCoreBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function isEvent(value: unknown): value is OrchestrationEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const event = value as Partial<OrchestrationEvent>;

  return (
    typeof event.id === "string" &&
    typeof event.sequence === "number" &&
    typeof event.type === "string" &&
    typeof event.streamId === "string"
  );
}
