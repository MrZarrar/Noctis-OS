import type { ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { formatSseMessage, openEventStream } from "./sse.js";

function fakeResponse() {
  const chunks: string[] = [];

  const res = {
    writableEnded: false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: vi.fn(),
  } as unknown as ServerResponse;

  return { chunks, res };
}

const idleFrames = { subscribe: () => () => undefined };

function event(sequence: number) {
  return {
    sequence,
    name: "objective.created.v1",
    payload: {},
    occurredAt: "2026-09-16T00:00:00.000Z",
    streamType: "objective",
    streamId: "o1",
  } as never;
}

/** A `ServerFrame` (`packages/contracts/src/ws.ts`): the discriminant is `kind`, not `type`. */
function runtimeDelta(text: string) {
  return {
    kind: "runtime_delta",
    envelopeVersion: 1,
    threadId: "11111111-1111-1111-1111-111111111111",
    jobId: "22222222-2222-2222-2222-222222222222",
    itemId: "item-1",
    text,
  } as never;
}

function gapFrame() {
  return {
    kind: "gap",
    envelopeVersion: 1,
    fromSequence: 0,
    toSequence: 5,
  } as never;
}

describe("formatSseMessage", () => {
  it("writes an event name, a single data line, and a blank line", () => {
    expect(formatSseMessage("event", { a: 1 })).toBe('event: event\ndata: {"a":1}\n\n');
  });

  it("never emits a bare newline inside data, which would end the message early", () => {
    const message = formatSseMessage("event", { text: "one\ntwo" });

    expect(message.split("\n\n")).toHaveLength(2);
    expect(message).toContain("one\\ntwo");
  });
});

describe("openEventStream", () => {
  it("replays committed events after the cursor", () => {
    const { res, chunks } = fakeResponse();

    openEventStream(
      {
        broker: { subscribe: () => () => undefined, publish: () => undefined, listenerCount: 0 },
        readEvents: () => [event(4), event(5)],
        frames: idleFrames,
        heartbeatMs: 15_000,
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
      },
      res,
      3,
    );

    expect(chunks.join("")).toContain('"sequence":4');
    expect(chunks.join("")).toContain('"sequence":5');
  });

  it("drops a live event at or below the replayed cursor, so a client never sees one twice", () => {
    const { res, chunks } = fakeResponse();
    let publish: ((events: readonly never[]) => void) | undefined;

    openEventStream(
      {
        broker: {
          subscribe: (listener) => {
            publish = listener;
            return () => undefined;
          },
          publish: () => undefined,
          listenerCount: 0,
        },
        readEvents: () => [event(4)],
        frames: idleFrames,
        heartbeatMs: 15_000,
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
      },
      res,
      3,
    );

    const before = chunks.length;
    publish?.([event(4), event(5)]);

    expect(chunks).toHaveLength(before + 1);
    expect(chunks.at(-1)).toContain('"sequence":5');
  });

  it("delivers a runtime_delta frame under its own event name, so a client can tell the channels apart", () => {
    const { res, chunks } = fakeResponse();
    let emit: ((frame: unknown) => void) | undefined;

    openEventStream(
      {
        broker: { subscribe: () => () => undefined, publish: () => undefined, listenerCount: 0 },
        readEvents: () => [],
        frames: {
          subscribe: (listener) => {
            emit = listener as never;
            return () => undefined;
          },
        },
        heartbeatMs: 15_000,
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
      },
      res,
      0,
    );

    emit?.(runtimeDelta("hi"));

    expect(chunks.at(-1)).toContain("event: frame");
    expect(chunks.at(-1)).toContain("runtime_delta");
  });

  it("drops a non-runtime_delta frame from the live broker, since only deltas are this stream's promise", () => {
    const { res, chunks } = fakeResponse();
    let emit: ((frame: unknown) => void) | undefined;

    openEventStream(
      {
        broker: { subscribe: () => () => undefined, publish: () => undefined, listenerCount: 0 },
        readEvents: () => [],
        frames: {
          subscribe: (listener) => {
            emit = listener as never;
            return () => undefined;
          },
        },
        heartbeatMs: 15_000,
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
      },
      res,
      0,
    );

    const before = chunks.length;
    emit?.(gapFrame());

    expect(chunks).toHaveLength(before);
  });

  it("unsubscribes from both sources and stops the heartbeat when closed", () => {
    const { res } = fakeResponse();
    const stopEvents = vi.fn();
    const stopFrames = vi.fn();
    const stopHeartbeat = vi.fn();

    const close = openEventStream(
      {
        broker: { subscribe: () => stopEvents, publish: () => undefined, listenerCount: 0 },
        readEvents: () => [],
        frames: { subscribe: () => stopFrames },
        heartbeatMs: 15_000,
        setInterval: (() => 7) as never,
        clearInterval: stopHeartbeat,
      },
      res,
      0,
    );

    close();
    close();

    expect(stopEvents).toHaveBeenCalledOnce();
    expect(stopFrames).toHaveBeenCalledOnce();
    expect(stopHeartbeat).toHaveBeenCalledWith(7);
  });
});
