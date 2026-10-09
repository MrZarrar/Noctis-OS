import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { RuntimeAnswer, RuntimeAsk, RuntimeItem, RuntimeTurnPayload } from "@noctis/contracts";
import { RuntimeItemSchema, RuntimeTurnEvidenceSchema } from "@noctis/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeSink, RuntimeTurnInput, RuntimeUpload } from "./Runtime.js";
import { ApprovalTimedOut } from "./Runtime.js";
import type { CodexSpawn, SpawnedChild } from "./codex.js";
import { NOCTIS_CODEX_RULES } from "./codex-rules.js";
import { createCodexRuntime } from "./codex.js";
import type { JsonRpcClient } from "./jsonrpc.js";
import { JsonRpcError, createJsonRpcClient } from "./jsonrpc.js";

const ROOTS = { cwd: "C:\\work", writable: ["C:\\work"], readable: ["C:\\ref"], localOnly: false };
const TURN_ID = "turn-1";

function payload(overrides: Partial<RuntimeTurnPayload> = {}): RuntimeTurnPayload {
  return {
    threadId: "0199a000-0000-7000-8000-0000000000e1",
    identityId: "vesper",
    model: { providerId: "codex", model: "gpt-5.5" },
    userMessageId: "0199a000-0000-7000-8000-0000000000e2",
    prompt: "say hello",
    primaryRootGrantId: "w",
    objectiveActive: false,
    ...overrides,
  };
}

interface Recorded {
  sink: RuntimeSink;
  items: RuntimeItem[];
  deltas: Array<[string, string]>;
  asks: Array<Omit<RuntimeAsk, "askId">>;
  uploads: RuntimeUpload[];
}

function recorder(decision: RuntimeAnswer["decision"] = "allow"): Recorded {
  const recorded: Recorded = {
    items: [],
    deltas: [],
    asks: [],
    uploads: [],
    sink: undefined as never,
  };

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
    upload: (output) => {
      recorded.uploads.push(output);

      return Promise.resolve(UPLOADED);
    },
  };

  return recorded;
}

const UPLOADED = "0199a000-0000-7000-8000-0000000000f1";

class FakeChild extends EventEmitter implements SpawnedChild {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.exitCode = this.exitCode ?? 1;
    this.emit("exit", null, "SIGTERM");

    return true;
  }
}

interface Spawned {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  child: FakeChild;
  /** What the runtime sent, by method. */
  requests: Map<string, unknown[]>;
  threadId: string;
}

interface Scenario {
  /** Runs once `turn/start` has been answered. */
  turn(server: JsonRpcClient, spawned: Spawned): Promise<void>;
  resume?: "ok" | "fail";
  /** What `thread/list` answers. */
  threads?: unknown[];
  /** The thread `thread/read` and `thread/turns/list` describe. */
  history?: { cwd: string; turns: unknown[] };
}

function turnCompleted(spawned: Spawned, status: string): unknown {
  return { threadId: spawned.threadId, turn: { id: TURN_ID, status, error: null } };
}

function itemNotification(spawned: Spawned, item: Record<string, unknown>): unknown {
  return { threadId: spawned.threadId, turnId: TURN_ID, item, startedAtMs: 0, completedAtMs: 0 };
}

/**
 * A scripted app-server behind an injected spawn: the same JSON-RPC peer the
 * runtime uses, wired crosswise onto the fake child's stdio.
 */
function fakeAppServer(scenario: Scenario): { spawn: CodexSpawn; spawned: Spawned[] } {
  const spawned: Spawned[] = [];

  const spawn: CodexSpawn = (file, args, options) => {
    const child = new FakeChild();
    const server = createJsonRpcClient({ input: child.stdin, output: child.stdout });
    const record: Spawned = {
      file,
      args: [...args],
      cwd: options.cwd,
      env: options.env,
      child,
      requests: new Map(),
      threadId: "thread-1",
    };

    spawned.push(record);

    server.onRequest((method, params) => {
      record.requests.set(method, [...(record.requests.get(method) ?? []), params]);

      switch (method) {
        case "initialize":
          return Promise.resolve({ userAgent: "fake" });
        case "thread/start":
          return Promise.resolve({ thread: { id: record.threadId } });
        case "thread/resume":
          if (scenario.resume === "fail") {
            return Promise.reject(new JsonRpcError(-32001, "no such thread"));
          }

          record.threadId = (params as { threadId: string }).threadId;

          return Promise.resolve({ thread: { id: record.threadId } });
        case "thread/fork":
          record.threadId = "thread-fork";

          return Promise.resolve({ thread: { id: record.threadId } });
        case "thread/list":
          return Promise.resolve({ data: scenario.threads ?? [], nextCursor: null });
        case "thread/read":
          return Promise.resolve({
            thread: { id: (params as { threadId: string }).threadId, cwd: scenario.history?.cwd },
          });
        case "thread/turns/list":
          return Promise.resolve({ data: scenario.history?.turns ?? [], nextCursor: null });
        case "turn/start":
          setTimeout(() => void scenario.turn(server, record), 0);

          return Promise.resolve({ turn: { id: TURN_ID } });
        case "turn/interrupt":
          setTimeout(
            () => server.notify("turn/completed", turnCompleted(record, "interrupted")),
            0,
          );

          return Promise.resolve({});
        default:
          return Promise.reject(new JsonRpcError(-32601, method));
      }
    });

    return child;
  };

  return { spawn, spawned };
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "noctis-codex-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runtime(scenario: Scenario, command = "C:\\bin\\codex.exe", idleMs?: number) {
  const fake = fakeAppServer(scenario);

  return {
    ...fake,
    runtime: createCodexRuntime({
      command,
      spawn: fake.spawn,
      proposalsDir: join(scratch, "proposals"),
      codexHome: join(scratch, "codex-home"),
      mcpEntry: "C:\\noctis\\dist\\noctis-mcp.js",
      ...(idleMs === undefined ? {} : { idleMs }),
    }),
  };
}

function input(
  overrides: Partial<RuntimeTurnPayload> = {},
  signal = new AbortController().signal,
): RuntimeTurnInput {
  return { payload: payload(overrides), roots: ROOTS, env: { PATH: "C:\\bin" }, signal };
}

/** The full happy path: a message, an approved command, an approved edit, a tool call, a proposal. */
const HAPPY: Scenario = {
  async turn(server, spawned) {
    server.notify(
      "item/started",
      itemNotification(spawned, { type: "agentMessage", id: "m1", text: "" }),
    );
    server.notify("item/agentMessage/delta", {
      threadId: spawned.threadId,
      turnId: TURN_ID,
      itemId: "m1",
      delta: "Hel",
    });
    server.notify("item/agentMessage/delta", {
      threadId: spawned.threadId,
      turnId: TURN_ID,
      itemId: "m1",
      delta: "lo",
    });
    server.notify(
      "item/completed",
      itemNotification(spawned, { type: "agentMessage", id: "m1", text: "Hello" }),
    );

    server.notify(
      "item/started",
      itemNotification(spawned, {
        type: "commandExecution",
        id: "c1",
        command: "echo hi",
        cwd: "C:\\work",
        status: "inProgress",
      }),
    );

    const command = (await server.request("item/commandExecution/requestApproval", {
      threadId: spawned.threadId,
      turnId: TURN_ID,
      itemId: "c1",
      command: "echo hi",
      cwd: "C:\\work",
    })) as { decision: string };

    server.notify(
      "item/completed",
      itemNotification(spawned, {
        type: "commandExecution",
        id: "c1",
        command: "echo hi",
        cwd: "C:\\work",
        status: command.decision === "accept" ? "completed" : "declined",
        aggregatedOutput: command.decision === "accept" ? "hi\n" : null,
        exitCode: command.decision === "accept" ? 0 : null,
      }),
    );

    const changes = [{ path: "C:\\work\\a.ts", kind: { type: "add" }, diff: "+1" }];

    server.notify(
      "item/started",
      itemNotification(spawned, { type: "fileChange", id: "f1", changes, status: "inProgress" }),
    );

    await server.request("item/fileChange/requestApproval", {
      threadId: spawned.threadId,
      turnId: TURN_ID,
      itemId: "f1",
    });

    server.notify(
      "item/completed",
      itemNotification(spawned, { type: "fileChange", id: "f1", changes, status: "completed" }),
    );
    server.notify(
      "item/completed",
      itemNotification(spawned, {
        type: "mcpToolCall",
        id: "t1",
        server: "noctis",
        tool: "noctis_propose_objective",
        status: "completed",
        arguments: { title: "x" },
        result: { content: [{ type: "text", text: "recorded" }] },
      }),
    );
    server.notify(
      "item/completed",
      itemNotification(spawned, { type: "reasoning", id: "r1", summary: [], content: [] }),
    );
    server.notify("thread/tokenUsage/updated", {
      threadId: spawned.threadId,
      turnId: TURN_ID,
      tokenUsage: {
        total: { totalTokens: 17, inputTokens: 12, outputTokens: 5 },
        last: { totalTokens: 17, inputTokens: 12, outputTokens: 5 },
      },
    });

    // The model's MCP tool wrote a proposal; the runtime tails the file named in the MCP args.
    const mcpArgs = JSON.parse(
      spawned.args.find((arg) => arg.startsWith("mcp_servers.noctis.args="))?.slice(24) ?? "[]",
    ) as string[];

    appendFileSync(
      mcpArgs[mcpArgs.indexOf("--proposals") + 1] ?? "",
      `${JSON.stringify({ kind: "objective", title: "Suggested", intent: "later" })}\n`,
    );

    server.notify("turn/completed", turnCompleted(spawned, "completed"));
  },
};

describe("the Codex App Server runtime", () => {
  it("hands a generated image to the core before the turn ends, and records it as an output", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
    const { runtime: codex } = runtime({
      turn(server, spawned) {
        server.notify(
          "item/completed",
          itemNotification(spawned, {
            type: "imageGeneration",
            id: "ig_1",
            status: "completed",
            result: png.toString("base64"),
            savedPath: "C:\\Users\\o\\.codex\\generated_images\\s\\ig_1.png",
          }),
        );
        server.notify("turn/completed", turnCompleted(spawned, "completed"));

        return Promise.resolve();
      },
    });
    const r = recorder();
    const evidence = await codex.turn(input(), r.sink);

    expect(evidence.stoppedReason).toBe("completed");
    expect(r.uploads).toEqual([
      { filename: "ig_1.png", mediaType: "image/png", bytes: new Uint8Array(png) },
    ]);
    expect(r.items).toEqual([
      {
        itemId: "ig_1",
        kind: "output",
        status: "completed",
        mediaType: "image/png",
        path: "C:\\Users\\o\\.codex\\generated_images\\s\\ig_1.png",
        attachmentId: UPLOADED,
      },
    ]);
    codex.close?.();
  });

  it("reads a generated image far larger than a megabyte, as real ones are", async () => {
    const png = Buffer.alloc(3 * 1024 * 1024, 7);

    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const { runtime: codex } = runtime({
      turn(server, spawned) {
        server.notify(
          "item/completed",
          itemNotification(spawned, {
            type: "imageGeneration",
            id: "ig_big",
            status: "completed",
            result: png.toString("base64"),
          }),
        );
        server.notify(
          "item/completed",
          itemNotification(spawned, { type: "agentMessage", id: "m1", text: "Done." }),
        );
        server.notify("turn/completed", turnCompleted(spawned, "completed"));

        return Promise.resolve();
      },
    });
    const r = recorder();
    const evidence = await codex.turn(input(), r.sink);

    expect(evidence).toMatchObject({ stoppedReason: "completed", finalText: "Done." });
    expect(r.uploads[0]?.bytes.length).toBe(png.length);
    codex.close?.();
  });

  it("fails the turn, rather than wait forever, when the app-server sends what cannot be read", async () => {
    const fake = fakeAppServer({
      turn(server, spawned) {
        server.notify(
          "item/completed",
          itemNotification(spawned, { type: "agentMessage", id: "m1", text: "x".repeat(4096) }),
        );

        return Promise.resolve();
      },
    });
    const codex = createCodexRuntime({
      command: "C:\\bin\\codex.exe",
      spawn: fake.spawn,
      proposalsDir: join(scratch, "proposals"),
      codexHome: join(scratch, "codex-home"),
      mcpEntry: "C:\\noctis\\dist\\noctis-mcp.js",
      maxMessageBytes: 2048,
    });

    await expect(codex.turn(input(), recorder().sink)).rejects.toThrow(/exceeded 2048 bytes/);
    codex.close?.();
  });

  it("drives initialize → thread/start → turn/start and maps every item, delta, and ask", async () => {
    const { runtime: codex, spawned } = runtime(HAPPY);
    const r = recorder();

    const evidence = RuntimeTurnEvidenceSchema.parse(await codex.turn(input(), r.sink));
    const [s] = spawned;

    expect(s?.requests.get("initialize")).toEqual([
      {
        clientInfo: { name: "noctis-node-agent", title: null, version: "0.0.0" },
        capabilities: null,
      },
    ]);
    expect(s?.requests.get("thread/start")).toEqual([
      {
        cwd: "C:\\work",
        model: "gpt-5.5",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        developerInstructions: expect.stringContaining("You are Vesper") as string,
      },
    ]);
    expect(s?.requests.get("turn/start")).toEqual([
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "say hello", text_elements: [] }],
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["C:\\work"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    ]);

    expect(r.deltas).toEqual([
      ["m1", "Hel"],
      ["m1", "lo"],
    ]);
    expect(r.items).toEqual([
      { itemId: "m1", kind: "agent_message", status: "in_progress", text: "" },
      { itemId: "m1", kind: "agent_message", status: "completed", text: "Hello" },
      { itemId: "c1", kind: "command", status: "in_progress", command: "echo hi", cwd: "C:\\work" },
      {
        itemId: "c1",
        kind: "command",
        status: "completed",
        command: "echo hi",
        cwd: "C:\\work",
        output: "hi\n",
        exitCode: 0,
      },
      {
        itemId: "f1",
        kind: "file_change",
        status: "in_progress",
        paths: ["C:\\work\\a.ts"],
        summary: "add C:\\work\\a.ts",
      },
      {
        itemId: "f1",
        kind: "file_change",
        status: "completed",
        paths: ["C:\\work\\a.ts"],
        summary: "add C:\\work\\a.ts",
      },
      {
        itemId: "t1",
        kind: "tool_call",
        status: "completed",
        tool: "noctis_propose_objective",
        input: { title: "x" },
        output: '{"content":[{"type":"text","text":"recorded"}]}',
      },
      {
        itemId: "proposal-1",
        kind: "proposal",
        status: "completed",
        proposal: { kind: "objective", title: "Suggested", intent: "later" },
      },
    ]);

    expect(r.asks).toEqual([
      {
        itemId: "c1",
        kind: "command",
        summary: "echo hi",
        operationClass: "read_inspect",
        reversibility: "reversible",
        capability: "runtime.command",
        target: { type: "command", id: "echo hi" },
        detail: { command: "echo hi", cwd: "C:\\work" },
        askedBy: "runtime",
      },
      {
        itemId: "f1",
        kind: "file_change",
        summary: "edit 1 file: C:\\work\\a.ts",
        operationClass: "local_reversible_edit",
        reversibility: "reversible",
        capability: "runtime.file_change",
        target: { type: "file_change", id: "C:\\work\\a.ts" },
        detail: { paths: ["C:\\work\\a.ts"] },
        askedBy: "runtime",
      },
    ]);

    expect(evidence).toEqual({
      model: { providerId: "codex", model: "gpt-5.5" },
      sessionRef: "thread-1",
      itemCount: 5,
      finalText: "Hello",
      usage: { inputTokens: 12, outputTokens: 5 },
      stoppedReason: "completed",
    });
    // The process outlives the turn: the next message in the thread is answered by it.
    expect(s?.child.killed).toBe(false);
  });

  it("turns the core's deny into a decline, and the item arrives declined", async () => {
    const { runtime: codex, spawned } = runtime(HAPPY);
    const r = recorder("deny");

    await codex.turn(input(), r.sink);

    expect(r.items.find((item) => item.itemId === "c1" && item.status !== "in_progress")).toEqual({
      itemId: "c1",
      kind: "command",
      status: "declined",
      command: "echo hi",
      cwd: "C:\\work",
    });
    // A decline does not end the turn: Codex carries on and the next ask still arrives.
    expect(r.asks.map((ask) => ask.kind)).toEqual(["command", "file_change"]);
    expect(spawned[0]?.child.killed).toBe(false);
  });

  it("runs workspace-write with approval on-request and the network off, Objective or not", async () => {
    const { runtime: codex, spawned } = runtime(HAPPY);

    await codex.turn(input({ objectiveActive: false }), recorder().sink);

    expect(spawned[0]?.requests.get("thread/start")).toEqual([
      expect.objectContaining({ sandbox: "workspace-write", approvalPolicy: "on-request" }),
    ]);
    expect(spawned[0]?.requests.get("turn/start")).toEqual([
      expect.objectContaining({
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["C:\\work"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      }),
    ]);
  });

  it("names the runtime and model in the card, and leaves it out with cards off", async () => {
    const on = runtime(HAPPY);
    const off = runtime(HAPPY);

    await on.runtime.turn(input(), recorder().sink);
    await off.runtime.turn(
      { ...input(), env: { PATH: "C:\\bin", NOCTIS_IDENTITY_CARDS: "0" } },
      recorder().sink,
    );

    expect(on.spawned[0]?.requests.get("thread/start")).toEqual([
      expect.objectContaining({
        developerInstructions: expect.stringContaining("running as Codex on gpt-5.5") as string,
      }),
    ]);
    expect(off.spawned[0]?.requests.get("thread/start")?.[0]).not.toHaveProperty(
      "developerInstructions",
    );
  });

  it("carries the card on resume and fork too", async () => {
    const resumed = runtime({ ...HAPPY, resume: "ok" });
    const forked = runtime({ ...HAPPY, resume: "ok" });

    await resumed.runtime.turn(input({ sessionRef: "thread-9" }), recorder().sink);
    await forked.runtime.turn(
      input({ sessionRef: "thread-9", forkSession: true }),
      recorder().sink,
    );

    expect(resumed.spawned[0]?.requests.get("thread/resume")).toEqual([
      expect.objectContaining({
        developerInstructions: expect.stringContaining("You are Vesper") as string,
      }),
    ]);
    expect(forked.spawned[0]?.requests.get("thread/fork")).toEqual([
      expect.objectContaining({
        developerInstructions: expect.stringContaining("You are Vesper") as string,
      }),
    ]);
  });

  it("resumes the thread named by sessionRef instead of starting one", async () => {
    const { runtime: codex, spawned } = runtime({ ...HAPPY, resume: "ok" });

    const evidence = await codex.turn(input({ sessionRef: "thread-9" }), recorder().sink);

    expect(spawned[0]?.requests.get("thread/resume")).toEqual([
      expect.objectContaining({ threadId: "thread-9", approvalPolicy: "on-request" }),
    ]);
    expect(spawned[0]?.requests.has("thread/start")).toBe(false);
    expect(evidence.sessionRef).toBe("thread-9");
  });

  it("forks a thread started outside Noctis instead of writing into it", async () => {
    const { runtime: codex, spawned } = runtime({ ...HAPPY, resume: "ok" });

    const evidence = await codex.turn(
      input({ sessionRef: "thread-9", forkSession: true }),
      recorder().sink,
    );

    expect(spawned[0]?.requests.get("thread/fork")).toEqual([
      expect.objectContaining({ threadId: "thread-9", approvalPolicy: "on-request" }),
    ]);
    expect(spawned[0]?.requests.has("thread/resume")).toBe(false);
    expect(evidence.sessionRef).toBe("thread-fork");
  });

  it("lists a folder's threads from an app-server it starts and stops for the purpose", async () => {
    const { runtime: codex, spawned } = runtime({
      ...HAPPY,
      threads: [
        {
          id: "thread-vscode",
          name: null,
          preview: "Draft the cold open",
          updatedAt: 1_791_480_000,
          source: "vscode",
          cwd: "c:\\work",
        },
      ],
    });

    const sessions = await codex.listSessions?.("C:\\work", { PATH: "C:\\bin" });

    expect(sessions).toEqual([
      {
        providerId: "codex",
        sessionRef: "thread-vscode",
        title: "Draft the cold open",
        lastActiveAt: new Date(1_791_480_000 * 1000).toISOString(),
        source: "vscode",
      },
    ]);
    // VS Code records the drive in lower case; the filter is an exact match.
    expect(spawned[0]?.requests.get("thread/list")).toEqual([
      // Newest activity first, as the list shows them; created_at would drop
      // an old thread touched today off the end of the page.
      expect.objectContaining({ cwd: ["C:\\work", "c:\\work"], sortKey: "updated_at" }),
    ]);
    expect(spawned[0]?.args).not.toContain("mcp_servers.noctis.command");
    expect(spawned[0]?.child.killed).toBe(true);
  });

  it("reads a folder's thread's last turns as exchanges, newest last", async () => {
    const turn = (prompt: string, ...replies: string[]) => ({
      id: prompt,
      status: "completed",
      items: [
        { type: "userMessage", id: "u", content: [{ type: "text", text: prompt }] },
        ...replies.map((text) => ({ type: "agentMessage", id: "a", text })),
      ],
    });
    const { runtime: codex, spawned } = runtime({
      ...HAPPY,
      // VS Code's spelling of the folder; the app-server answers newest first.
      history: {
        cwd: "c:\\work",
        turns: [turn("Make it shorter", "Shorter now."), turn("Draft the hook", "One", "Two")],
      },
    });

    expect(await codex.readHistory?.("C:\\work", "thread-vscode", { PATH: "C:\\bin" })).toEqual([
      { prompt: "Draft the hook", reply: "Two" },
      { prompt: "Make it shorter", reply: "Shorter now." },
    ]);
    expect(spawned[0]?.requests.get("thread/turns/list")).toEqual([
      expect.objectContaining({ threadId: "thread-vscode", limit: 10, itemsView: "summary" }),
    ]);
    expect(spawned[0]?.child.killed).toBe(true);
  });

  it("refuses to read a thread kept for another folder", async () => {
    const { runtime: codex, spawned } = runtime({
      ...HAPPY,
      history: { cwd: "C:\\private", turns: [] },
    });

    await expect(
      codex.readHistory?.("C:\\work", "thread-elsewhere", { PATH: "C:\\bin" }),
    ).rejects.toThrow(/not kept for this folder/);
    expect(spawned[0]?.requests.has("thread/turns/list")).toBe(false);
  });

  it("falls back to a fresh thread when the resume fails, and says so", async () => {
    const { runtime: codex, spawned } = runtime({ ...HAPPY, resume: "fail" });
    const r = recorder();

    const evidence = await codex.turn(input({ sessionRef: "thread-9" }), r.sink);

    expect(spawned[0]?.requests.has("thread/start")).toBe(true);
    expect(evidence.sessionRef).toBe("thread-1");
    expect(r.items[0]).toEqual({
      itemId: "resume-failed",
      kind: "agent_message",
      status: "completed",
      text: "Codex could not resume thread thread-9; started a new one.",
    });
  });

  it("interrupts the turn on cancel and reports it as cancelled", async () => {
    const controller = new AbortController();
    const { runtime: codex, spawned } = runtime({
      turn(server, spawned) {
        server.notify(
          "item/started",
          itemNotification(spawned, { type: "agentMessage", id: "m1", text: "" }),
        );

        return Promise.resolve();
      },
    });
    const r = recorder();

    r.sink.item = (item) => {
      r.items.push(item);
      controller.abort();
    };

    const evidence = await codex.turn(input({}, controller.signal), r.sink);

    expect(spawned[0]?.requests.get("turn/interrupt")).toEqual([
      { threadId: "thread-1", turnId: TURN_ID },
    ]);
    expect(evidence.stoppedReason).toBe("cancelled");
  });

  it("spawns app-server with the overrides, the Noctis MCP server, and a stripped environment", async () => {
    const { runtime: codex, spawned } = runtime(HAPPY, "C:\\tools\\codex.exe");
    const turn = input();

    turn.env = { PATH: "C:\\bin", OPENAI_API_KEY: "must-not-leak" };

    await codex.turn(turn, recorder().sink);

    const [s] = spawned;

    expect(s?.file).toBe("C:\\tools\\codex.exe");
    expect(s?.cwd).toBe("C:\\work");
    expect(s?.env).toEqual({ PATH: "C:\\bin" });
    expect(s?.args.slice(0, 3)).toEqual(["app-server", "--listen", "stdio://"]);
    expect(s?.args).toEqual(
      expect.arrayContaining([
        'model="gpt-5.5"',
        'sandbox_mode="workspace-write"',
        `mcp_servers.noctis.command=${JSON.stringify(process.execPath)}`,
        `mcp_servers.noctis.args=${JSON.stringify([
          "C:\\noctis\\dist\\noctis-mcp.js",
          "--proposals",
          // Named for the thread, because the MCP child it is handed lives as long as the thread's process.
          join(scratch, "proposals", "0199a000-0000-7000-8000-0000000000e1.jsonl"),
        ])}`,
      ]),
    );
    expect(s?.args.filter((arg) => /api[_-]?key/i.test(arg))).toEqual([]);
    expect(s?.args.filter((arg) => arg.startsWith("approval_policy"))).toEqual([]);
  });

  it("leaves the owner's ~/.codex as it is: no plugin, app or MCP server switched off", async () => {
    const { runtime: codex, spawned } = runtime(HAPPY);

    await codex.turn(input(), recorder().sink);

    expect(spawned[0]?.args).not.toContain("--disable");
    expect(spawned[0]?.args.filter((arg) => arg.endsWith(".enabled=false"))).toEqual([]);
  });

  it("installs the Noctis rules into the Codex home before the app-server starts", async () => {
    const { runtime: codex } = runtime(HAPPY);

    await codex.turn(input(), recorder().sink);

    expect(readFileSync(join(scratch, "codex-home", "rules", "noctis.rules"), "utf8")).toBe(
      NOCTIS_CODEX_RULES,
    );
  });

  it("fails the turn with the timeout's own words when nobody answers Codex's ask", async () => {
    const { runtime: codex, spawned } = runtime(HAPPY);
    const r = recorder();

    r.sink.ask = () => Promise.reject(new ApprovalTimedOut("echo hi", 600_000));

    await expect(codex.turn(input(), r.sink)).rejects.toThrow(
      'approval timed out: "echo hi" was not answered within 10 minutes',
    );
    // A process left mid-ask is not one the next turn should inherit.
    expect(spawned[0]?.child.killed).toBe(true);
  });

  it("fails the turn when app-server exits before the turn completed", async () => {
    const { runtime: codex } = runtime({
      turn(_server, spawned) {
        spawned.child.stderr.write("panic: something\n");
        spawned.child.exitCode = 3;
        spawned.child.emit("exit", 3, null);

        return Promise.resolve();
      },
    });

    await expect(codex.turn(input(), recorder().sink)).rejects.toThrow(
      /exited \(3\) before the turn completed: panic: something/,
    );
  });

  it("grants a permission profile for the turn only when the core allows", async () => {
    const answers: unknown[] = [];
    const scenario: Scenario = {
      async turn(server, spawned) {
        answers.push(
          await server.request("item/permissions/requestApproval", {
            threadId: spawned.threadId,
            turnId: TURN_ID,
            itemId: "p1",
            environmentId: null,
            startedAtMs: 0,
            cwd: "C:\\work",
            reason: "needs the network",
            permissions: { network: { enabled: true }, fileSystem: null },
          }),
        );
        server.notify("turn/completed", turnCompleted(spawned, "completed"));
      },
    };

    const allowed = recorder("allow");

    await runtime(scenario).runtime.turn(input(), allowed.sink);

    expect(allowed.asks).toEqual([
      {
        itemId: "p1",
        kind: "permission",
        summary: "needs the network",
        operationClass: "external_write",
        reversibility: "partially_reversible",
        capability: "runtime.permission",
        target: { type: "permission", id: "network" },
        detail: { cwd: "C:\\work" },
        askedBy: "runtime",
      },
    ]);
    expect(answers[0]).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });

    await runtime(scenario).runtime.turn(input(), recorder("deny").sink);

    expect(answers[1]).toEqual({ permissions: {}, scope: "turn" });
  });

  it("answers questions with nothing, and refuses requests it does not know", async () => {
    const outcomes: unknown[] = [];
    const { runtime: codex } = runtime({
      async turn(server, spawned) {
        outcomes.push(
          await server.request("item/tool/requestUserInput", {
            threadId: spawned.threadId,
            turnId: TURN_ID,
            itemId: "q1",
            questions: [],
            isBlocking: true,
            autoResolutionMs: null,
          }),
        );
        outcomes.push(
          await server.request("mcpServer/elicitation/request", {
            threadId: spawned.threadId,
            turnId: TURN_ID,
            serverName: "x",
            mode: "form",
            _meta: null,
            message: "?",
            requestedSchema: {},
          }),
        );
        outcomes.push(
          await server.request("item/tool/call", { itemId: "d1" }).catch((error: unknown) => error),
        );
        server.notify("turn/completed", turnCompleted(spawned, "completed"));
      },
    });
    const r = recorder();

    await codex.turn(input(), r.sink);

    expect(outcomes[0]).toEqual({ answers: {} });
    expect(outcomes[1]).toEqual({ action: "decline", content: null, _meta: null });
    expect(outcomes[2]).toMatchObject({ code: -32601 });
    expect(r.items).toEqual([
      {
        itemId: "q1",
        kind: "agent_message",
        status: "completed",
        text: "Noctis does not answer runtime questions mid-turn; continue without the input.",
      },
      {
        itemId: "elicitation",
        kind: "agent_message",
        status: "completed",
        text: "Noctis does not answer runtime questions mid-turn; continue without the input.",
      },
    ]);
  });

  describe("one app-server per thread", () => {
    /** One reply per turn/start, echoing the prompt. */
    const REPLY: Scenario = {
      turn(server, spawned) {
        const starts = spawned.requests.get("turn/start") ?? [];
        const last = starts[starts.length - 1] as { input: Array<{ text: string }> };

        server.notify(
          "item/completed",
          itemNotification(spawned, {
            type: "agentMessage",
            id: `m${String(starts.length)}`,
            text: `re: ${last.input[0]?.text ?? ""}`,
          }),
        );
        server.notify("turn/completed", turnCompleted(spawned, "completed"));

        return Promise.resolve();
      },
    };

    const idle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it("THE GATE: the second message in a thread reuses the process: one spawn, one thread, two turns", async () => {
      const { runtime: codex, spawned } = runtime(REPLY);

      const first = await codex.turn(input(), recorder().sink);
      const second = await codex.turn(
        input({ prompt: "and again", sessionRef: first.sessionRef }),
        recorder().sink,
      );
      const [s] = spawned;

      expect(spawned).toHaveLength(1);
      expect(s?.requests.get("initialize")).toHaveLength(1);
      expect(s?.requests.get("thread/start")).toHaveLength(1);
      expect(s?.requests.has("thread/resume")).toBe(false);
      expect(
        (
          s?.requests.get("turn/start") as Array<{
            threadId: string;
            input: Array<{ text: string }>;
          }>
        ).map((p) => [p.threadId, p.input[0]?.text]),
      ).toEqual([
        ["thread-1", "say hello"],
        ["thread-1", "and again"],
      ]);
      expect([first.finalText, second.finalText]).toEqual(["re: say hello", "re: and again"]);
      expect(second.sessionRef).toBe("thread-1");
      expect(s?.child.killed).toBe(false);

      codex.close?.();
    });

    it("closes an idle process, and the next message resumes the thread in a new one", async () => {
      const { runtime: codex, spawned } = runtime(REPLY, undefined, 20);

      const first = await codex.turn(input(), recorder().sink);

      await idle(60);
      expect(spawned[0]?.child.killed).toBe(true);

      const second = await codex.turn(
        input({ prompt: "back again", sessionRef: first.sessionRef }),
        recorder().sink,
      );

      expect(spawned).toHaveLength(2);
      expect(spawned[1]?.requests.get("thread/resume")).toEqual([
        expect.objectContaining({ threadId: "thread-1" }),
      ]);
      expect(second.finalText).toBe("re: back again");

      codex.close?.();
    });

    it("reopens rather than reuse when the core names no session, or the process died", async () => {
      const { runtime: codex, spawned } = runtime(REPLY);

      const first = await codex.turn(input(), recorder().sink);

      await codex.turn(input(), recorder().sink);
      expect(spawned).toHaveLength(2);
      expect(spawned[0]?.child.killed).toBe(true);

      spawned[1]?.child.kill();
      await codex.turn(input({ sessionRef: first.sessionRef }), recorder().sink);
      expect(spawned).toHaveLength(3);

      codex.close?.();
    });

    it("keeps threads apart, and close() ends every live process", async () => {
      const { runtime: codex, spawned } = runtime(REPLY);

      await codex.turn(input(), recorder().sink);
      await codex.turn(
        input({ threadId: "0199a000-0000-7000-8000-0000000000e9" }),
        recorder().sink,
      );

      expect(spawned).toHaveLength(2);
      codex.close?.();
      expect(spawned.map((s) => s.child.killed)).toEqual([true, true]);
    });

    it("runs a thread's turns one at a time", async () => {
      const { runtime: codex, spawned } = runtime(REPLY);

      // The second arrives before the first has a thread; it waits, then reuses what the first opened.
      const [a, b] = await Promise.all([
        codex.turn(input({ prompt: "one" }), recorder().sink),
        codex.turn(input({ prompt: "two", sessionRef: "thread-1" }), recorder().sink),
      ]);

      expect([a.finalText, b.finalText]).toEqual(["re: one", "re: two"]);
      expect(spawned).toHaveLength(1);

      codex.close?.();
    });
  });

  it("reports itself as the codex provider", () => {
    expect(runtime(HAPPY).runtime.providerId).toBe("codex");
  });
});
