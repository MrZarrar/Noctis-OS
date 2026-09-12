import type { ServerFrame } from "@noctis/contracts";

export type LiveListener = (frame: ServerFrame) => void;

/**
 * The one ephemeral channel (ADR-0022). Token deltas travel node -> here ->
 * every streaming client, and are never written to `orchestration_events`. A
 * client that missed one has the completed message; there is nothing to replay.
 */
export interface LiveBroker {
  publish(frame: ServerFrame): void;
  subscribe(listener: LiveListener): () => void;
  readonly listenerCount: number;
}

export function createLiveBroker(onListenerError?: (error: unknown) => void): LiveBroker {
  const listeners = new Set<LiveListener>();

  return {
    publish(frame) {
      for (const listener of listeners) {
        try {
          listener(frame);
        } catch (error) {
          // Same isolation as events/broker.ts: one bad socket must not stop
          // delivery to the rest, nor propagate into the node frame handler.
          onListenerError?.(error);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}
