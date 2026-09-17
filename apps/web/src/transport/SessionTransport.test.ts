import { beforeEach, describe, expect, it } from "vitest";

import { SessionTransport } from "./SessionTransport.js";

interface Call {
  url: string;
  init: RequestInit;
}

class FakeEventSource {
  static last: FakeEventSource | undefined;

  readonly listeners = new Map<string, (event: MessageEvent) => void>();
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly init: EventSourceInit,
  ) {
    FakeEventSource.last = this;
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(name, listener);
  }

  emit(name: string, data: unknown): void {
    this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  close(): void {
    this.closed = true;
  }
}

/** A transport wired to a fetch that records what it was asked, and a fake stream. */
function transport(): { subject: SessionTransport; calls: Call[] } {
  const calls: Call[] = [];

  return {
    calls,
    subject: new SessionTransport({
      baseUrl: "https://core.example",
      csrf: "csrf-value",
      fetch: (url, init) => {
        calls.push({ url, init });

        return Promise.resolve({ status: 200, text: () => Promise.resolve("{}") });
      },
      EventSourceImpl: FakeEventSource as never,
    }),
  };
}

/** The shape `/events/live` writes down the `event` channel: a bare event. */
const COMMITTED = {
  id: "01941f29-7c00-7000-8000-000000000010",
  sequence: 13,
  streamType: "objective",
  streamId: "01941f29-7c00-7000-8000-000000000011",
  type: "objective.created.v1",
  actorType: "user",
  actorId: "mushaf",
  payloadVersion: 1,
  payload: {},
  correlationId: "01941f29-7c00-7000-8000-000000000012",
  occurredAt: "2026-09-16T00:00:00.000Z",
};

const DELTA = {
  kind: "runtime_delta",
  envelopeVersion: 1,
  threadId: "01941f29-7c00-7000-8000-000000000020",
  jobId: "01941f29-7c00-7000-8000-000000000021",
  itemId: "item-1",
  text: "hello",
};

describe("SessionTransport", () => {
  beforeEach(() => {
    FakeEventSource.last = undefined;
  });

  it("sends the cookie and no authorization header on a read", async () => {
    const { subject, calls } = transport();
    await subject.request("GET", "/objectives");

    // The cookie is the credential and the browser attaches it: this page holds
    // no token, so there is nothing for an authorization header to carry.
    expect(calls[0]?.init.credentials).toBe("include");
    expect(JSON.stringify(calls[0]?.init.headers ?? {}).toLowerCase()).not.toContain(
      "authorization",
    );
  });

  it("adds the csrf header to a mutation and not to a read", async () => {
    const { subject, calls } = transport();

    await subject.request("GET", "/objectives");
    await subject.request("POST", "/commands/objective.create", { idempotencyKey: "k" });

    expect(JSON.stringify(calls[0]?.init.headers)).not.toContain("x-noctis-csrf");
    expect(JSON.stringify(calls[1]?.init.headers)).toContain("x-noctis-csrf");
  });

  it("refuses a path that would send the session somewhere else", async () => {
    await expect(transport().subject.request("GET", "//evil.example/steal")).rejects.toThrow();
  });

  it("opens the stream at the caller's cursor and delivers committed events", async () => {
    const received: unknown[] = [];
    await transport().subject.subscribe({
      afterSequence: 12,
      onEvent: (event) => received.push(event),
    });

    expect(FakeEventSource.last?.url).toContain("afterSequence=12");
    expect(FakeEventSource.last?.init.withCredentials).toBe(true);

    FakeEventSource.last?.emit("event", COMMITTED);

    expect(received).toEqual([COMMITTED]);
  });

  it("delivers a runtime_delta as a frame, never as an event", async () => {
    const events: unknown[] = [];
    const frames: unknown[] = [];

    await transport().subject.subscribe({
      afterSequence: 0,
      onEvent: (event) => events.push(event),
      onFrame: (frame) => frames.push(frame),
    });

    FakeEventSource.last?.emit("frame", DELTA);

    expect(events).toHaveLength(0);
    expect(frames).toEqual([DELTA]);
  });

  it("routes a gap frame to onGap, so a cursor ahead of the ledger is announced", async () => {
    const frames: unknown[] = [];
    const gaps: Array<[number, number]> = [];

    await transport().subject.subscribe({
      afterSequence: 99,
      onEvent: () => undefined,
      onFrame: (frame) => frames.push(frame),
      onGap: (from, to) => gaps.push([from, to]),
    });

    FakeEventSource.last?.emit("frame", {
      kind: "gap",
      envelopeVersion: 1,
      fromSequence: 4,
      toSequence: 99,
    });

    // A gap is not a frame the page renders; handing it to `onFrame` as well
    // would make every frame consumer learn a kind it has no use for.
    expect(gaps).toEqual([[4, 99]]);
    expect(frames).toHaveLength(0);
  });

  it("ignores a frame that does not parse, rather than handing the page a malformed one", async () => {
    const frames: unknown[] = [];
    const gaps: unknown[] = [];

    await transport().subject.subscribe({
      afterSequence: 0,
      onEvent: () => undefined,
      onFrame: (frame) => frames.push(frame),
      onGap: (from, to) => gaps.push([from, to]),
    });

    FakeEventSource.last?.emit("frame", { kind: "not_a_frame" });

    expect(frames).toHaveLength(0);
    expect(gaps).toHaveLength(0);
  });

  it("ignores an event that does not look like one", async () => {
    const events: unknown[] = [];

    await transport().subject.subscribe({
      afterSequence: 0,
      onEvent: (event) => events.push(event),
    });

    FakeEventSource.last?.emit("event", { sequence: 1 });

    expect(events).toHaveLength(0);
  });

  it("closes the stream when the subscription is closed", async () => {
    const subscription = await transport().subject.subscribe({
      afterSequence: 0,
      onEvent: () => undefined,
    });

    subscription.close();

    expect(FakeEventSource.last?.closed).toBe(true);
  });

  it("reports a stream error to the caller rather than failing silently", async () => {
    const errors: unknown[] = [];

    await transport().subject.subscribe({
      afterSequence: 0,
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
    });

    FakeEventSource.last?.onerror?.(new Event("error"));

    expect(errors).toHaveLength(1);
  });
});
