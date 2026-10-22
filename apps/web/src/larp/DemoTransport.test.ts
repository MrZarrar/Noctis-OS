import {
  ApprovalRecordSchema,
  CompositionPlanSchema,
  ConversationThreadSchema,
  OrchestrationEventSchema,
  ServerFrameSchema,
  SurfaceIntentSchema,
  SurfaceOverrideSchema,
} from "@noctis/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { intelligenceState } from "../conversation/intelligence-state.js";
import { TurnSchema, createConversation } from "../conversation/useConversation.js";
import { DemoTransport } from "./DemoTransport.js";
import { LARP_IDS } from "./ids.js";

const SurfaceReadSchema = z.object({
  intents: z.array(SurfaceIntentSchema),
  overrides: z.array(SurfaceOverrideSchema),
  plan: CompositionPlanSchema,
});
const SURFACES =
  "/presence/surfaces?clientId=c1&fingerprint=f1&widthPx=1600&attentionState=presence";

function setup(options: ConstructorParameters<typeof DemoTransport>[0] = {}) {
  const transport = new DemoTransport({ areas: [], latencyMs: 0, ...options });
  const events: unknown[] = [];
  const frames: unknown[] = [];
  void transport.subscribe({
    afterSequence: 0,
    onEvent: (event) => events.push(event),
    onFrame: (frame) => frames.push(frame),
  });
  return { transport, events, frames };
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DemoTransport", () => {
  it("never touches the network", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("network")));
    vi.stubGlobal("fetch", fetch);
    const { transport } = setup();

    await transport.request("GET", "/identities");
    await transport.request("POST", "/commands/conversation.send", {
      identityId: "vesper",
      text: "wake up",
    });
    await advance(20_000);

    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("answers the event head, identities and threads with the real shapes", async () => {
    const { transport } = setup();

    expect((await transport.request("GET", "/events?after=0&limit=1")).body).toEqual({
      events: [],
      latestSequence: 0,
    });
    const identities = (await transport.request("GET", "/identities")).body as {
      activeIdentityId: string;
      threads: unknown[];
    };
    expect(identities.activeIdentityId).toBe("vesper");
    for (const thread of identities.threads)
      ConversationThreadSchema.extend({ awakeUntil: z.string() }).parse(thread);

    const free = await transport.request("GET", "/threads?identityId=vesper");
    expect(ConversationThreadSchema.parse(free.body).id).toBe(LARP_IDS.vesperThread);
    const list = (await transport.request("GET", "/conversations?identityId=vesper")).body as {
      conversations: unknown[];
    };
    expect(list.conversations.length).toBeGreaterThanOrEqual(4);
    const turns = (await transport.request("GET", "/turns")).body as { turns: unknown[] };
    for (const turn of turns.turns) TurnSchema.parse(turn);
    const approvals = (await transport.request("GET", "/approvals")).body as {
      approvals: unknown[];
    };
    for (const approval of approvals.approvals) ApprovalRecordSchema.parse(approval);
    SurfaceReadSchema.parse((await transport.request("GET", SURFACES)).body);
  });

  it("wakes Vesper: thinking, then speaking, then the greeting, then idle", async () => {
    const { transport, events, frames } = setup();
    const store = createConversation(transport, "vesper", undefined);
    store.start();
    await advance(10);
    const state = () => intelligenceState(store.getState(), false);

    await store.send("Vesper, wake up");
    expect(state()).toBe("thinking");
    await advance(1_800);
    expect(state()).toBe("speaking");
    await advance(15_000);

    expect(state()).toBe("idle");
    expect(store.getState().messages.map((message) => message.body)).toEqual([
      "Vesper, wake up",
      "Welcome home. Both PCs are up and the Vault is indexed.",
    ]);
    for (const event of events) OrchestrationEventSchema.parse(event);
    expect(frames.length).toBeGreaterThan(5);
    for (const frame of frames) ServerFrameSchema.parse(frame);
  });

  it("opens the panel sequence on Presence one after another", async () => {
    const { transport } = setup();
    const count = async () =>
      SurfaceReadSchema.parse((await transport.request("GET", SURFACES)).body).intents.length;

    await transport.request("POST", "/commands/conversation.send", {
      identityId: "vesper",
      text: "Show me everything",
    });
    await advance(4_000);
    const early = await count();
    await advance(10_000);

    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(7);
    expect(await count()).toBe(7);
  });

  it("runs the demo task with two delegated agents, asks, and opens Hardware once approved", async () => {
    const notify = vi.fn();
    const { transport } = setup({ notify });
    const store = createConversation(transport, "vesper", undefined);
    store.start();
    await advance(10);

    await store.send("Build me a hardware monitoring panel");
    await advance(40_000);
    const midway = store.getState();
    expect(midway.children.map((child) => child.providerId)).toEqual(["claude", "codex"]);
    expect(midway.turns.at(-1)?.items.filter((item) => item.kind === "sub_agent")).toHaveLength(2);
    expect(midway.pendingApprovals).toHaveLength(0);

    await advance(40_000);
    const asked = store.getState();
    expect(asked.pendingApprovals).toHaveLength(1);
    expect(asked.pendingApprovals[0]?.consequenceSummary).toBe(
      "Restart the node agent on Home PC to load the Hardware panel?",
    );
    expect(intelligenceState(asked, false)).toBe("waiting_for_approval");
    expect(notify).toHaveBeenCalledOnce();

    const before = SurfaceReadSchema.parse((await transport.request("GET", SURFACES)).body);
    expect(before.intents.some((intent) => intent.kind === "hardware")).toBe(false);
    await store.confirm(asked.pendingApprovals[0]?.id ?? "");
    await advance(12_000);

    const after = SurfaceReadSchema.parse((await transport.request("GET", SURFACES)).body);
    expect(after.intents.some((intent) => intent.kind === "hardware")).toBe(true);
    expect(store.getState().pendingApprovals).toHaveLength(0);
    expect(store.getState().turns.at(-1)?.status).toBe("completed");
  });

  it("raises the demo approval on its own for the phone shot", async () => {
    const notify = vi.fn();
    const { transport } = setup({ notify });

    transport.larp.raiseApprovalIn(5_000);
    await advance(5_100);

    expect(notify).toHaveBeenCalledWith(
      "Vesper needs your approval",
      "Restart the node agent on Home PC to load the Hardware panel?",
      "/?larp=approval",
      "larp-approval",
    );
    const approvals = (await transport.request("GET", "/approvals")).body as {
      approvals: Array<{ consequenceSummary: string; confirmedAt?: string }>;
    };
    expect(
      approvals.approvals.some(
        (approval) =>
          approval.consequenceSummary.startsWith("Restart the node agent") &&
          approval.confirmedAt === undefined,
      ),
    ).toBe(true);
  });

  it("sends the wake-up banner after the delay, on its own tag, opening Presence", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("network")));
    vi.stubGlobal("fetch", fetch);
    const notify = vi.fn();
    const { transport, events } = setup({ notify });

    transport.larp.raiseBannerIn(10_000);
    await advance(9_900);
    expect(notify).not.toHaveBeenCalled();
    await advance(200);

    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Wake up, daddy's home",
      "",
      "/?screen=Presence",
      "larp-wake",
    );
    expect(events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("asks for DESTROY before a destructive approval goes through", async () => {
    const { transport } = setup();
    const approvals = (await transport.request("GET", "/approvals")).body as {
      approvals: Array<{ id: string; outcome: string; confirmedAt?: string }>;
    };
    const destructive = approvals.approvals.find(
      (approval) => approval.outcome === "require_typed_confirmation" && !approval.confirmedAt,
    );
    expect(destructive).toBeDefined();

    const wrong = await transport.request("POST", "/commands/authority.confirm", {
      requestId: destructive?.id,
      typedConfirmation: "destroy it",
    });
    const right = await transport.request("POST", "/commands/authority.confirm", {
      requestId: destructive?.id,
      typedConfirmation: "DESTROY",
    });

    expect(wrong.status).toBe(409);
    expect(right.status).toBe(200);
  });

  it("switches to Jester with no runtime, and cycles the takeover lines", async () => {
    const { transport } = setup();

    expect(
      (await transport.request("POST", "/commands/identity.activate", { identityId: "jester" }))
        .status,
    ).toBe(200);
    expect(
      ((await transport.request("GET", "/identities")).body as { activeIdentityId: string })
        .activeIdentityId,
    ).toBe("jester");

    const store = createConversation(transport, "jester", undefined);
    store.start();
    await advance(10);
    const ask = "Vesper just greeted me with 'Wake up, daddy's home'. Take over.";
    await store.send(ask);
    await advance(15_000);
    await store.send(ask);
    await advance(15_000);

    const replies = store
      .getState()
      .messages.filter((message) => message.role === "identity")
      .map((message) => message.body);
    expect(replies).toEqual([
      "Daddy's home? Cute.",
      "Vesper's sweet. I'm not. I'll take it from here.",
    ]);
  });
});
