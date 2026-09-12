import type { OrchestrationEvent } from "@noctis/contracts";
import { describe, expect, it, vi } from "vitest";

import { BrowserTransport } from "./BrowserTransport.js";
import { CorePathRefused } from "./CoreTransport.js";

const BASE = "http://127.0.0.1:7717";
const TOKEN = "0123456789abcdef0123456789abcdef";

function event(sequence: number): OrchestrationEvent {
  return {
    id: `0199a000-0000-7000-8000-00000000000${sequence.toString(16)}`,
    sequence,
    streamType: "objective",
    streamId: "0199a000-0000-7000-8000-0000000000ff",
    type: "objective.created.v1",
    actorType: "user",
    actorId: "local",
    payloadVersion: 1,
    payload: {},
    correlationId: "0199a000-0000-7000-8000-0000000000fe",
    occurredAt: "2026-09-05T12:00:00.000Z",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch that answers from a script and records what it was asked. */
function scripted(pages: (() => Response)[]): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];

  return {
    calls,
    fetch(url, init) {
      calls.push({ url, init });

      const next = pages.shift();

      return Promise.resolve(next === undefined ? json({ events: [], latestSequence: 0 }) : next());
    },
  };
}

describe("BrowserTransport.request", () => {
  it("sends the bearer token to the core and nothing else", async () => {
    const { fetch, calls } = scripted([() => json({ objectives: [] })]);
    const transport = new BrowserTransport({ baseUrl: BASE, token: TOKEN, fetch });

    const response = await transport.request("GET", "/objectives?limit=2");

    expect(response).toEqual({ status: 200, body: { objectives: [] } });
    expect(calls[0]?.url).toBe(`${BASE}/objectives?limit=2`);
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("sends a command as JSON", async () => {
    const { fetch, calls } = scripted([() => json({ id: "x" })]);
    const transport = new BrowserTransport({ baseUrl: BASE, token: TOKEN, fetch });

    await transport.request("POST", "/commands/objective.create", { title: "T" });

    expect(calls[0]?.init.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ title: "T" }));
  });

  it("refuses a path that names another host before the token is attached", async () => {
    const { fetch, calls } = scripted([]);
    const transport = new BrowserTransport({ baseUrl: BASE, token: TOKEN, fetch });

    await expect(transport.request("GET", "//evil.example/steal")).rejects.toBeInstanceOf(
      CorePathRefused,
    );
    expect(calls).toHaveLength(0);
  });

  it("reports the core's status rather than throwing on a refusal", async () => {
    const { fetch } = scripted([
      () => json({ error: { code: "unauthorized", message: "no" } }, 401),
    ]);
    const transport = new BrowserTransport({ baseUrl: BASE, token: TOKEN, fetch });

    const response = await transport.request("GET", "/objectives");

    expect(response.status).toBe(401);
  });
});

describe("BrowserTransport.subscribe", () => {
  /** A wait the test releases by hand, so the poll loop is stepped, not raced. */
  function steppedWait(): { wait: () => Promise<void>; step: () => void } {
    let release: (() => void) | undefined;

    return {
      wait: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      step: () => {
        release?.();
        release = undefined;
      },
    };
  }

  it("delivers events in order and resumes from the last sequence", async () => {
    const { fetch, calls } = scripted([
      () => json({ events: [event(1), event(2)], latestSequence: 2 }),
      () => json({ events: [event(3)], latestSequence: 3 }),
    ]);
    const { wait, step } = steppedWait();
    const transport = new BrowserTransport({ baseUrl: BASE, token: TOKEN, fetch, wait });
    const seen: number[] = [];

    const subscription = await transport.subscribe({
      afterSequence: 0,
      onEvent: (received) => seen.push(received.sequence),
    });

    await vi.waitFor(() => expect(seen).toEqual([1, 2]));
    expect(calls[0]?.url).toContain("after=0");

    step();
    await vi.waitFor(() => expect(seen).toEqual([1, 2, 3]));
    expect(calls[1]?.url).toContain("after=2");

    subscription.close();
  });

  it("reports a gap when the cursor is ahead of the core's ledger", async () => {
    const { fetch } = scripted([() => json({ events: [], latestSequence: 4 })]);
    const { wait } = steppedWait();
    const transport = new BrowserTransport({ baseUrl: BASE, token: TOKEN, fetch, wait });
    const gaps: number[][] = [];

    const subscription = await transport.subscribe({
      afterSequence: 9,
      onEvent: () => undefined,
      onGap: (from, to) => gaps.push([from, to]),
    });

    await vi.waitFor(() => expect(gaps).toEqual([[4, 9]]));
    subscription.close();
  });

  it("reports a failed poll without advancing the cursor", async () => {
    const { fetch, calls } = scripted([
      () => json({ error: { code: "internal", message: "no" } }, 500),
      () => json({ events: [event(1)], latestSequence: 1 }),
    ]);
    const { wait, step } = steppedWait();
    const transport = new BrowserTransport({ baseUrl: BASE, token: TOKEN, fetch, wait });
    const errors: unknown[] = [];
    const seen: number[] = [];

    const subscription = await transport.subscribe({
      afterSequence: 0,
      onEvent: (received) => seen.push(received.sequence),
      onError: (error) => errors.push(error),
    });

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    step();
    await vi.waitFor(() => expect(seen).toEqual([1]));
    expect(calls[1]?.url).toContain("after=0");

    subscription.close();
  });

  it("never calls onFrame: a polled ledger carries committed events and no deltas", async () => {
    const { fetch } = scripted([() => json({ events: [event(1)], latestSequence: 1 })]);
    const { wait } = steppedWait();
    const transport = new BrowserTransport({ baseUrl: BASE, token: TOKEN, fetch, wait });
    const seen: number[] = [];
    const frames: unknown[] = [];

    const subscription = await transport.subscribe({
      afterSequence: 0,
      onEvent: (received) => seen.push(received.sequence),
      onFrame: (frame) => frames.push(frame),
    });

    await vi.waitFor(() => expect(seen).toEqual([1]));
    expect(frames).toHaveLength(0);

    subscription.close();
  });

  it("stops polling once the subscription is closed", async () => {
    const { fetch, calls } = scripted([() => json({ events: [event(1)], latestSequence: 1 })]);
    const { wait, step } = steppedWait();
    const transport = new BrowserTransport({ baseUrl: BASE, token: TOKEN, fetch, wait });
    const seen: number[] = [];

    const subscription = await transport.subscribe({
      afterSequence: 0,
      onEvent: (received) => seen.push(received.sequence),
    });

    await vi.waitFor(() => expect(seen).toEqual([1]));
    subscription.close();
    step();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(calls).toHaveLength(1);
  });
});
