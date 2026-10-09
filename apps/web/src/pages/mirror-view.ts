/** The screen mirror's plain logic, kept out of the page so it can be tested without one. */

import type { CoreResponse } from "../transport/CoreTransport.js";

export type MirrorFps = 15 | 30;
export type MirrorWidth = 960 | 1280 | 1920;

export type MirrorState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "live" }
  | { phase: "locked" }
  | { phase: "not_granted" }
  | { phase: "unavailable"; message: string };

export function createMirrorDiagnostics(): {
  cancel: () => void;
  check: (
    request: (signal: AbortSignal) => Promise<CoreResponse>,
  ) => Promise<MirrorState | undefined>;
} {
  let generation = 0;
  let controller: AbortController | undefined;

  const cancel = (): void => {
    generation += 1;
    controller?.abort();
    controller = undefined;
  };

  return {
    cancel,
    async check(request) {
      cancel();
      const current = generation;
      controller = new AbortController();

      try {
        const response = await request(controller.signal);

        if (current !== generation) return undefined;

        return response.status === 200
          ? { phase: "unavailable", message: "The stream stopped. Watch again to restart it." }
          : mirrorRefusal(response.status, response.body);
      } catch {
        return current === generation
          ? { phase: "unavailable", message: "Noctis could not reach the core." }
          : undefined;
      }
    },
  };
}

export function mirrorPath(
  nodeId: string,
  fps: MirrorFps,
  width: MirrorWidth,
  probe = false,
): string {
  const query = new URLSearchParams({ node: nodeId, fps: String(fps), width: String(width) });

  if (probe) {
    query.set("probe", "1");
  }

  return `/screen/live?${query.toString()}`;
}

/** Whether the owner has let this PC be watched. Sharing its folders does not count. */
export function mirrorAllowed(
  grants: ReadonlyArray<{
    capability: string;
    revokedAt?: string | undefined;
    expiresAt?: string | undefined;
  }>,
  now: number,
): boolean {
  return grants.some(
    (grant) =>
      grant.capability === "screen.view" &&
      grant.revokedAt === undefined &&
      (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now),
  );
}

/** What the core's answer to a mirror that would not start means for the page. */
export function mirrorRefusal(status: number, body: unknown): MirrorState {
  if (status === 423) {
    return { phase: "locked" };
  }

  if (status === 403) {
    return { phase: "not_granted" };
  }

  const message =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error?: { message?: unknown } }).error?.message
      : undefined;

  return {
    phase: "unavailable",
    message:
      typeof message === "string"
        ? message
        : `The core could not start the mirror (HTTP ${String(status)}).`,
  };
}
