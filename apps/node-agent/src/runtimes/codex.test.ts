import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { RuntimeAnswer, RuntimeAsk, RuntimeItem, RuntimeTurnPayload } from "@noctis/contracts";
import { RuntimeItemSchema, RuntimeTurnEvidenceSchema } from "@noctis/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  /** What `config/read` answers; absent, the request fails as an older app-server's would. */
  config?: unknown;
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
        case "config/read":
          return scenario.config === undefined
            ? Promise.reject(new JsonRpcError(-32601, method))
            : Promise.resolve({ config: scenario.config, origins: {}, layers: null });
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
        case "account/rateLimits/read":
          return Promise.resolve({
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent: 14, windowDurationMins: 300, resetsAt: 1_792_435_888 },
              secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_793_003_158 },
              planType: "plus",
            },
          });
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
        case "turn/steer":
          return Promise.resolve({ turnId: TURN_ID });
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
  describe("noctis_delegate", () => {
    const args = {
      runtime: "claude" as const,
      prompt: "Inspect the other PC",
      node: "work-pc",
      threadId: "0199a000-0000-7000-8000-0000000000d1",
    };
    const result = {
      delegationId: "0199a000-0000-7000-8000-0000000000d2",
      outcome: "completed" as const,
      threadId: args.threadId,
      reply: "Ready",
      outputs: [{ mediaType: "image/png", attachmentId: UPLOADED }],
    };

    function calling(arguments_: unknown, outcomes: unknown[], tool = "noctis_delegate"): Scenario {
      return {
        async turn(server, spawned) {
          outcomes.push(
            await server
              .request("item/tool/call", {
                threadId: spawned.threadId,
                turnId: TURN_ID,
                callId: "delegate-1",
                tool,
                arguments: arguments_,
              })
              .catch((error: unknown) => error),
          );
          server.notify("turn/completed", turnCompleted(spawned, "completed"));
        },
      };
    }

    it("advertises the shared delegation input on new threads and opts into dynamic tools", async () => {
      const { runtime: codex, spawned } = runtime(HAPPY);
      await codex.turn(input(), recorder().sink);

      expect(spawned[0]?.requests.get("initialize")).toEqual([
        expect.objectContaining({ capabilities: { experimentalApi: true } }),
      ]);
      expect(spawned[0]?.requests.get("thread/start")).toEqual([
        expect.objectContaining({
          dynamicTools: [
            {
              type: "function",
              name: "noctis_delegate",
              description: expect.stringContaining("wait for its answer") as string,
              inputSchema: expect.objectContaining({
                type: "object",
                required: ["runtime", "prompt"],
                additionalProperties: false,
                properties: {
                  runtime: expect.objectContaining({
                    enum: ["codex", "claude", "hermes", "local"],
                  }) as unknown,
                  prompt: expect.objectContaining({ minLength: 1, maxLength: 20_000 }) as unknown,
                  threadId: expect.any(Object) as unknown,
                  node: expect.any(Object) as unknown,
                },
              }) as unknown,
            },
          ],
        }),
      ]);
    });

    it("waits for the current sink and returns the same result text on reused and resumed turns", async () => {
      const outcomes: unknown[] = [];
      const delegations: unknown[] = [];
      const { runtime: codex, spawned } = runtime(calling(args, outcomes));
      let release!: (value: typeof result) => void;
      let entered!: () => void;
      const delegated = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const first = recorder();
      first.sink.delegate = (delegation) => {
        delegations.push(delegation);
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      };
      const turn = codex.turn(input(), first.sink);
      await delegated;
      expect(outcomes).toEqual([]);
      release(result);
      const evidence = await turn;

      const next = recorder();
      next.sink.delegate = (delegation) => {
        delegations.push(delegation);
        return Promise.resolve(result);
      };
      await codex.turn(input({ sessionRef: evidence.sessionRef }), next.sink);
      expect(spawned).toHaveLength(1);
      spawned[0]?.child.kill();
      await codex.turn(input({ sessionRef: evidence.sessionRef }), next.sink);
      expect(spawned[1]?.requests.get("thread/resume")).toEqual([
        expect.objectContaining({ threadId: evidence.sessionRef }),
      ]);
      expect(delegations).toEqual([args, args, args]);
      expect(outcomes).toEqual(
        Array.from({ length: 3 }, () => ({
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                outcome: result.outcome,
                threadId: result.threadId,
                reply: result.reply,
                outputs: result.outputs,
              }),
            },
          ],
          success: true,
        })),
      );
      await codex.close?.();
    });

    it.each(["failed", "refused"] as const)(
      "returns a %s delegation as an error result",
      async (outcome) => {
        const outcomes: unknown[] = [];
        const r = recorder();
        r.sink.delegate = () => Promise.resolve({ ...result, outcome, reason: "unavailable" });
        await runtime(calling(args, outcomes)).runtime.turn(input(), r.sink);
        expect(outcomes).toEqual([
          {
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({
                  outcome,
                  threadId: result.threadId,
                  reply: result.reply,
                  outputs: result.outputs,
                  reason: "unavailable",
                }),
              },
            ],
            success: false,
          },
        ]);
      },
    );

    it.each([new Error("disconnected"), "disconnected"])(
      "returns a thrown delegation failure as tool text (%s)",
      async (error) => {
        const outcomes: unknown[] = [];
        const r = recorder();
        r.sink.delegate = vi.fn<RuntimeSink["delegate"]>().mockRejectedValue(error);
        await runtime(calling(args, outcomes)).runtime.turn(input(), r.sink);
        expect(outcomes).toEqual([
          {
            contentItems: [
              {
                type: "inputText",
                text: `delegation did not finish: ${error instanceof Error ? error.message : "unknown"}`,
              },
            ],
            success: false,
          },
        ]);
      },
    );

    it.each([
      { ...args, prompt: "" },
      { ...args, runtime: "unknown" },
      { ...args, threadId: "not-a-uuid" },
      { ...args, delegationId: result.delegationId },
    ])("rejects invalid delegation arguments before calling the sink (%j)", async (invalid) => {
      const outcomes: unknown[] = [];
      let called = false;
      const r = recorder();
      r.sink.delegate = () => {
        called = true;
        return Promise.resolve(result);
      };
      await runtime(calling(invalid, outcomes)).runtime.turn(input(), r.sink);
      expect(called).toBe(false);
      expect(outcomes).toEqual([
        expect.objectContaining({
          success: false,
          contentItems: [expect.objectContaining({ type: "inputText" })],
        }),
      ]);
    });

    it("refuses an unknown dynamic tool without delegating", async () => {
      const outcomes: unknown[] = [];
      await runtime(calling(args, outcomes, "other_tool")).runtime.turn(input(), recorder().sink);
      expect(outcomes).toEqual([expect.objectContaining({ code: -32601 })]);
    });
  });

  it("advertises every proposable kind through the stdio MCP used by Codex", async () => {
    const directory = mkdtempSync(join(tmpdir(), "noctis-panel-tools-"));
    const client = new Client({ name: "panel-description-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../../dist/noctis-mcp.js", import.meta.url)),
        "--proposals",
        join(directory, "proposals.jsonl"),
      ],
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      for (const kind of ["reminder", "task", "note", "task_action"])
        expect(tools.tools.some((tool) => tool.name === `noctis_propose_${kind}`)).toBe(true);
      for (const [kind, args] of [
        ["reminder", { text: "Tax", trigger: null }],
        [
          "task",
          {
            name: "Review",
            prompt: "Review repo",
            model: { providerId: "codex", model: "gpt-5.4" },
            nodeId: "0199a000-0000-7000-8000-0000000000e1",
            rootGrantId: "repo",
            trigger: {
              kind: "at_pc",
              nodeId: "0199a000-0000-7000-8000-0000000000e1",
              repeat: false,
            },
          },
        ],
        ["note", { title: "Thought", body: "Keep this" }],
        ["task_action", { taskId: "0199a000-0000-7000-8000-0000000000e1", action: "run_now" }],
      ] as const) {
        const captured = await client.callTool({ name: `noctis_propose_${kind}`, arguments: args });
        expect(captured.isError).not.toBe(true);
        expect(
          JSON.parse(
            readFileSync(join(directory, "proposals.jsonl"), "utf8").trim().split("\n").at(-1)!,
          ),
        ).toMatchObject({ kind, ...args });
      }
      const description = tools.tools.find(
        (tool) => tool.name === "noctis_propose_surface",
      )?.description;
      for (const kind of [
        "document",
        "list",
        "detail",
        "evidence",
        "attention",
        "timeline",
        "verification",
      ])
        expect(description).toContain(kind);
    } finally {
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
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
    await codex.close?.();
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
    await codex.close?.();
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
    await codex.close?.();
  });

  it("THE GATE: hands the owner's mid-turn message to the running turn with turn/steer", async () => {
    let steer: ((text: string) => boolean | Promise<boolean>) | undefined;
    let accepted: boolean | undefined;
    const { runtime: codex, spawned } = runtime({
      async turn(server, record) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        accepted = await steer?.("use the blue one");
        server.notify("turn/completed", turnCompleted(record, "completed"));
      },
    });
    const recorded = recorder();
    recorded.sink.steerable = (handler) => {
      steer = handler;
    };

    await codex.turn(input(), recorded.sink);

    expect(accepted).toBe(true);
    expect(spawned[0]?.requests.get("turn/steer")).toEqual([
      {
        threadId: "thread-1",
        expectedTurnId: TURN_ID,
        input: [{ type: "text", text: "use the blue one", text_elements: [] }],
      },
    ]);
    expect(await steer?.("too late")).toBe(false);

    await codex.close?.();
  });

  it("drives initialize → thread/start → turn/start and maps every item, delta, and ask", async () => {
    const { runtime: codex, spawned } = runtime(HAPPY);
    const r = recorder();

    const evidence = RuntimeTurnEvidenceSchema.parse(await codex.turn(input(), r.sink));
    const [s] = spawned;

    expect(s?.requests.get("initialize")).toEqual([
      {
        clientInfo: { name: "noctis-node-agent", title: null, version: "0.0.0" },
        capabilities: { experimentalApi: true },
      },
    ]);
    expect(s?.requests.get("thread/start")).toEqual([
      {
        cwd: "C:\\work",
        model: "gpt-5.5",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        developerInstructions: expect.stringContaining("You are Vesper") as string,
        dynamicTools: expect.arrayContaining([
          expect.objectContaining({ name: "noctis_delegate" }),
        ]) as unknown,
      },
    ]);
    expect(s?.requests.get("turn/start")).toEqual([
      {
        threadId: "thread-1",
        input: [
          { type: "text", text: "say hello", text_elements: [] },
          {
            type: "text",
            text: expect.stringContaining("<noctis-clock>") as string,
            text_elements: [],
          },
        ],
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
        summary: "Runs echo",
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

  it("runs workspace-write with approval on-request, and the network off when the config is unread", async () => {
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

  it("keeps the network the owner's own Codex config gives it", async () => {
    const { runtime: codex, spawned } = runtime({
      ...HAPPY,
      config: { sandbox_workspace_write: { network_access: true, writable_roots: [] } },
    });

    await codex.turn(input(), recorder().sink);

    expect(spawned[0]?.requests.get("config/read")).toEqual([{ cwd: "C:\\work" }]);
    expect(spawned[0]?.requests.get("turn/start")).toEqual([
      expect.objectContaining({
        sandboxPolicy: expect.objectContaining({ networkAccess: true }) as unknown,
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

  it("reads the 5-hour and weekly limits Codex reports, from an app-server it then stops", async () => {
    const { runtime: codex, spawned } = runtime(HAPPY);

    expect(await codex.readLimits?.("C:\\work", { PATH: "C:\\bin" })).toEqual({
      fiveHour: { usedPercent: 14, resetsAt: new Date(1_792_435_888_000).toISOString() },
      weekly: { usedPercent: 10, resetsAt: new Date(1_793_003_158_000).toISOString() },
    });
    expect(spawned[0]?.requests.has("account/rateLimits/read")).toBe(true);
    expect(spawned[0]?.child.killed).toBe(true);
  });

  it("reads a folder's thread's last turns as exchanges, newest last", async () => {
    const turn = (prompt: string, ...replies: string[]) => ({
      id: prompt,
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "u",
          content: [
            { type: "text", text: prompt },
            {
              type: "text",
              text: "<noctis-clock>\nCurrent time: 2026-10-14T09:00:00Z\n</noctis-clock>",
            },
          ],
        },
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

  it("waits for OS exit after cancellation even when the app-server acknowledges interruption", async () => {
    const controller = new AbortController();
    const { runtime: codex, spawned } = runtime({ turn: () => Promise.resolve() });
    let settled = false;
    const turn = codex.turn(input({}, controller.signal), recorder().sink).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const child = spawned[0]!.child;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      expect(settled).toBe(false);
      expect(child.killed).toBe(true);
    } finally {
      child.exitCode = 1;
      child.emit("exit", 1, null);
      await turn;
    }
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
    expect(s?.env).toEqual({ PATH: "C:\\bin", NOCTIS_RUNTIME_SESSION: "1" });
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
          await server
            .request("item/tool/call", {
              threadId: spawned.threadId,
              turnId: TURN_ID,
              callId: "d1",
              tool: "unknown",
              arguments: {},
            })
            .catch((error: unknown) => error),
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

  it("lends the owner's browser and desktop, with Codex made to ask about every tool on them", async () => {
    const exe = join(scratch, "windows-mcp.exe");
    writeFileSync(exe, "");
    const { runtime: codex, spawned } = runtime(HAPPY);
    const turn = input();

    turn.env = { PATH: "C:\\bin", NOCTIS_WINDOWS_MCP: exe, NOCTIS_BROWSER_EXTENSION_TOKEN: "tok" };

    await codex.turn(turn, recorder().sink);

    const args = spawned[0]?.args ?? [];
    const browserArgs = JSON.parse(
      args.find((arg) => arg.startsWith("mcp_servers.browser.args="))?.slice(25) ?? "[]",
    ) as string[];

    expect(args).toEqual(
      expect.arrayContaining([
        `mcp_servers.browser.command=${JSON.stringify(process.execPath)}`,
        'mcp_servers.browser.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN="tok"',
        'mcp_servers.browser.default_tools_approval_mode="prompt"',
        `mcp_servers.desktop.command=${JSON.stringify(exe)}`,
        `mcp_servers.desktop.args=${JSON.stringify(["serve", "--exclude-tools", "PowerShell,FileSystem,Registry,Process"])}`,
        'mcp_servers.desktop.env.ANONYMIZED_TELEMETRY="false"',
        'mcp_servers.desktop.default_tools_approval_mode="prompt"',
      ]),
    );
    expect(browserArgs).toContain("--extension");

    const bare = runtime(HAPPY);

    await bare.runtime.turn(input(), recorder().sink);

    expect(bare.spawned[0]?.args.filter((arg) => arg.startsWith("mcp_servers.desktop."))).toEqual(
      [],
    );
  });

  describe("an MCP tool call Codex asks about", () => {
    function toolApproval(
      spawned: Spawned,
      serverName: string,
      tool: string,
      params: unknown,
    ): unknown {
      return {
        threadId: spawned.threadId,
        turnId: TURN_ID,
        serverName,
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_description: "a tool",
          tool_params: params,
          tool_params_display: [],
        },
        message: `Allow the ${serverName} MCP server to run tool "${tool}"?`,
        requestedSchema: { type: "object", properties: {} },
      };
    }

    function asking(
      calls: Array<[serverName: string, tool: string, params: unknown]>,
      outcomes: unknown[],
    ): Scenario {
      return {
        async turn(server, spawned) {
          for (const [index, [serverName, tool, params]] of calls.entries()) {
            server.notify(
              "item/started",
              itemNotification(spawned, {
                type: "mcpToolCall",
                id: `t${String(index)}`,
                server: serverName,
                tool,
                status: "inProgress",
                arguments: params,
              }),
            );
            outcomes.push(
              await server.request(
                "mcpServer/elicitation/request",
                toolApproval(spawned, serverName, tool, params),
              ),
            );
          }

          server.notify("turn/completed", turnCompleted(spawned, "completed"));
        },
      };
    }

    const accept = { action: "accept", content: null, _meta: null };
    const decline = { action: "decline", content: null, _meta: null };

    it("runs a step on the owner's screen and Noctis's own tools without asking anyone", async () => {
      const outcomes: unknown[] = [];
      const r = recorder("deny");

      await runtime(
        asking(
          [
            ["browser", "browser_click", { element: "Search button", ref: "e3" }],
            ["desktop", "Click", { loc: [10, 20] }],
            ["noctis", "noctis_propose_objective", { title: "x" }],
          ],
          outcomes,
        ),
      ).runtime.turn(input(), r.sink);

      expect(outcomes).toEqual([accept, accept, accept]);
      expect(r.asks).toEqual([]);
    });

    it("refuses raw code in the page without asking", async () => {
      const outcomes: unknown[] = [];
      const r = recorder("allow");

      await runtime(
        asking([["browser", "browser_evaluate", { function: "() => 1" }]], outcomes),
      ).runtime.turn(input(), r.sink);

      expect(outcomes).toEqual([decline]);
      expect(r.asks).toEqual([]);
    });

    it("asks the owner before a step that commits them, and answers Codex with their decision", async () => {
      const calls: Array<[string, string, unknown]> = [
        ["browser", "browser_click", { element: "Place order", ref: "e9" }],
      ];
      const allowed: unknown[] = [];
      const r = recorder("allow");

      await runtime(asking(calls, allowed)).runtime.turn(input(), r.sink);

      expect(allowed).toEqual([accept]);
      expect(r.asks).toEqual([
        {
          itemId: "t0",
          kind: "tool_call",
          summary: "call mcp__browser__browser_click",
          operationClass: "external_write",
          reversibility: "partially_reversible",
          capability: "runtime.tool_call",
          target: { type: "tool_call", id: "mcp__browser__browser_click" },
          detail: { tool: "mcp__browser__browser_click" },
          askedBy: "runtime",
        },
      ]);

      const denied: unknown[] = [];

      await runtime(asking(calls, denied)).runtime.turn(input(), recorder("deny").sink);

      expect(denied).toEqual([decline]);

      const unanswered: unknown[] = [];
      const failing = recorder();

      failing.sink.ask = () => Promise.reject(new Error("disconnected"));
      await runtime(asking(calls, unanswered)).runtime.turn(input(), failing.sink);

      expect(unanswered).toEqual([{ action: "cancel", content: null, _meta: null }]);
    });
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

      await codex.close?.();
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

      await codex.close?.();
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

      await codex.close?.();
    });

    it("keeps threads apart, and close() ends every live process", async () => {
      const { runtime: codex, spawned } = runtime(REPLY);

      await codex.turn(input(), recorder().sink);
      await codex.turn(
        input({ threadId: "0199a000-0000-7000-8000-0000000000e9" }),
        recorder().sink,
      );

      expect(spawned).toHaveLength(2);
      await codex.close?.();
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

      await codex.close?.();
    });
  });

  it("reports itself as the codex provider", () => {
    expect(runtime(HAPPY).runtime.providerId).toBe("codex");
  });
});
