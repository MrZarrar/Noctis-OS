import type { RuntimeAsk, RuntimeDelta, RuntimeItem } from "@noctis/contracts";

/** What a node says mid-turn. The socket hands these over; it persists none of them. */
export interface RuntimeFrameHandlers {
  onStreamItem(nodeId: string, jobId: string, sequence: number, item: RuntimeItem): void;
  onDelta(nodeId: string, jobId: string, delta: RuntimeDelta): void;
  onAsk(nodeId: string, jobId: string, ask: RuntimeAsk): void;
}

export interface RuntimeFrameHub extends RuntimeFrameHandlers {
  subscribe(handlers: Partial<RuntimeFrameHandlers>): () => void;
}

/**
 * In-process fan-out of runtime frames from the node socket to whoever records
 * or relays them (the conversation service, the live broker). Deliberately not
 * durable, like `events/broker.ts`: items are made durable by the subscriber
 * that turns them into events, and deltas are never made durable at all.
 */
export function createRuntimeFrameHub(onError?: (error: unknown) => void): RuntimeFrameHub {
  const subscribers = new Set<Partial<RuntimeFrameHandlers>>();

  function each(call: (handlers: Partial<RuntimeFrameHandlers>) => void): void {
    for (const handlers of subscribers) {
      try {
        call(handlers);
      } catch (error) {
        // One bad subscriber must not stop delivery to the rest, and must not
        // propagate into the socket handler that received the frame.
        onError?.(error);
      }
    }
  }

  return {
    onStreamItem(nodeId, jobId, sequence, item) {
      each((handlers) => handlers.onStreamItem?.(nodeId, jobId, sequence, item));
    },
    onDelta(nodeId, jobId, delta) {
      each((handlers) => handlers.onDelta?.(nodeId, jobId, delta));
    },
    onAsk(nodeId, jobId, ask) {
      each((handlers) => handlers.onAsk?.(nodeId, jobId, ask));
    },
    subscribe(handlers) {
      subscribers.add(handlers);
      return () => subscribers.delete(handlers);
    },
  };
}
