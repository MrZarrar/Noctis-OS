import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { JsonRpcClient } from "./jsonrpc.js";
import { JsonRpcError, createJsonRpcClient } from "./jsonrpc.js";

interface Pair {
  client: JsonRpcClient;
  server: JsonRpcClient;
  /** Raw lines the client wrote, for framing assertions. */
  clientWrote: string[];
  /** Write a raw line to the client as if the server had. */
  rawToClient(line: string): void;
  endServer(): void;
}

/** JSON-RPC is symmetric: the fake server is a second client wired crosswise. */
function pair(options?: Parameters<typeof createJsonRpcClient>[1]): Pair {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const clientWrote: string[] = [];

  toServer.on("data", (chunk: Buffer) => {
    clientWrote.push(
      ...chunk
        .toString()
        .split("\n")
        .filter((line) => line !== ""),
    );
  });

  return {
    client: createJsonRpcClient({ input: toClient, output: toServer }, options),
    server: createJsonRpcClient({ input: toServer, output: toClient }),
    clientWrote,
    rawToClient: (line) => toClient.write(`${line}\n`),
    endServer: () => toClient.end(),
  };
}

describe("the line-delimited JSON-RPC client", () => {
  it("frames a request as one JSON-RPC 2.0 line and resolves with the result", async () => {
    const p = pair();

    p.server.onRequest((method, params) => Promise.resolve({ echoed: [method, params] }));

    await expect(p.client.request("thread/start", { cwd: "C:\\w" })).resolves.toEqual({
      echoed: ["thread/start", { cwd: "C:\\w" }],
    });
    expect(JSON.parse(p.clientWrote[0] ?? "")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "thread/start",
      params: { cwd: "C:\\w" },
    });
  });

  it("accepts a reply that omits the jsonrpc field, as Codex sends them", async () => {
    const p = pair();
    const pending = p.client.request("initialize", {});

    p.rawToClient('{"id":1,"result":{"userAgent":"codex"}}');

    await expect(pending).resolves.toEqual({ userAgent: "codex" });
  });

  it("rejects with the server's error code and message", async () => {
    const p = pair();

    p.server.onRequest(() => Promise.reject(new JsonRpcError(-32001, "thread not found")));

    await expect(p.client.request("thread/resume", { threadId: "x" })).rejects.toMatchObject({
      code: -32001,
      message: "thread not found",
    });
  });

  it("answers an unhandled request with -32601 and a thrown plain error with -32603", async () => {
    const p = pair();

    await expect(p.client.request("nothing/here")).rejects.toMatchObject({ code: -32601 });

    p.server.onRequest(() => Promise.reject(new Error("boom")));

    await expect(p.client.request("still/nothing")).rejects.toMatchObject({
      code: -32603,
      message: "boom",
    });
  });

  it("delivers notifications both ways without an id", async () => {
    const p = pair();
    const seen: Array<[string, unknown]> = [];

    p.server.onNotification((method, params) => seen.push([method, params]));
    p.client.notify("client/ping", { n: 1 });

    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual([["client/ping", { n: 1 }]]);
    expect(JSON.parse(p.clientWrote[0] ?? "")).toEqual({
      jsonrpc: "2.0",
      method: "client/ping",
      params: { n: 1 },
    });
  });

  it("ignores a line that is not JSON and keeps going", async () => {
    const p = pair();
    const pending = p.client.request("initialize", {});

    p.rawToClient("not json at all");
    p.rawToClient('{"id":1,"result":1}');

    await expect(pending).resolves.toBe(1);
  });

  it("times out a request the server never answers", async () => {
    const p = pair({ timeoutMs: 20 });

    p.server.onRequest(() => new Promise(() => undefined));

    await expect(p.client.request("slow")).rejects.toThrow(/timed out/);
  });

  it("refuses a line over the byte ceiling and fails what was pending", async () => {
    const p = pair({ maxLineBytes: 64 });
    const pending = p.client.request("initialize", {});

    p.rawToClient("a".repeat(100));

    await expect(pending).rejects.toThrow(/line/);
  });

  it("fails pending requests when the peer ends or the client is closed", async () => {
    const ended = pair();
    const pendingOnEnd = ended.client.request("initialize", {});

    ended.endServer();

    await expect(pendingOnEnd).rejects.toThrow(/ended/);

    const closed = pair();
    const pendingOnClose = closed.client.request("initialize", {});

    closed.client.close();

    await expect(pendingOnClose).rejects.toThrow(/closed/);
  });
});
