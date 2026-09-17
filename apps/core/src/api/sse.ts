import type { ServerResponse } from "node:http";

import type { OrchestrationEvent, ServerFrame } from "@noctis/contracts";
import { ENVELOPE_VERSION } from "@noctis/contracts";

import type { EventBroker } from "../events/broker.js";
import type { LiveBroker } from "../events/live.js";

/**
 * The read API's own page size (`readEventsAfter` / `MAX_PAGE_SIZE`). Replay
 * pages through it in a loop — see the loop below — rather than truncating at
 * one page, which is what this stream used to do. `/ws/clients`'s `startStream`
 * (`ws.ts`) runs the same paging loop and always has; saying otherwise here
 * would eventually get the correct half "fixed" to match the broken one.
 */
const REPLAY_PAGE_SIZE = 500;

/** Only the half of `LiveBroker` a stream needs, so a test can fake it in one member. */
export type FrameSource = Pick<LiveBroker, "subscribe">;

export interface StreamDeps {
  broker: EventBroker;
  readEvents: (afterSequence: number, limit: number) => readonly OrchestrationEvent[];
  /** The highest committed sequence, for clamping a cursor the caller could not have. */
  latestSequence: () => number;
  frames: FrameSource;
  /**
   * Whether the credential that opened this stream is still good, asked once
   * per heartbeat.
   *
   * The gate in `http.ts` runs once, at connect; after it the stream holds a
   * broker subscription for the life of the TCP connection, and the heartbeat
   * below keeps that connection alive through a proxy indefinitely. So a
   * `revokeSession` deleted the row and the open stream carried on delivering
   * the entire event ledger to it until the core restarted, and an expiring
   * session did the same. A bearer stream passes `() => true`: its credential
   * is the configured token, which cannot be revoked without a restart anyway.
   */
  stillAuthorized: () => boolean;
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
 *
 * Mirrors `/ws/clients`'s `startStream` (`ws.ts`) in both of the ways that
 * matter for two transports reading one ledger: a cursor ahead of the ledger
 * is clamped and announced with a `gap` frame rather than silently resumed
 * from nowhere, and replay pages through every page instead of truncating at
 * one.
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

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopEvents: (() => void) | undefined;
  let stopFrames: (() => void) | undefined;

  const write = (message: string): void => {
    if (res.writableEnded || res.destroyed) {
      return;
    }

    // ponytail: `res.write`'s return value is ignored, so a client that is not
    // reading — a phone on a bad link, mid a fast-streaming turn — buffers
    // deltas without bound instead of being shed. `/ws/clients` has a real
    // answer to this (`MAX_BUFFERED_BYTES`, `ws.bufferedAmount`); an HTTP
    // response has no equivalent counter to read synchronously. Upgrade by
    // dropping `runtime_delta` frames (never committed events, so nothing is
    // lost that matters) while `res.writableNeedDrain` is true, or by pausing
    // `stopFrames`'s subscription until the response's `drain` event fires.
    res.write(message);
  };

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    stopEvents?.();
    stopFrames?.();

    if (heartbeat !== undefined) {
      deps.clearInterval(heartbeat);
    }

    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  };

  try {
    let highest = afterSequence;
    let cursor = afterSequence;
    const latest = deps.latestSequence();

    if (afterSequence > latest) {
      // The client's cursor is ahead of the ledger: a different database, or a
      // restored backup. Say so rather than silently resuming from nowhere —
      // same call `ws.ts`'s `startStream` makes, down the `frame` channel
      // since SSE has no separate envelope per message kind.
      write(
        formatSseMessage("frame", {
          kind: "gap",
          envelopeVersion: ENVELOPE_VERSION,
          fromSequence: latest,
          toSequence: afterSequence,
        } satisfies ServerFrame),
      );
      highest = latest;
      cursor = latest;
    }

    // Page through every page, not just the first: a client far enough behind
    // has more committed events than one page holds, and each of those events
    // is already committed, so the broker below will never republish it. A
    // single-page read would truncate replay and leave a permanent hole.
    for (;;) {
      const page = deps.readEvents(cursor, REPLAY_PAGE_SIZE);

      if (page.length === 0) {
        break;
      }

      for (const event of page) {
        highest = Math.max(highest, event.sequence);
        write(formatSseMessage("event", event));
      }

      cursor = page[page.length - 1]?.sequence ?? cursor;

      if (page.length < REPLAY_PAGE_SIZE) {
        break;
      }
    }

    // Read then subscribe — the opposite order from `ws.ts`'s `startStream`,
    // which subscribes first and buffers live events until its backfill is
    // sent. That ordering is safe here for the same reason it is only an
    // optimisation there: `readEvents` (`node:sqlite`) and this call are both
    // synchronous, and nothing above awaits, so nothing can commit in the gap
    // between the last page read and the subscribe call below. If either
    // becomes async, subscribe first and hold live events aside, the way
    // `startStream` does, or an event committed in that window is lost
    // forever rather than merely delayed.
    stopEvents = deps.broker.subscribe((events) => {
      for (const event of events) {
        if (event.sequence <= highest) {
          continue;
        }

        highest = event.sequence;
        write(formatSseMessage("event", event));
      }
    });

    stopFrames = deps.frames.subscribe((frame: ServerFrame) => {
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
    //
    // And the same tick re-checks the credential, because the thing keeping the
    // connection alive is the only thing that runs on it: a stream nobody
    // re-authenticates outlives the session that opened it. The client's own
    // `EventSource` reconnects on its own, so a stream closed here becomes a
    // fresh connect attempt that meets the gate in `http.ts` and is refused.
    heartbeat = deps.setInterval(() => {
      if (!deps.stillAuthorized()) {
        close();
        return;
      }

      write(": ping\n\n");
    }, deps.heartbeatMs);
  } catch (error) {
    // Headers are already flushed by the time anything here can throw (a
    // `readEvents` row that fails its Zod parse, most plausibly), so the
    // caller's error handler cannot send a response any more. The best this
    // function can still do is release whatever it already subscribed and
    // close the connection, rather than leak a subscription or a listener
    // for the life of the process.
    close();
    throw error;
  }

  return close;
}
