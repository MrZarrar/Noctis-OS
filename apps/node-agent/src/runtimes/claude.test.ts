import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RuntimeAnswer, RuntimeAsk, RuntimeItem, RuntimeTurnPayload } from "@noctis/contracts";
import { RuntimeItemSchema, RuntimeTurnEvidenceSchema } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import type { RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { AdapterRefused } from "./Runtime.js";
import type { ClaudeQuery } from "./claude.js";
import { createClaudeRuntime } from "./claude.js";

const ROOTS = { cwd: "C:\\work", writable: ["C:\\work"], readable: ["C:\\ref"], localOnly: false };
const SESSION = "0199a000-0000-7000-8000-00000000c1a0";
const SIGNAL = new AbortController().signal;

type Params = Parameters<ClaudeQuery>[0];
type Script = (params: Params) => AsyncIterable<unknown>;

function payload(overrides: Partial<RuntimeTurnPayload> = {}): RuntimeTurnPayload {
  return {
    threadId: "0199a000-0000-7000-8000-0000000000e1",
    identityId: "vesper",
    model: { providerId: "claude", model: "sonnet" },
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
  env: NodeJS.ProcessEnv = { PATH: "C:\\bin" },
): RuntimeTurnInput {
  return { payload: payload(overrides), roots: ROOTS, env, signal };
}

interface Recorded {
  sink: RuntimeSink;
  items: RuntimeItem[];
  deltas: Array<[string, string]>;
  asks: Array<Omit<RuntimeAsk, "askId">>;
}

function recorder(decision: RuntimeAnswer["decision"] = "allow", reason?: string): Recorded {
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
        ...(reason === undefined ? {} : { reason }),
      });
    },
  };

  return recorded;
}

/** A scripted `query`: records what it was called with and plays the script back as SDK messages. */
function scripted(script: Script): { query: ClaudeQuery; calls: Params[] } {
  const calls: Params[] = [];

  return {
    calls,
    query: (params) => {
      calls.push(params);

      return (async function* () {
        for await (const message of script(params)) {
          yield message as SDKMessage;
        }
      })();
    },
  };
}

function list(...messages: unknown[]): Script {
  return async function* () {
    for (const message of messages) {
      yield await Promise.resolve(message);
    }
  };
}

/* The CLI's shapes, cut down to the fields the runtime reads. */

const init = (apiKeySource = "none"): unknown => ({
  type: "system",
  subtype: "init",
  session_id: SESSION,
  apiKeySource,
  cwd: ROOTS.cwd,
  model: "claude-sonnet-5",
  tools: [],
  mcp_servers: [{ name: "noctis", status: "connected" }],
});

const messageStart: unknown = {
  type: "stream_event",
  parent_tool_use_id: null,
  session_id: SESSION,
  event: { type: "message_start", message: {} },
};

const delta = (text: string): unknown => ({
  type: "stream_event",
  parent_tool_use_id: null,
  session_id: SESSION,
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
});

const assistant = (content: unknown[], parent: string | null = null): unknown => ({
  type: "assistant",
  parent_tool_use_id: parent,
  session_id: SESSION,
  message: { role: "assistant", content },
});

const toolUse = (id: string, name: string, toolInput: unknown): unknown => ({
  type: "tool_use",
  id,
  name,
  input: toolInput,
});

const toolResult = (id: string, content: unknown, isError = false): unknown => ({
  type: "user",
  parent_tool_use_id: null,
  session_id: SESSION,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
  },
});

const result = (overrides: Record<string, unknown> = {}): unknown => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Hello",
  num_turns: 1,
  usage: { input_tokens: 12, output_tokens: 5 },
  permission_denials: [],
  session_id: SESSION,
  ...overrides,
});

const HAPPY = list(
  init(),
  messageStart,
  delta("Hel"),
  delta("lo"),
  assistant([{ type: "text", text: "Hello" }]),
  assistant([toolUse("t1", "Bash", { command: "echo hi", description: "greet" })]),
  toolResult("t1", "hi\n"),
  assistant([
    toolUse("t2", "Edit", { file_path: "C:\\work\\a.ts", old_string: "", new_string: "1" }),
  ]),
  toolResult("t2", [{ type: "text", text: "The file C:\\work\\a.ts has been updated." }]),
  assistant([toolUse("t3", "Agent", { description: "look around", subagent_type: "Explore" })]),
  assistant([toolUse("t4", "Read", { file_path: "C:\\work\\b.ts" })], "t3"),
  toolResult("t3", "done"),
  assistant([toolUse("t5", "mcp__noctis__noctis_propose_objective", { title: "x", intent: "y" })]),
  toolResult("t5", "recorded"),
  result(),
);

describe("the Claude Agent SDK runtime", () => {
  it("maps init, deltas, text, tool uses and results onto the same items the Codex route emits", async () => {
    const { query } = scripted(HAPPY);
    const r = recorder();

    const evidence = RuntimeTurnEvidenceSchema.parse(
      await createClaudeRuntime({ query }).turn(input(), r.sink),
    );

    expect(r.deltas).toEqual([
      ["msg-1", "Hel"],
      ["msg-1", "lo"],
    ]);
    expect(r.items).toEqual([
      { itemId: "msg-1", kind: "agent_message", status: "completed", text: "Hello" },
      { itemId: "t1", kind: "command", status: "in_progress", command: "echo hi", cwd: "C:\\work" },
      {
        itemId: "t1",
        kind: "command",
        status: "completed",
        command: "echo hi",
        cwd: "C:\\work",
        output: "hi\n",
      },
      { itemId: "t2", kind: "file_change", status: "in_progress", paths: ["C:\\work\\a.ts"] },
      {
        itemId: "t2",
        kind: "file_change",
        status: "completed",
        paths: ["C:\\work\\a.ts"],
        summary: "The file C:\\work\\a.ts has been updated.",
      },
      { itemId: "t3", kind: "sub_agent", status: "in_progress", label: "look around" },
      {
        itemId: "t4",
        kind: "tool_call",
        status: "in_progress",
        tool: "Read",
        input: { file_path: "C:\\work\\b.ts" },
      },
      { itemId: "t3", kind: "sub_agent", status: "completed", label: "look around" },
      {
        itemId: "t5",
        kind: "tool_call",
        status: "in_progress",
        tool: "noctis_propose_objective",
        input: { title: "x", intent: "y" },
      },
      {
        itemId: "t5",
        kind: "tool_call",
        status: "completed",
        tool: "noctis_propose_objective",
        input: { title: "x", intent: "y" },
        output: "recorded",
      },
    ]);
    expect(evidence).toEqual({
      model: { providerId: "claude", model: "sonnet" },
      sessionRef: SESSION,
      itemCount: 5,
      finalText: "Hello",
      usage: { inputTokens: 12, outputTokens: 5 },
      stoppedReason: "completed",
    });
  });

  it("isolates the spawned CLI: no settings, strict MCP, default permissions, stripped env, the payload's model", async () => {
    const { query, calls } = scripted(list(init(), result()));

    await createClaudeRuntime({ query }).turn(input(), recorder().sink);

    const [call] = calls;
    const options = call?.options;

    expect(call?.prompt).toBe("say hello");
    expect(options).toMatchObject({
      cwd: "C:\\work",
      additionalDirectories: ["C:\\ref"],
      env: { PATH: "C:\\bin" },
      model: "sonnet",
      permissionMode: "default",
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
    });
    expect(options?.resume).toBe(undefined);
    expect(options?.abortController).toBeInstanceOf(AbortController);
    expect(options?.canUseTool).toBeTypeOf("function");
    expect(options?.mcpServers?.noctis).toMatchObject({ type: "sdk", name: "noctis" });
    expect(Object.keys(options?.env ?? {})).not.toContain("ANTHROPIC_API_KEY");
  });

  it("resumes the session the payload names", async () => {
    const { query, calls } = scripted(list(init(), result()));

    await createClaudeRuntime({ query }).turn(input({ sessionRef: SESSION }), recorder().sink);

    expect(calls[0]?.options?.resume).toBe(SESSION);
  });

  it("refuses an environment that still carries a billing key", async () => {
    const { query, calls } = scripted(list(init(), result()));

    await expect(
      createClaudeRuntime({ query }).turn(
        input({}, undefined, { PATH: "C:\\bin", Anthropic_Api_Key: "sk-leak" }),
        recorder().sink,
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
    expect(calls).toEqual([]);
  });

  it("refuses a CLI that authenticated with an API key instead of the claude.ai login", async () => {
    const { query, calls } = scripted(list(init("ANTHROPIC_API_KEY"), result()));

    await expect(createClaudeRuntime({ query }).turn(input(), recorder().sink)).rejects.toThrow(
      /claude_api_key_login_is_metered/,
    );
    expect(calls[0]?.options?.abortController?.signal.aborted).toBe(true);
  });

  describe("canUseTool", () => {
    async function permission(decision: RuntimeAnswer["decision"], reason?: string) {
      const { query, calls } = scripted(list(init(), result()));
      const r = recorder(decision, reason);

      await createClaudeRuntime({ query }).turn(input(), r.sink);

      const canUseTool = calls[0]?.options?.canUseTool;

      if (canUseTool === undefined) {
        throw new Error("no canUseTool");
      }

      return {
        r,
        ask: (toolName: string, toolInput: Record<string, unknown>) =>
          canUseTool(toolName, toolInput, {
            signal: SIGNAL,
            toolUseID: "tu-1",
            requestId: "req-1",
          }),
      };
    }

    it("asks the core about an external write and allows with the input unchanged", async () => {
      const { r, ask } = await permission("allow");
      const toolInput = { command: "git push origin main" };

      await expect(ask("Bash", toolInput)).resolves.toEqual({
        behavior: "allow",
        updatedInput: toolInput,
      });
      expect(r.asks).toEqual([
        {
          itemId: "tu-1",
          kind: "command",
          summary: "git push origin main",
          operationClass: "external_write",
          reversibility: "partially_reversible",
          capability: "runtime.command",
          target: { type: "command", id: "git push origin main" },
          detail: { command: "git push origin main", cwd: "C:\\work" },
        },
      ]);
    });

    it("turns a deny into a deny with the core's reason", async () => {
      const { ask } = await permission("deny", "not now");

      await expect(ask("Bash", { command: "git push" })).resolves.toEqual({
        behavior: "deny",
        message: "not now",
      });
    });

    it("falls back to a fixed message when the deny carries no reason", async () => {
      const { ask } = await permission("deny");

      await expect(ask("Edit", { file_path: "C:\\elsewhere\\x.ts" })).resolves.toEqual({
        behavior: "deny",
        message: "declined by Noctis authority",
      });
    });

    it("classifies every edit through the roots: inside is local, outside is external, both ask", async () => {
      const { r, ask } = await permission("allow");

      await ask("Edit", { file_path: "C:\\work\\a.ts" });
      await ask("Write", { file_path: "C:\\ref\\b.ts" });

      expect(r.asks.map((ask) => [ask.kind, ask.operationClass, ask.detail?.paths])).toEqual([
        ["file_change", "local_reversible_edit", ["C:\\work\\a.ts"]],
        ["file_change", "external_write", ["C:\\ref\\b.ts"]],
      ]);
    });

    it("asks about the web as a permission and about unknown tools as tool calls", async () => {
      const { r, ask } = await permission("allow");

      await ask("WebFetch", { url: "https://example.com" });
      await ask("mcp__browser__click", { selector: "#go" });

      expect(r.asks.map((ask) => [ask.kind, ask.operationClass, ask.target])).toEqual([
        ["permission", "external_write", { type: "permission", id: "WebFetch" }],
        ["tool_call", "external_write", { type: "tool_call", id: "mcp__browser__click" }],
      ]);
    });

    it("allows read_inspect locally without a round trip: Read, a read-only command, the Noctis tools, a sub-agent", async () => {
      const { r, ask } = await permission("deny");

      for (const [name, toolInput] of [
        ["Read", { file_path: "C:\\work\\a.ts" }],
        ["Glob", { pattern: "**/*.ts" }],
        ["Bash", { command: "git status" }],
        ["mcp__noctis__noctis_propose_surface", { surfaceKind: "card" }],
        ["Agent", { description: "look", subagent_type: "Explore" }],
      ] as const) {
        await expect(ask(name, toolInput)).resolves.toEqual({
          behavior: "allow",
          updatedInput: toolInput,
        });
      }

      expect(r.asks).toEqual([]);
    });
  });

  it("marks a tool the core declined as declined when its result comes back as an error", async () => {
    const { query } = scripted(async function* (params) {
      yield init();
      yield assistant([toolUse("t1", "Bash", { command: "git push" })]);
      await params.options?.canUseTool?.(
        "Bash",
        { command: "git push" },
        { signal: SIGNAL, toolUseID: "t1", requestId: "req-1" },
      );
      yield toolResult("t1", "Permission denied", true);
      yield result();
    });
    const r = recorder("deny");

    await createClaudeRuntime({ query }).turn(input(), r.sink);

    expect(r.items.map((item) => item.status)).toEqual(["in_progress", "declined"]);
  });

  it("hosts the Noctis proposal tools in-process and emits each call as a proposal item", async () => {
    const { query, calls } = scripted(list(init(), result()));
    const r = recorder();

    await createClaudeRuntime({ query }).turn(input(), r.sink);

    const server = calls[0]?.options?.mcpServers?.noctis;

    if (server === undefined || server.type !== "sdk") {
      throw new Error("no sdk server");
    }

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });

    await server.instance.connect(serverSide);
    await client.connect(clientSide);

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "noctis_propose_objective",
      "noctis_propose_surface",
    ]);

    const called = await client.callTool({
      name: "noctis_propose_objective",
      arguments: { title: "Suggested", intent: "later" },
    });

    expect(called.content).toEqual([{ type: "text", text: "recorded" }]);
    expect(r.items).toEqual([
      {
        itemId: "proposal-1",
        kind: "proposal",
        status: "completed",
        proposal: { kind: "objective", title: "Suggested", intent: "later" },
      },
    ]);

    await client.close();
  });

  it("reports cancellation when the job's signal aborts mid-turn", async () => {
    const { query } = scripted(async function* (params) {
      yield init();
      await new Promise<void>((resolve) =>
        params.options?.abortController?.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
    });
    const controller = new AbortController();
    const turn = createClaudeRuntime({ query }).turn(input({}, controller.signal), recorder().sink);

    setTimeout(() => controller.abort(), 0);

    await expect(turn).resolves.toMatchObject({ stoppedReason: "cancelled", sessionRef: SESSION });
  });

  it("reports a failed turn when the result is an error", async () => {
    const { query } = scripted(
      list(init(), result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] })),
    );

    const evidence = await createClaudeRuntime({ query }).turn(input(), recorder().sink);

    expect(evidence.stoppedReason).toBe("failed");
    expect(evidence).not.toHaveProperty("finalText");
  });

  it("never spawns claude with --bare anywhere in the agent", () => {
    const src = join(import.meta.dirname, "..");
    const sources = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );

    expect(sources.length).toBeGreaterThan(5);

    for (const name of sources) {
      expect(readFileSync(join(src, name), "utf8"), name).not.toContain(`--${"bare"}`);
    }
  });
});
