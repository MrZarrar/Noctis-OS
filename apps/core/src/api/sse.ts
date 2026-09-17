import type { ServerResponse } from "node:http";

import type { OrchestrationEvent, ServerFrame } from "@noctis/contracts";

import type { EventBroker } from "../events/broker.js";
import type { LiveBroker } from "../events/live.js";

/** The core caps a page at 500 (`MAX_PAGE_SIZE`); replay asks for the same. */
const REPLAY_LIMIT = 500;

/** Only the half of `LiveBroker` a stream needs, so a test can fake it in one member. */
export type FrameSource = Pick<LiveBroker, "subscribe">;

export interface StreamDeps {
  broker: EventBroker;
  readEvents: (afterSequence: number, limit: number) => readonly OrchestrationEvent[];
  frames: FrameSource;
  heartbeatMs: number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

/**
 * `JSON.stringify` escapes every newline inside the payload, so the encoded body
 * is always one line. That matters: a raw newline in a `data:` line would end the
 * SSE message early and the client would parse half a frame as a whole one.
 */
export function formatSseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * One stream carrying both channels.
 *
 * Committed events are replayed from the cursor first and deduplicated against
 * the live feed, so a client that reconnects sees every event exactly once.
 * `runtime_delta` frames are unsequenced by design (ADR-0022): they are never
 * replayed, and a client that missed one simply missed it.
 */
export function openEventStream(
  deps: StreamDeps,
  res: ServerResponse,
  afterSequence: number,
): () => void {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  // Tailscale Serve is a reverse proxy; without this it may buffer the response
  // and deliver nothing until it ends, which for a stream is never.
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();

  let highest = afterSequence;

  const write = (message: string): void => {
    if (!res.writableEnded) {
      res.write(message);
    }
  };

  for (const event of deps.readEvents(afterSequence, REPLAY_LIMIT)) {
    highest = Math.max(highest, event.sequence);
    write(formatSseMessage("event", event));
  }

  const stopEvents = deps.broker.subscribe((events) => {
    for (const event of events) {
      if (event.sequence <= highest) {
        continue;
      }

      highest = event.sequence;
      write(formatSseMessage("event", event));
    }
  });

  const stopFrames = deps.frames.subscribe((frame: ServerFrame) => {
    // Same filter `/ws/clients` applies (ws.ts): the live broker only ever
    // carries `runtime_delta` today, but forwarding every kind unfiltered
    // would tie a client's wire contract to whatever gets published on that
    // channel next, rather than to what this stream deliberately promises.
    if (frame.kind !== "runtime_delta") {
      return;
    }

    write(formatSseMessage("frame", frame));
  });

  // A comment line keeps the connection alive through a proxy that would time an
  // idle one out. Clients ignore it.
  const heartbeat = deps.setInterval(() => {
    write(": ping\n\n");
  }, deps.heartbeatMs);

  let closed = false;

  return () => {
    if (closed) {
      return;
    }

    closed = true;
    stopEvents();
    stopFrames();
    deps.clearInterval(heartbeat);

    if (!res.writableEnded) {
      res.end();
    }
  };
}
