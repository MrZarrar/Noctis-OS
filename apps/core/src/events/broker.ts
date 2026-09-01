import type { OrchestrationEvent } from "@noctis/contracts";

export type EventListener = (events: readonly OrchestrationEvent[]) => void;

export interface EventBroker {
  /** Call only with events that are already committed. */
  publish(events: readonly OrchestrationEvent[]): void;
  subscribe(listener: EventListener): () => void;
  readonly listenerCount: number;
}

export interface BrokerOptions {
  /** Reports a listener that threw. Delivery to the others continues regardless. */
  onListenerError?: (error: unknown) => void;
}

/**
 * In-process fan-out of committed events to connected clients. Deliberately not
 * durable: the ledger in `orchestration_events` is the durable copy, and a
 * client that misses a live frame resumes from its last sequence.
 */
export function createEventBroker(options: BrokerOptions = {}): EventBroker {
  const listeners = new Set<EventListener>();

  return {
    publish(events) {
      if (events.length === 0) {
        return;
      }

      for (const listener of listeners) {
        try {
          listener(events);
        } catch (error) {
          // One bad subscriber must not stop delivery to the rest, and must not
          // propagate into the command that just committed successfully.
          options.onListenerError?.(error);
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
