import type { RuntimeAnswer, RuntimeAsk, RuntimeItem, RuntimeTurnPayload } from "@noctis/contracts";
import { RuntimeItemSchema, RuntimeTurnEvidenceSchema } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import type { RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { FAKE_ASK_COMMAND, FAKE_PROBE, createFakeRuntime } from "./fake.js";

const ROOTS = { cwd: "C:\\work", writable: ["C:\\work"], readable: [], localOnly: false };

function payload(prompt: string): RuntimeTurnPayload {
  return {
    threadId: "0199a000-0000-7000-8000-0000000000e1",
    identityId: "vesper",
    model: { providerId: "codex", model: "fake-model" },
    userMessageId: "0199a000-0000-7000-8000-0000000000e2",
    prompt,
    primaryRootGrantId: "w",
    objectiveActive: false,
  };
}

interface Recorded {
  sink: RuntimeSink;
  items: RuntimeItem[];
  deltas: Array<[string, string]>;
  asks: Array<Omit<RuntimeAsk, "askId">>;
}

function recorder(decision: RuntimeAnswer["decision"] = "allow"): Recorded {
  const recorded: Recorded = { items: [], deltas: [], asks: [], sink: undefined as never };

  recorded.sink = {
    item: (item) => recorded.items.push(RuntimeItemSchema.parse(item)),
    delta: (itemId, text) => recorded.deltas.push([itemId, text]),
    ask: (ask) => {
      recorded.asks.push(ask);

      return Promise.resolve({
        askId: "0199a000-0000-7000-8000-0000000000a5",
        decision,
        approvalId: "0199a000-0000-7000-8000-0000000000a6",
      });
    },
    delegate: () => Promise.reject(new Error("no delegation expected")),
    upload: () => Promise.reject(new Error("no upload expected")),
  };

  return recorded;
}

function input(prompt: string, signal = new AbortController().signal): RuntimeTurnInput {
  return { payload: payload(prompt), roots: ROOTS, env: {}, signal };
}

describe("the fake runtime", () => {
  it("distinct IMAGE prompts yield distinct fixture bytes so attachment dedupe does not collapse panels", async () => {
    const bytes: Uint8Array[] = [];
    const r = recorder();
    r.sink.upload = (upload) => {
      bytes.push(upload.bytes);
      return Promise.resolve("0199a000-0000-7000-8000-0000000000a5");
    };
    await createFakeRuntime().turn(input("IMAGE: one"), r.sink);
    await createFakeRuntime().turn(input("IMAGE: two"), r.sink);
    expect(bytes[0]).not.toEqual(bytes[1]);
  });
  it.each(["PANEL: # Plan\n- [ ] first step", "CHOICE: Alpha | Beta"])(
    "proposes one work panel for %s",
    async (prompt) => {
      const r = recorder();
      await createFakeRuntime().turn(input(prompt), r.sink);
      const proposals = r.items.filter((item) => item.kind === "proposal");
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.proposal).toMatchObject({
        kind: "surface",
        surfaceKind: prompt.startsWith("PANEL:") ? "document" : "list",
      });
      if (prompt.startsWith("PANEL:"))
        expect(proposals[0]?.proposal).toMatchObject({
          payload: { content: { from: "inline", text: "# Plan\n- [ ] first step" } },
        });
      else
        expect(proposals[0]?.proposal).toMatchObject({
          payload: {
            actions: [
              { label: "Use Alpha", message: "Use Alpha" },
              { label: "Use Beta", message: "Use Beta" },
            ],
          },
        });
    },
  );
  it("uploads a complete tiny PNG for IMAGE turns", async () => {
    const r = recorder();
    let bytes: Uint8Array | undefined;
    r.sink.upload = (upload) => {
      bytes = upload.bytes;
      return Promise.resolve("0199a000-0000-7000-8000-0000000000a7");
    };
    await createFakeRuntime().turn(input("IMAGE: a frame"), r.sink);
    expect(bytes?.length).toBeGreaterThan(8);
    expect(Array.from(bytes?.slice(12, 16) ?? [])).toEqual([73, 72, 68, 82]);
    expect(r.items.some((item) => item.kind === "output")).toBe(true);
  });
  it("probes as an available ChatGPT Codex offering one model", async () => {
    expect(await createFakeRuntime().probe()).toEqual(FAKE_PROBE);
  });

  it("streams two deltas and one completed message, and echoes the prompt", async () => {
    const r = recorder();
    const evidence = RuntimeTurnEvidenceSchema.parse(
      await createFakeRuntime().turn(input("hi there"), r.sink),
    );

    expect(r.deltas).toEqual([
      ["m1", "Hel"],
      ["m1", "lo"],
    ]);
    expect(r.items).toEqual([
      { itemId: "m1", kind: "agent_message", status: "completed", text: "Hello hi there" },
    ]);
    expect(r.asks).toEqual([]);
    expect(evidence).toEqual({
      model: { providerId: "codex", model: "fake-model" },
      sessionRef: "fake-session-1",
      itemCount: 1,
      finalText: "Hello hi there",
      stoppedReason: "completed",
    });
  });

  it("asks before running a command and completes it when allowed", async () => {
    const r = recorder("allow");
    const evidence = await createFakeRuntime().turn(input("ASK: please"), r.sink);

    expect(r.asks).toHaveLength(1);
    expect(r.asks[0]).toMatchObject({
      itemId: "c1",
      kind: "command",
      capability: "runtime.command",
      // The point of this branch: a class the evaluator will not wave through.
      // `read_inspect` here would mean the ask never reaches a human.
      operationClass: "external_write",
      reversibility: "partially_reversible",
      target: { type: "command", id: FAKE_ASK_COMMAND },
      detail: { command: FAKE_ASK_COMMAND, cwd: ROOTS.cwd },
    });
    expect(r.items.map((item) => [item.itemId, item.status])).toEqual([
      ["m1", "completed"],
      ["c1", "in_progress"],
      ["c1", "completed"],
    ]);
    expect(r.items[2]).toMatchObject({ output: "hi", exitCode: 0 });
    expect(evidence).toMatchObject({ itemCount: 3, stoppedReason: "completed" });
  });

  it("declines the command and stops when the answer is deny", async () => {
    const r = recorder("deny");
    const evidence = await createFakeRuntime().turn(input("ASK: please PROPOSE: too"), r.sink);

    expect(r.items.at(-1)).toMatchObject({ itemId: "c1", status: "declined" });
    expect(r.items.some((item) => item.kind === "proposal")).toBe(false);
    expect(evidence).toMatchObject({ itemCount: 3, stoppedReason: "declined" });
  });

  it("proposes an objective when asked to", async () => {
    const r = recorder();

    await createFakeRuntime().turn(input("PROPOSE: an idea"), r.sink);

    expect(r.items.at(-1)).toEqual({
      itemId: "p1",
      kind: "proposal",
      status: "completed",
      proposal: { kind: "objective", title: "Suggested", intent: "PROPOSE: an idea" },
    });
  });

  it("uses the caller's sessionRef when there is one", async () => {
    const evidence = await createFakeRuntime().turn(
      { ...input("x"), payload: { ...payload("x"), sessionRef: "thread-9" } },
      recorder().sink,
    );

    expect(evidence.sessionRef).toBe("thread-9");
  });

  it("stops with cancelled when the signal fires mid-turn", async () => {
    const controller = new AbortController();
    const r = recorder();
    const turn = createFakeRuntime().turn(input("SLOW: take your time", controller.signal), r.sink);

    setTimeout(() => controller.abort(), 50);

    const evidence = await turn;

    expect(evidence.stoppedReason).toBe("cancelled");
    expect(r.items).toEqual([]);
  });
});
