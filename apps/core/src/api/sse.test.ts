import type { ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { formatSseMessage, openEventStream } from "./sse.js";

function fakeResponse(overrides: { destroyed?: boolean } = {}) {
  const chunks: string[] = [];
  const end = vi.fn();

  const res = {
    writableEnded: false,
    destroyed: overrides.destroyed ?? false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end,
  } as unknown as ServerResponse;

  return { chunks, res, end };
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
  it("replays committed events after the cursor, paging with the cursor and limit it was given", () => {
    const { res, chunks } = fakeResponse();
    const readEvents = vi.fn(() => [event(4), event(5)]);

    openEventStream(
      {
        broker: { subscribe: () => () => undefined, publish: () => undefined, listenerCount: 0 },
        readEvents,
        latestSequence: () => 10,
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
    // Proves the cursor and page size actually reached the read, not just that
    // *some* events came back — a stub that ignores its arguments would pass
    // a version of this test that reads from the wrong place entirely.
    expect(readEvents).toHaveBeenCalledWith(3, 500);
  });

  it("pages through replay past the first page, instead of truncating at it", () => {
    const { res, chunks } = fakeResponse();
    const firstPage = Array.from({ length: 500 }, (_, index) => event(index + 1));
    const secondPage = [event(501)];
    const readEvents = vi.fn((after: number) => (after === 0 ? firstPage : secondPage));

    openEventStream(
      {
        broker: { subscribe: () => () => undefined, publish: () => undefined, listenerCount: 0 },
        readEvents,
        latestSequence: () => 501,
        frames: idleFrames,
        heartbeatMs: 15_000,
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
      },
      res,
      0,
    );

    // A full first page (exactly the page size) means there could be more:
    // the loop must ask again from where the first page left off.
    expect(readEvents).toHaveBeenNthCalledWith(1, 0, 500);
    expect(readEvents).toHaveBeenNthCalledWith(2, 500, 500);
    expect(chunks.join("")).toContain('"sequence":501');
  });

  it("clamps a cursor ahead of the ledger and announces it with a gap frame, instead of going silently quiet forever", () => {
    const { res, chunks } = fakeResponse();
    const readEvents = vi.fn(() => []);

    openEventStream(
      {
        broker: { subscribe: () => () => undefined, publish: () => undefined, listenerCount: 0 },
        readEvents,
        latestSequence: () => 5,
        frames: idleFrames,
        heartbeatMs: 15_000,
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
      },
      res,
      100,
    );

    const message = chunks.join("");
    expect(message).toContain("event: frame");
    expect(message).toContain('"kind":"gap"');
    expect(message).toContain('"fromSequence":5');
    expect(message).toContain('"toSequence":100');
    // Replay resumes from the clamped point, not from the cursor the caller
    // sent — a client whose cursor is nonsense still sees everything sane.
    expect(readEvents).toHaveBeenCalledWith(5, 500);
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
        latestSequence: () => 10,
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
        latestSequence: () => 0,
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
        latestSequence: () => 0,
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

  it("treats a destroyed response as ended, even though writableEnded lags behind it on an abort", () => {
    const { res, chunks } = fakeResponse({ destroyed: true });

    openEventStream(
      {
        broker: { subscribe: () => () => undefined, publish: () => undefined, listenerCount: 0 },
        readEvents: () => [event(4)],
        latestSequence: () => 10,
        frames: idleFrames,
        heartbeatMs: 15_000,
        setInterval: (() => 0) as never,
        clearInterval: () => undefined,
      },
      res,
      3,
    );

    expect(chunks).toHaveLength(0);
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
        latestSequence: () => 0,
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

  it("closes and rethrows, without leaking the earlier subscription, when a later subscribe throws", () => {
    const { res, end } = fakeResponse();
    const stopEvents = vi.fn();

    expect(() =>
      openEventStream(
        {
          broker: { subscribe: () => stopEvents, publish: () => undefined, listenerCount: 0 },
          readEvents: () => [],
          latestSequence: () => 0,
          frames: {
            subscribe: () => {
              throw new Error("boom");
            },
          },
          heartbeatMs: 15_000,
          setInterval: (() => 7) as never,
          clearInterval: () => undefined,
        },
        res,
        0,
      ),
    ).toThrow("boom");

    expect(stopEvents).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });
});
