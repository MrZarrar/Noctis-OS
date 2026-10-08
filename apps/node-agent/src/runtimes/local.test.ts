import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import type { RuntimeItem, RuntimeTurnPayload } from "@noctis/contracts";
import { RuntimeItemSchema, RuntimeTurnEvidenceSchema } from "@noctis/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { AdapterRefused } from "./Runtime.js";
import { createLocalRuntime } from "./local.js";

const ROOTS = { cwd: "C:\\work", writable: ["C:\\work"], readable: [], localOnly: true };

interface Asked {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: string }>;
}

let server: Server;
let base: string;
let asked: Asked[];
/** What the next completion streams, one SSE chunk each; `hang` never finishes. */
let reply: string[] | "hang";
let scratch: string;

beforeEach(async () => {
  asked = [];
  reply = ["Hel", "lo"];
  scratch = mkdtempSync(join(tmpdir(), "noctis-local-"));
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ object: "list", data: [{ id: "qwen3.5-9b" }, { id: "gemma-4-12b" }] }),
      );
      return;
    }

    void text(req).then((body) => {
      asked.push(JSON.parse(body) as Asked);
      res.writeHead(200, { "content-type": "text/event-stream" });

      if (reply === "hang") {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Thinking" } }] })}\n\n`);
        return;
      }

      for (const chunk of reply) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      }

      res.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
});

function payload(overrides: Partial<RuntimeTurnPayload> = {}): RuntimeTurnPayload {
  return {
    threadId: "0199a000-0000-7000-8000-0000000000e1",
    identityId: "vesper",
    model: { providerId: "local", model: "qwen3.5-9b" },
    userMessageId: "0199a000-0000-7000-8000-0000000000e2",
    prompt: "say hello",
    primaryRootGrantId: "w",
    objectiveActive: false,
    ...overrides,
  };
}

function input(
  overrides: Partial<RuntimeTurnPayload> = {},
  signal = new AbortController().signal,
): RuntimeTurnInput {
  return { payload: payload(overrides), roots: ROOTS, env: {}, signal };
}

function recorder(): { sink: RuntimeSink; items: RuntimeItem[]; deltas: string[] } {
  const items: RuntimeItem[] = [];
  const deltas: string[] = [];

  return {
    items,
    deltas,
    sink: {
      item: (item) => items.push(RuntimeItemSchema.parse(item)),
      delta: (_itemId, chunk) => deltas.push(chunk),
      ask: () => Promise.reject(new Error("a local model has no tools to ask about")),
      delegate: () => Promise.reject(new Error("no delegation expected")),
      upload: () => Promise.reject(new Error("no upload expected")),
    },
  };
}

describe("the local model runtime", () => {
  it("offers the models the server on this PC has, as local", async () => {
    const probe = await createLocalRuntime({ baseUrl: base, sessionsDir: scratch }).probe();

    expect(probe).toEqual({
      providerId: "local",
      available: true,
      authMode: "local",
      models: [
        { providerId: "local", model: "qwen3.5-9b" },
        { providerId: "local", model: "gemma-4-12b" },
      ],
    });
  });

  it("says so when no model server is running, rather than guessing", async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));

    const probe = await createLocalRuntime({ baseUrl: base, sessionsDir: scratch }).probe();

    expect(probe).toMatchObject({ providerId: "local", available: false, authMode: "local" });
    expect(probe.reason).toMatch(/model server/);
    // Restarted so afterEach has something to close.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  it("talks only to a server on this machine", async () => {
    const runtime = createLocalRuntime({
      baseUrl: "http://192.168.1.20:1234/v1",
      sessionsDir: scratch,
    });

    expect((await runtime.probe()).available).toBe(false);
    await expect(runtime.turn(input(), recorder().sink)).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("streams the reply, then continues the same conversation on the next turn", async () => {
    const runtime = createLocalRuntime({ baseUrl: base, sessionsDir: scratch });
    const first = recorder();

    const evidence = RuntimeTurnEvidenceSchema.parse(await runtime.turn(input(), first.sink));

    expect(first.deltas).toEqual(["Hel", "lo"]);
    expect(first.items.at(-1)).toMatchObject({
      kind: "agent_message",
      status: "completed",
      text: "Hello",
    });
    expect(evidence).toMatchObject({
      stoppedReason: "completed",
      finalText: "Hello",
      usage: { inputTokens: 12, outputTokens: 2 },
    });
    expect(evidence.sessionRef).toMatch(/^[A-Za-z0-9-]+$/);
    expect(asked[0]).toMatchObject({ model: "qwen3.5-9b", stream: true });

    reply = ["Again"];
    await runtime.turn(
      input({ prompt: "and again", sessionRef: evidence.sessionRef ?? "" }),
      recorder().sink,
    );

    // The server keeps nothing between requests; the node does.
    expect(asked[1]?.messages.slice(1)).toEqual([
      { role: "user", content: "say hello" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "and again" },
    ]);
  });

  it("stops the request when the turn is cancelled", async () => {
    reply = "hang";
    const controller = new AbortController();
    const runtime = createLocalRuntime({ baseUrl: base, sessionsDir: scratch });
    const turn = runtime.turn(input({}, controller.signal), recorder().sink);

    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    expect((await turn).stoppedReason).toBe("cancelled");
  });
});
