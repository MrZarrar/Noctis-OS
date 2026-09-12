import type { OrchestrationEvent } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { CorePathRefused } from "./CoreTransport.js";
import { TauriTransport } from "./TauriTransport.js";

function event(sequence: number): OrchestrationEvent {
  return {
    id: "0199a000-0000-7000-8000-00000000000a",
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

interface Harness {
  transport: TauriTransport;
  order: string[];
  invocations: { command: string; args?: Record<string, unknown> }[];
  emit: (payload: unknown) => void;
  unlistened: () => number;
}

function harness(response: unknown = { status: 200, body: "{}" }): Harness {
  const order: string[] = [];
  const invocations: { command: string; args?: Record<string, unknown> }[] = [];
  let handler: ((event: { payload: unknown }) => void) | undefined;
  let unlistenCount = 0;

  const transport = new TauriTransport({
    invoke: (command, args) => {
      order.push(`invoke:${command}`);
      invocations.push({ command, ...(args === undefined ? {} : { args }) });

      return Promise.resolve(response);
    },
    listen: (name, received) => {
      order.push(`listen:${name}`);
      handler = received;

      return Promise.resolve(() => {
        unlistenCount += 1;
      });
    },
  });

  return {
    transport,
    order,
    invocations,
    emit: (payload) => handler?.({ payload }),
    unlistened: () => unlistenCount,
  };
}

describe("TauriTransport.request", () => {
  it("asks Rust to perform the request and parses what the core answered", async () => {
    const { transport, invocations } = harness({
      status: 200,
      body: JSON.stringify({ objectives: [] }),
    });

    const response = await transport.request("GET", "/objectives");

    expect(response).toEqual({ status: 200, body: { objectives: [] } });
    expect(invocations[0]).toEqual({
      command: "core_request",
      args: { method: "GET", path: "/objectives", body: null },
    });
  });

  it("refuses a path that names another host before Rust is asked", async () => {
    const { transport, invocations } = harness();

    await expect(transport.request("GET", "//evil.example/steal")).rejects.toBeInstanceOf(
      CorePathRefused,
    );
    expect(invocations).toHaveLength(0);
  });
});

describe("TauriTransport.subscribe", () => {
  it("listens before it subscribes, so no frame arrives unheard", async () => {
    const { transport, order, invocations } = harness();

    const subscription = await transport.subscribe({ afterSequence: 7, onEvent: () => undefined });

    expect(order).toEqual(["listen:core:frame", "invoke:core_subscribe"]);
    expect(invocations[0]?.args).toEqual({ afterSequence: 7 });

    subscription.close();
  });

  it("delivers events and drops sequences it has already seen", async () => {
    const { transport, emit } = harness();
    const seen: number[] = [];

    const subscription = await transport.subscribe({
      afterSequence: 1,
      onEvent: (received) => seen.push(received.sequence),
    });

    // 1 is the resume point and 2 is a reconnect replay of a delivered frame.
    emit(JSON.stringify({ kind: "event", envelopeVersion: 1, event: event(1) }));
    emit(JSON.stringify({ kind: "event", envelopeVersion: 1, event: event(2) }));
    emit(JSON.stringify({ kind: "event", envelopeVersion: 1, event: event(2) }));
    emit(JSON.stringify({ kind: "event", envelopeVersion: 1, event: event(3) }));

    expect(seen).toEqual([2, 3]);

    subscription.close();
  });

  it("reports a gap frame rather than swallowing it", async () => {
    const { transport, emit } = harness();
    const gaps: number[][] = [];

    const subscription = await transport.subscribe({
      afterSequence: 9,
      onEvent: () => undefined,
      onGap: (from, to) => gaps.push([from, to]),
    });

    emit(JSON.stringify({ kind: "gap", envelopeVersion: 1, fromSequence: 4, toSequence: 9 }));

    expect(gaps).toEqual([[4, 9]]);

    subscription.close();
  });

  it("hands a runtime_delta frame to onFrame rather than to onEvent", async () => {
    const { transport, emit } = harness();
    const frames: unknown[] = [];
    const events: unknown[] = [];

    const subscription = await transport.subscribe({
      afterSequence: 0,
      onEvent: (received) => events.push(received),
      onFrame: (frame) => frames.push(frame),
    });

    const delta = {
      kind: "runtime_delta",
      envelopeVersion: 1,
      threadId: "0199a000-0000-7000-8000-0000000000ff",
      jobId: "0199a000-0000-7000-8000-0000000000aa",
      itemId: "m1",
      text: "Hel",
    };

    emit(JSON.stringify(delta));

    expect(frames).toEqual([delta]);
    expect(events).toHaveLength(0);

    subscription.close();
  });

  it("reports a frame it cannot read instead of dropping it quietly", async () => {
    const { transport, emit } = harness();
    const errors: unknown[] = [];

    const subscription = await transport.subscribe({
      afterSequence: 0,
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
    });

    emit("not json");
    emit(JSON.stringify({ kind: "surprise" }));

    expect(errors).toHaveLength(2);

    subscription.close();
  });

  it("stops the Rust stream and the listener when closed", async () => {
    const { transport, invocations, unlistened } = harness();

    const subscription = await transport.subscribe({ afterSequence: 0, onEvent: () => undefined });
    subscription.close();

    expect(unlistened()).toBe(1);
    expect(invocations.map((call) => call.command)).toContain("core_unsubscribe");
  });
});
