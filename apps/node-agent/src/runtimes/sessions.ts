import type { RuntimeTurnPayload } from "@noctis/contracts";

import type { ResolvedRoots } from "./Runtime.js";

/** A runtime process kept open for one thread between its turns. */
export interface LiveProcess {
  /** What the process was opened with. A turn that needs anything else reopens it. */
  readonly key: string;
  /** The session the runtime reported, once it has. */
  sessionRef: string | undefined;
  readonly alive: boolean;
  close(): void;
}

/** Long enough to cover reading a reply and typing the next one; short enough not to hoard memory. */
export const RUNTIME_IDLE_MS = 10 * 60_000;

/** Everything a process is opened with that a later turn could ask for differently. */
export function processKey(payload: RuntimeTurnPayload, roots: ResolvedRoots): string {
  return JSON.stringify([payload.model.model, roots.cwd, roots.writable, roots.readable]);
}

export interface ProcessPool<P extends LiveProcess> {
  run<T>(
    threadId: string,
    want: { key: string; sessionRef: string | undefined },
    open: () => P,
    turn: (process: P) => Promise<T>,
  ): Promise<T>;
  closeAll(): void;
}

/**
 * One live process per thread. A turn reuses it only when it is alive, was opened
 * the same way, and holds the session the core names; otherwise it is closed and
 * a new one is opened, which resumes `sessionRef` exactly as a cold turn would.
 * A thread's turns run one at a time, and a process idle for `idleMs` is closed.
 */
export function createProcessPool<P extends LiveProcess>(idleMs = RUNTIME_IDLE_MS): ProcessPool<P> {
  const live = new Map<string, P>();
  const timers = new Map<string, NodeJS.Timeout>();
  const queues = new Map<string, Promise<unknown>>();

  function retire(threadId: string): void {
    clearTimeout(timers.get(threadId));
    timers.delete(threadId);
    live.get(threadId)?.close();
    live.delete(threadId);
  }

  async function runNow<T>(
    threadId: string,
    want: { key: string; sessionRef: string | undefined },
    open: () => P,
    turn: (process: P) => Promise<T>,
  ): Promise<T> {
    clearTimeout(timers.get(threadId));
    timers.delete(threadId);

    let current = live.get(threadId);

    // A process the core names no session for is carrying context the core does not know about.
    if (
      current === undefined ||
      !current.alive ||
      current.key !== want.key ||
      want.sessionRef === undefined ||
      current.sessionRef !== want.sessionRef
    ) {
      retire(threadId);
      current = open();
      live.set(threadId, current);
    }

    try {
      return await turn(current);
    } finally {
      if (live.get(threadId) === current) {
        if (current.alive) {
          const timer = setTimeout(() => retire(threadId), idleMs);

          timer.unref();
          timers.set(threadId, timer);
        } else {
          live.delete(threadId);
        }
      }
    }
  }

  return {
    run(threadId, want, open, turn) {
      const prior = queues.get(threadId) ?? Promise.resolve();
      const next = prior.then(
        () => runNow(threadId, want, open, turn),
        () => runNow(threadId, want, open, turn),
      );
      const forget = (): void => {
        if (queues.get(threadId) === next) {
          queues.delete(threadId);
        }
      };

      queues.set(threadId, next);
      next.then(forget, forget);

      return next;
    },
    closeAll() {
      for (const threadId of [...live.keys()]) {
        retire(threadId);
      }
    },
  };
}
