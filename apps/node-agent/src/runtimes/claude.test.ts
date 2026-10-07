import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RuntimeAnswer, RuntimeAsk, RuntimeItem, RuntimeTurnPayload } from "@noctis/contracts";
import { RuntimeItemSchema, RuntimeTurnEvidenceSchema } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import type { RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { AdapterRefused, ApprovalTimedOut } from "./Runtime.js";
import type { ClaudeQuery } from "./claude.js";
import { createClaudeRuntime } from "./claude.js";
import { PLAYWRIGHT_SERVER } from "./mcp-config.js";

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

  it("loads the owner's real setup: every setting source, every skill, auto mode, the payload's model", async () => {
    const { query, calls } = scripted(list(init(), result()));

    await createClaudeRuntime({ query }).turn(input(), recorder().sink);

    const [call] = calls;
    const options = call?.options;
    const first = await call?.prompt[Symbol.asyncIterator]().next();

    expect(first?.value).toMatchObject({
      type: "user",
      message: { role: "user", content: "say hello" },
      parent_tool_use_id: null,
    });
    expect(options).toMatchObject({
      cwd: "C:\\work",
      additionalDirectories: ["C:\\ref"],
      env: { PATH: "C:\\bin" },
      model: "sonnet",
      permissionMode: "auto",
      settingSources: ["user", "project", "local"],
      skills: "all",
      includePartialMessages: true,
    });
    expect(options?.strictMcpConfig).toBe(undefined);
    expect(options?.hooks?.PreToolUse).toHaveLength(1);
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

  describe("permissions: the agent decides the everyday, Noctis confirms the consequential", () => {
    /** A turn held open, so its tool calls have someone to ask. */
    async function held(decision: RuntimeAnswer["decision"] = "allow", reason?: string) {
      const { query, calls } = scripted(async function* () {
        yield init();
        await new Promise(() => undefined);
      });
      const r = recorder(decision, reason);
      const turn = createClaudeRuntime({ query }).turn(input(), r.sink);

      turn.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const options = calls[0]?.options;
      const canUseTool = options?.canUseTool;
      const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];

      if (canUseTool === undefined || hook === undefined) {
        throw new Error("no canUseTool or PreToolUse hook");
      }

      return {
        r,
        turn,
        options,
        /** Noctis's gate: every tool call, before the agent's own permission system sees it. */
        gate: (toolName: string, toolInput: Record<string, unknown>) =>
          hook(
            {
              hook_event_name: "PreToolUse",
              tool_name: toolName,
              tool_input: toolInput,
              tool_use_id: "tu-1",
              session_id: SESSION,
              transcript_path: "",
              cwd: ROOTS.cwd,
            },
            "tu-1",
            { signal: SIGNAL },
          ),
        /** The agent's own permission system asking. */
        agentAsks: (toolName: string, toolInput: Record<string, unknown>) =>
          canUseTool(toolName, toolInput, {
            signal: SIGNAL,
            toolUseID: "tu-1",
            requestId: "req-1",
          }),
      };
    }

    const allowed = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "confirmed in Noctis",
      },
    };

    function denied(reason: string) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    }

    it("stops an external write before it runs, asks the core, and lets it run once confirmed", async () => {
      const { r, gate } = await held("allow");

      await expect(gate("Bash", { command: "git push origin main" })).resolves.toEqual(allowed);
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
          askedBy: "noctis",
        },
      ]);
    });

    it("turns the core's deny into a deny, in the core's words or a fixed one", async () => {
      await expect(
        (await held("deny", "not now")).gate("Bash", { command: "git push" }),
      ).resolves.toEqual(denied("not now"));
      await expect(
        (await held("deny")).gate("Write", { file_path: "C:\\elsewhere\\x.ts" }),
      ).resolves.toEqual(denied("declined by Noctis authority"));
    });

    it("leaves everything below confirm-level to the agent's own permission system", async () => {
      const { r, gate } = await held("deny");

      for (const [name, toolInput] of [
        ["Read", { file_path: "C:\\work\\a.ts" }],
        ["Glob", { pattern: "**/*.ts" }],
        ["Bash", { command: "git status" }],
        [
          "Bash",
          {
            command: `"C:\\WINDOWS\\powershell.exe" -Command "Get-Content -Raw 'C:\\x\\SKILL.md'"`,
          },
        ],
        ["Bash", { command: "npm test" }],
        ["Edit", { file_path: "C:\\work\\a.ts" }],
        ["Skill", { skill: "brainstorming" }],
        ["WebFetch", { url: "https://example.com" }],
        ["WebSearch", { query: "noctis" }],
        ["Agent", { description: "look", subagent_type: "Explore" }],
        ["mcp__github__get_issue", { number: 1 }],
        ["mcp__noctis__noctis_propose_surface", { surfaceKind: "card" }],
      ] as const) {
        await expect(gate(name, toolInput), name).resolves.toEqual({});
      }

      expect(r.asks).toEqual([]);
    });

    it("stops an edit outside every writable root, an MCP send, and a tool it does not know", async () => {
      const { r, gate } = await held("allow");

      await gate("Write", { file_path: "C:\\ref\\b.ts" });
      await gate("mcp__slack__send_message", { text: "hi" });
      await gate("SomethingNew", {});

      expect(r.asks.map((ask) => [ask.kind, ask.operationClass, ask.target.id])).toEqual([
        ["file_change", "external_write", "C:\\ref\\b.ts"],
        ["tool_call", "external_write", "mcp__slack__send_message"],
        ["tool_call", "external_write", "SomethingNew"],
      ]);
    });

    it("asks about an allowlisted browser tool and refuses the rest of that server outright", async () => {
      const { r, gate } = await held("allow");

      await expect(
        gate("mcp__playwright__browser_navigate", { url: "https://example.com" }),
      ).resolves.toEqual(allowed);
      await expect(
        gate("mcp__playwright__browser_evaluate", { function: "() => 1" }),
      ).resolves.toEqual(denied("mcp__playwright__browser_evaluate is not a tool Noctis lends"));

      // One ask, for the navigate. The refusal is never a decision the owner is handed.
      expect(r.asks.map((ask) => [ask.kind, ask.operationClass, ask.target.id])).toEqual([
        ["tool_call", "external_write", "mcp__playwright__browser_navigate"],
      ]);
    });

    it("forwards every ask the agent's own permission system raises, even a read, as the agent's", async () => {
      const { r, agentAsks } = await held("allow");
      const toolInput = { file_path: "C:\\work\\a.ts" };

      await expect(agentAsks("Read", toolInput)).resolves.toEqual({
        behavior: "allow",
        updatedInput: toolInput,
      });
      expect(r.asks).toEqual([
        {
          itemId: "tu-1",
          kind: "tool_call",
          summary: "call Read",
          operationClass: "read_inspect",
          reversibility: "reversible",
          capability: "runtime.tool_call",
          target: { type: "tool_call", id: "Read" },
          detail: { tool: "Read" },
          askedBy: "runtime",
        },
      ]);
    });

    it("turns the owner's no to the agent's ask into a deny", async () => {
      await expect(
        (await held("deny", "not now")).agentAsks("Bash", { command: "npm test" }),
      ).resolves.toEqual({ behavior: "deny", message: "not now" });
    });

    it("fails the turn with the timeout's own words when nobody answers, and closes the CLI", async () => {
      const { r, gate, turn, options } = await held();

      r.sink.ask = () => Promise.reject(new ApprovalTimedOut("git push", 600_000));

      await expect(gate("Bash", { command: "git push" })).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      await expect(turn).rejects.toThrow(
        'approval timed out: "git push" was not answered within 10 minutes',
      );
      expect(options?.abortController?.signal.aborted).toBe(true);
    });

    it("refuses a tool call that arrives between turns, when nobody could answer it", async () => {
      const { query, calls } = scripted(list(init(), result()));
      const r = recorder("allow");

      await createClaudeRuntime({ query }).turn(input(), r.sink);

      await expect(
        calls[0]?.options?.canUseTool?.(
          "Bash",
          { command: "git push" },
          { signal: SIGNAL, toolUseID: "tu-1", requestId: "req-1" },
        ),
      ).resolves.toEqual({ behavior: "deny", message: "no Noctis turn is running" });
      expect(r.asks).toEqual([]);
    });
  });

  it("gives the browser its own profile per thread, so two threads do not share cookies", async () => {
    const env = { PATH: "C:\\bin", NOCTIS_NODE_HOME: "C:\\noctis" };
    const { query, calls } = scripted(list(init(), result()));
    const runtime = createClaudeRuntime({ query });
    const other = "0199a000-0000-7000-8000-0000000000e9";

    await runtime.turn(input({}, undefined, env), recorder().sink);
    await runtime.turn(input({ threadId: other }, undefined, env), recorder().sink);

    const dirs = calls.map((call) => {
      const server = call.options?.mcpServers?.[PLAYWRIGHT_SERVER];
      const args = server !== undefined && "args" in server ? (server.args ?? []) : [];

      return args[args.indexOf("--user-data-dir") + 1];
    });

    expect(dirs).toEqual([
      join("C:\\noctis", "browser", payload().threadId),
      join("C:\\noctis", "browser", other),
    ]);
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
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { query, calls } = scripted(async function* () {
      yield init();
      await held;
      yield result();
    });
    const r = recorder();
    const turn = createClaudeRuntime({ query }).turn(input(), r.sink);

    await new Promise((resolve) => setTimeout(resolve, 0));

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
      "noctis_remember_preference",
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
    release();
    await turn;
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

  describe("one CLI per thread", () => {
    /** A CLI kept open: one reply and one result for every message it is streamed. */
    function conversational() {
      const prompts: string[] = [];
      const fake = scripted(async function* (params) {
        yield init();

        for await (const message of params.prompt) {
          const text = typeof message.message.content === "string" ? message.message.content : "";

          prompts.push(text);
          yield assistant([{ type: "text", text: `re: ${text}` }]);
          yield result({ result: `re: ${text}` });
        }
      });

      return { ...fake, prompts };
    }

    const idle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it("THE GATE: the second message in a thread reuses the process instead of spawning one", async () => {
      const { query, calls, prompts } = conversational();
      const runtime = createClaudeRuntime({ query });

      const first = await runtime.turn(input(), recorder().sink);
      const second = await runtime.turn(
        input({ prompt: "and again", sessionRef: first.sessionRef }),
        recorder().sink,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.options?.abortController?.signal.aborted).toBe(false);
      expect(prompts).toEqual(["say hello", "and again"]);
      expect([first.finalText, second.finalText]).toEqual(["re: say hello", "re: and again"]);
      expect(second.sessionRef).toBe(SESSION);

      runtime.close?.();
    });

    it("closes an idle process, and the next message resumes the session in a new one", async () => {
      const { query, calls } = conversational();
      const runtime = createClaudeRuntime({ query, idleMs: 20 });

      const first = await runtime.turn(input(), recorder().sink);

      await idle(60);
      expect(calls[0]?.options?.abortController?.signal.aborted).toBe(true);

      const second = await runtime.turn(
        input({ prompt: "back again", sessionRef: first.sessionRef }),
        recorder().sink,
      );

      expect(calls).toHaveLength(2);
      expect(calls[1]?.options?.resume).toBe(SESSION);
      expect(second.finalText).toBe("re: back again");

      runtime.close?.();
    });

    it("reopens rather than reuse when the core names no session or another root", async () => {
      const { query, calls } = conversational();
      const runtime = createClaudeRuntime({ query });

      const first = await runtime.turn(input(), recorder().sink);

      // The core holds no session for the thread: whatever the live process remembers is not its.
      await runtime.turn(input(), recorder().sink);
      expect(calls).toHaveLength(2);

      await runtime.turn(
        { ...input({ sessionRef: first.sessionRef }), roots: { ...ROOTS, cwd: "C:\\ref" } },
        recorder().sink,
      );
      expect(calls).toHaveLength(3);
      expect(calls.slice(0, 2).map((c) => c.options?.abortController?.signal.aborted)).toEqual([
        true,
        true,
      ]);

      runtime.close?.();
    });

    it("keeps threads apart, and close() ends every live process", async () => {
      const { query, calls } = conversational();
      const runtime = createClaudeRuntime({ query });

      await runtime.turn(input(), recorder().sink);
      await runtime.turn(
        input({ threadId: "0199a000-0000-7000-8000-0000000000e9" }),
        recorder().sink,
      );

      expect(calls).toHaveLength(2);
      runtime.close?.();
      expect(calls.map((c) => c.options?.abortController?.signal.aborted)).toEqual([true, true]);
    });
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
