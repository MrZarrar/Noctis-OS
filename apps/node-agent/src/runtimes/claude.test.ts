import { spawn } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  RuntimeAnswer,
  RuntimeAsk,
  RuntimeDelegation,
  RuntimeItem,
  RuntimeTurnPayload,
} from "@noctis/contracts";
import { RuntimeItemSchema, RuntimeTurnEvidenceSchema } from "@noctis/contracts";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { AdapterRefused, ApprovalTimedOut } from "./Runtime.js";
import type { ClaudeQuery } from "./claude.js";
import { createClaudeRuntime } from "./claude.js";
import { BROWSER_SERVER, DESKTOP_SERVER } from "./mcp-config.js";

const ROOTS = { cwd: "C:\\work", writable: ["C:\\work"], readable: ["C:\\ref"], localOnly: false };
const SESSION = "0199a000-0000-7000-8000-00000000c1a0";
const SIGNAL = new AbortController().signal;

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

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
  delegations: Array<Omit<RuntimeDelegation, "delegationId">>;
}

function recorder(decision: RuntimeAnswer["decision"] = "allow", reason?: string): Recorded {
  const recorded: Recorded = {
    items: [],
    deltas: [],
    asks: [],
    delegations: [],
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
        ...(reason === undefined ? {} : { reason }),
      });
    },
    delegate: (delegation) => {
      recorded.delegations.push(delegation);

      return Promise.resolve({
        delegationId: "0199a000-0000-7000-8000-0000000000d1",
        outcome: "completed",
        threadId: "0199a000-0000-7000-8000-0000000000c1",
        reply: "frame drawn",
        outputs: [
          {
            mediaType: "image/png",
            path: "C:\\frames\\1.png",
            attachmentId: "0199a000-0000-7000-8000-0000000000f1",
          },
        ],
      });
    },
    upload: () => Promise.reject(new Error("no upload expected")),
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
  assistant([
    toolUse("t3", "Agent", {
      description: "look around",
      subagent_type: "Explore",
      prompt: "Find where the turn ends",
    }),
  ]),
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
      {
        itemId: "t3",
        kind: "sub_agent",
        status: "in_progress",
        label: "look around",
        task: "Find where the turn ends",
      },
      {
        itemId: "t4",
        kind: "tool_call",
        status: "in_progress",
        tool: "Read",
        input: { file_path: "C:\\work\\b.ts" },
        parentItemId: "t3",
      },
      {
        itemId: "t3",
        kind: "sub_agent",
        status: "completed",
        label: "look around",
        task: "Find where the turn ends",
        report: "done",
      },
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
      message: {
        role: "user",
        content: [
          { type: "text", text: "say hello" },
          { type: "text", text: expect.stringContaining("<noctis-clock>") as string },
        ],
      },
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
    // Noctis panels are where work is shown; claude.ai artifacts competed with them.
    expect(options?.disallowedTools).toEqual(
      expect.arrayContaining(["Artifact", "ArtifactComments", "ArtifactData", "DesignSync"]),
    );
    expect(options?.mcpServers?.noctis).toMatchObject({ type: "sdk", name: "noctis" });
    expect(Object.keys(options?.env ?? {})).not.toContain("ANTHROPIC_API_KEY");
  });

  it("tells Vesper who it is through the preset's append, and sends nothing with cards off", async () => {
    const on = scripted(list(init(), result()));
    const off = scripted(list(init(), result()));

    await createClaudeRuntime({ query: on.query }).turn(input(), recorder().sink);
    await createClaudeRuntime({ query: off.query }).turn(
      { ...input(), env: { PATH: "C:\\bin", NOCTIS_IDENTITY_CARDS: "0" } },
      recorder().sink,
    );

    expect(on.calls[0]?.options?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: expect.stringContaining("You are Vesper") as string,
    });
    expect(on.calls[0]?.options?.systemPrompt).toMatchObject({
      append: expect.stringContaining("running as Claude Code on sonnet") as string,
    });
    expect(off.calls[0]?.options?.systemPrompt).toBe(undefined);
  });

  it("resumes the session the payload names", async () => {
    const { query, calls } = scripted(list(init(), result()));

    await createClaudeRuntime({ query }).turn(input({ sessionRef: SESSION }), recorder().sink);

    expect(calls[0]?.options?.resume).toBe(SESSION);
  });

  it("forks a session started outside Noctis instead of writing into it", async () => {
    const { query, calls } = scripted(list(init(), result()));

    await createClaudeRuntime({ query }).turn(
      input({ sessionRef: SESSION, forkSession: true }),
      recorder().sink,
    );

    expect(calls[0]?.options).toMatchObject({ resume: SESSION, forkSession: true });
  });

  it("reads a session's last exchanges: what the owner said and the reply it ended on", async () => {
    const asked: unknown[] = [];
    const message = (type: "user" | "assistant", content: unknown, sub = false) => ({
      type,
      uuid: "u",
      session_id: SESSION,
      message: { role: type, content },
      parent_tool_use_id: sub ? "toolu_parent" : null,
      parent_agent_id: null,
    });
    const runtime = createClaudeRuntime({
      getSessionMessages: (sessionId, options) => {
        asked.push({ sessionId, options });

        return Promise.resolve([
          message("user", "Draft the cold open"),
          message("assistant", [{ type: "thinking", thinking: "hm" }]),
          message("assistant", [{ type: "text", text: "Checking the script first." }]),
          message("assistant", [{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
          message("user", [{ type: "tool_result", tool_use_id: "t1", content: "..." }]),
          // A subagent's own chatter is not the conversation.
          message("user", [{ type: "text", text: "subagent brief" }], true),
          message("assistant", [{ type: "text", text: "Here is the cold open." }]),
          // What VS Code and the harness wrap around a prompt is not the prompt.
          message("user", [
            { type: "text", text: "<ide_opened_file>The user opened script.md</ide_opened_file>" },
            { type: "text", text: "Make it shorter" },
            {
              type: "text",
              text: "<noctis-clock>\nCurrent time: 2026-10-14T09:00:00Z\n</noctis-clock>",
            },
          ]),
          message("assistant", [{ type: "text", text: "Shorter now." }]),
          message("user", "<task-notification><task-id>x</task-id></task-notification>"),
          message("user", [{ type: "text", text: "[Request interrupted by user]" }]),
        ]);
      },
    });

    expect(await runtime.readHistory?.("C:\\work", SESSION, {})).toEqual([
      { prompt: "Draft the cold open", reply: "Here is the cold open." },
      { prompt: "Make it shorter", reply: "Shorter now." },
    ]);
    // Only that folder's store: a session elsewhere on the PC is not found.
    expect(asked).toEqual([{ sessionId: SESSION, options: { dir: "C:\\work" } }]);
  });

  it("lists the folder's own sessions, not the ones programs started", async () => {
    const asked: unknown[] = [];
    const runtime = createClaudeRuntime({
      listSessions: (options) => {
        asked.push(options);

        return Promise.resolve([
          {
            sessionId: "2d234a2a-965d-4952-9497-73754e13c865",
            summary: "Video script refresh",
            lastModified: Date.parse("2026-10-08T15:21:21.567Z"),
          },
          {
            sessionId: "9f9a28b6-53d6-4554-b76b-5ffb3631062c",
            summary: "auto summary",
            customTitle: "Resolve MCP",
            lastModified: Date.parse("2026-10-08T10:40:26.119Z"),
          },
        ]);
      },
    });

    expect(await runtime.listSessions?.("C:\\work", {})).toEqual([
      {
        providerId: "claude",
        sessionRef: "2d234a2a-965d-4952-9497-73754e13c865",
        title: "Video script refresh",
        lastActiveAt: "2026-10-08T15:21:21.567Z",
      },
      {
        providerId: "claude",
        sessionRef: "9f9a28b6-53d6-4554-b76b-5ffb3631062c",
        title: "Resolve MCP",
        lastActiveAt: "2026-10-08T10:40:26.119Z",
      },
    ]);
    // Noctis's own turns run through the SDK too; those are threads already.
    expect(asked).toEqual([
      expect.objectContaining({ dir: "C:\\work", includeProgrammatic: false }),
    ]);
  });

  it("reads the 5-hour and weekly limits Claude reports for the signed-in account", async () => {
    const home = mkdtempSync(join(tmpdir(), "noctis-claude-home-"));
    writeFileSync(
      join(home, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-test" } }),
    );
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const runtime = createClaudeRuntime({
      now: () => Date.parse("2026-10-19T15:00:00.000Z"),
      fetch: (url, init) => {
        asked.push({ url: url as string, headers: init?.headers as Record<string, string> });

        return Promise.resolve(
          Response.json({
            five_hour: { utilization: 19.0, resets_at: "2026-10-19T18:30:00.442359+00:00" },
            seven_day: { utilization: 68.0, resets_at: "2026-10-22T10:00:00.442377+00:00" },
            seven_day_opus: null,
          }),
        );
      },
    });

    expect(await runtime.readLimits?.("C:\\work", { CLAUDE_CONFIG_DIR: home })).toEqual({
      fiveHour: { usedPercent: 19, resetsAt: "2026-10-19T18:30:00.442Z" },
      weekly: { usedPercent: 68, resetsAt: "2026-10-22T10:00:00.442Z" },
      checkedAt: "2026-10-19T15:00:00.000Z",
    });
    expect(asked).toEqual([
      {
        url: "https://api.anthropic.com/api/oauth/usage",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-ant-oat-test",
          "anthropic-beta": "oauth-2025-04-20",
        }) as Record<string, string>,
      },
    ]);
  });

  it("says the sign-in has lapsed rather than guessing when Claude refuses the token", async () => {
    const home = mkdtempSync(join(tmpdir(), "noctis-claude-home-"));
    writeFileSync(
      join(home, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "expired" } }),
    );
    const runtime = createClaudeRuntime({
      fetch: () => Promise.resolve(new Response("{}", { status: 401 })),
    });

    await expect(runtime.readLimits?.("C:\\work", { CLAUDE_CONFIG_DIR: home })).rejects.toThrow(
      /open Claude Code/,
    );
  });

  it("asks Claude at most every five minutes and keeps its last reading through a 429", async () => {
    const home = mkdtempSync(join(tmpdir(), "noctis-claude-home-"));
    writeFileSync(
      join(home, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-test" } }),
    );
    let clock = Date.parse("2026-10-19T15:00:00.000Z");
    const answers = [
      Response.json({ five_hour: { utilization: 19, resets_at: null }, seven_day: null }),
      new Response("{}", { status: 429, headers: { "Retry-After": "600" } }),
    ];
    let asked = 0;
    const runtime = createClaudeRuntime({
      now: () => clock,
      fetch: () => {
        asked += 1;

        return Promise.resolve(answers.shift() ?? Response.json({}));
      },
    });
    const read = () => runtime.readLimits?.("C:\\work", { CLAUDE_CONFIG_DIR: home });
    const first = {
      fiveHour: { usedPercent: 19 },
      checkedAt: "2026-10-19T15:00:00.000Z",
    };

    expect(await read()).toEqual(first);

    clock += 4 * 60_000;
    expect(await read()).toEqual(first);
    expect(asked).toBe(1);

    clock += 2 * 60_000;
    expect(await read()).toEqual(first);
    expect(asked).toBe(2);

    // Claude asked for ten minutes' quiet; nine later it is still not asked.
    clock += 9 * 60_000;
    expect(await read()).toEqual(first);
    expect(asked).toBe(2);
  });

  it("refuses rather than guesses when Claude limits the reads before any reading", async () => {
    const home = mkdtempSync(join(tmpdir(), "noctis-claude-home-"));
    writeFileSync(
      join(home, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-test" } }),
    );
    const runtime = createClaudeRuntime({
      fetch: () =>
        Promise.resolve(new Response("{}", { status: 429, headers: { "Retry-After": "289" } })),
    });

    await expect(runtime.readLimits?.("C:\\work", { CLAUDE_CONFIG_DIR: home })).rejects.toThrow(
      /next read in 5 min/,
    );
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

    it("reads a PowerShell call the way it reads Bash: on Windows the CLI has no Bash tool", async () => {
      const { r, gate } = await held("allow");

      await expect(gate("PowerShell", { command: "Get-ChildItem | Format-List" })).resolves.toEqual(
        {},
      );
      await expect(gate("PowerShell", { command: "git push origin main" })).resolves.toEqual(
        allowed,
      );
      expect(r.asks.map((ask) => [ask.kind, ask.operationClass, ask.summary])).toEqual([
        ["command", "external_write", "git push origin main"],
      ]);
    });

    it("leaves the CLI's local orchestration tools to it, and stops the ones that reach out", async () => {
      const { r, gate } = await held("allow");

      for (const name of [
        "CronList",
        "ListAgents",
        "EnterWorktree",
        "ExitWorktree",
        "ReportFindings",
        "ScheduleWakeup",
        "Workflow",
        "PushNotification",
      ]) {
        await expect(gate(name, {}), name).resolves.toEqual({});
      }

      for (const name of ["CronCreate", "RemoteTrigger", "SendMessage", "ShareOnboardingGuide"]) {
        await gate(name, {});
      }

      expect(r.asks.map((ask) => [ask.target.id, ask.operationClass])).toEqual([
        ["CronCreate", "external_write"],
        ["RemoteTrigger", "external_write"],
        ["SendMessage", "external_write"],
        ["ShareOnboardingGuide", "external_write"],
      ]);
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

    it("lets a step on the owner's screen run, asks before one that commits, and refuses raw code", async () => {
      const { r, gate } = await held("allow");

      await expect(
        gate("mcp__browser__browser_navigate", { url: "https://www.amazon.co.uk" }),
      ).resolves.toEqual({});
      await expect(gate("mcp__desktop__App", { mode: "launch", name: "Teams" })).resolves.toEqual(
        {},
      );
      await expect(
        gate("mcp__browser__browser_click", { element: "Place your order", ref: "e40" }),
      ).resolves.toEqual(allowed);
      await expect(
        gate("mcp__browser__browser_evaluate", { function: "() => 1" }),
      ).resolves.toEqual(denied("mcp__browser__browser_evaluate is not a tool Noctis lends"));

      // One ask, for the order. The refusal is never a decision the owner is handed.
      expect(r.asks.map((ask) => [ask.kind, ask.operationClass, ask.target.id])).toEqual([
        ["tool_call", "external_write", "mcp__browser__browser_click"],
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

    it("leaves the agent's questions to the conversation instead of raising an approval", async () => {
      const { r, agentAsks } = await held("allow");

      await expect(
        agentAsks("AskUserQuestion", {
          questions: [
            { question: "Which repos?", header: "Scope", options: [], multiSelect: false },
          ],
        }),
      ).resolves.toEqual({
        behavior: "deny",
        message: expect.stringContaining("End your turn now") as unknown as string,
      });
      expect(r.asks).toEqual([]);
    });

    it("leaves edits in the CLI's own scratchpad to the agent, as it does the working folder", async () => {
      const { r, gate } = await held("allow");
      const scratch = join(tmpdir(), "claude", "C--work", "session", "scratchpad", "draft.md");

      await expect(gate("Write", { file_path: scratch })).resolves.toEqual({});
      await expect(gate("Edit", { file_path: scratch.toUpperCase() })).resolves.toEqual({});
      expect(r.asks).toEqual([]);
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
      const server = call.options?.mcpServers?.[BROWSER_SERVER];
      const args = server !== undefined && "args" in server ? (server.args ?? []) : [];

      return args[args.indexOf("--user-data-dir") + 1];
    });

    expect(dirs).toEqual([
      join("C:\\noctis", "browser", payload().threadId),
      join("C:\\noctis", "browser", other),
    ]);
  });

  it("lends the owner's desktop when Windows-MCP is installed on this PC", async () => {
    const exe = join(mkdtempSync(join(tmpdir(), "noctis-desktop-")), "windows-mcp.exe");
    writeFileSync(exe, "");
    const { query, calls } = scripted(list(init(), result()));

    await createClaudeRuntime({ query }).turn(
      input({}, undefined, { PATH: "C:\bin", NOCTIS_WINDOWS_MCP: exe }),
      recorder().sink,
    );

    expect(calls[0]?.options?.mcpServers?.[DESKTOP_SERVER]).toMatchObject({
      type: "stdio",
      command: exe,
      env: { ANONYMIZED_TELEMETRY: "false" },
    });
    // Allowed in the CLI too, or its own permission system asks about every click; the
    // gate before it still stops a step that commits the owner.
    expect(calls[0]?.options?.allowedTools).toEqual(
      expect.arrayContaining([`mcp__${BROWSER_SERVER}`, `mcp__${DESKTOP_SERVER}`]),
    );
  });

  describe("background sub-agents", () => {
    const system = (subtype: string, fields: Record<string, unknown>): unknown => ({
      type: "system",
      subtype,
      session_id: SESSION,
      ...fields,
    });
    const tasks = (...ids: string[]): unknown =>
      system("background_tasks_changed", {
        tasks: ids.map((id) => ({ task_id: id, task_type: "local_agent", description: "x" })),
      });
    const launch = [
      assistant([toolUse("a1", "Agent", { description: "explore LVL", run_in_background: true })]),
      system("task_started", { task_id: "k1", tool_use_id: "a1", is_backgrounded: true }),
      tasks("k1"),
      toolResult("a1", "Async agent launched"),
      assistant([{ type: "text", text: "started" }]),
      result({ result: "started" }),
    ];
    const reportBack = [
      system("task_progress", {
        task_id: "k1",
        tool_use_id: "a1",
        description: "explore LVL",
        last_tool_name: "Read",
        summary: "Reading the diary",
        usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
      }),
      tasks(),
      system("task_notification", {
        task_id: "k1",
        tool_use_id: "a1",
        status: "completed",
        summary: "LVL Unbound is a SvelteKit game",
        output_file: "",
        usage: { total_tokens: 8200, tool_uses: 12, duration_ms: 64000 },
      }),
      init(),
      assistant([{ type: "text", text: "finished" }]),
      result({ result: "finished" }),
    ];

    it("keeps the turn open until the sub-agents report back, showing what each is doing", async () => {
      let release = (): void => undefined;
      const later = new Promise<void>((resolve) => (release = resolve));
      const { query } = scripted(async function* () {
        yield init();
        yield* launch;
        await later;
        yield* reportBack;
      });
      const r = recorder();
      let settled = false;
      const turn = createClaudeRuntime({ query })
        .turn(input(), r.sink)
        .finally(() => (settled = true));

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);

      release();
      const evidence = await turn;

      expect(evidence.finalText).toBe("finished");
      expect(
        r.items
          .filter((item) => item.kind === "sub_agent")
          .map((item) => [item.status, item.kind === "sub_agent" ? item.activity : undefined]),
      ).toEqual([
        ["in_progress", undefined],
        ["in_progress", "Reading the diary"],
        ["completed", undefined],
      ]);
      expect(r.items.filter((item) => item.kind === "sub_agent").at(-1)).toMatchObject({
        report: "LVL Unbound is a SvelteKit game",
        tokens: 8200,
        toolUses: 12,
        durationMs: 64000,
      });
    });

    it("hands the background work to the owner's next message rather than queueing it", async () => {
      const { query } = scripted(async function* (params) {
        yield init();
        let turn = 0;

        for await (const message of params.prompt) {
          turn += message.type === "user" ? 1 : 0;

          if (turn === 1) {
            yield* launch;
          } else {
            yield assistant([{ type: "text", text: "still exploring" }]);
            yield result({ result: "still exploring" });
            yield* reportBack;
          }
        }
      });
      const runtime = createClaudeRuntime({ query });
      const first = runtime.turn(input(), recorder().sink);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const r = recorder();
      const second = runtime.turn(
        input({ prompt: "how is it going?", sessionRef: SESSION }),
        r.sink,
      );

      await expect(first).resolves.toMatchObject({
        finalText: "started",
        stoppedReason: "completed",
      });
      await expect(second).resolves.toMatchObject({ finalText: "finished" });
      expect(
        r.items.filter((item) => item.kind === "sub_agent").map((item) => item.status),
      ).toEqual(["in_progress", "completed"]);
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

    for (const kind of [
      "document",
      "list",
      "detail",
      "evidence",
      "attention",
      "timeline",
      "verification",
    ]) {
      expect(
        tools.tools.find((tool) => tool.name === "noctis_propose_surface")?.description,
      ).toContain(kind);
    }

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "noctis_delegate",
      "noctis_propose_inbox_note",
      "noctis_propose_note",
      "noctis_propose_objective",
      "noctis_propose_reminder",
      "noctis_propose_surface",
      "noctis_propose_task",
      "noctis_propose_task_action",
      "noctis_propose_vault_fact",
      "noctis_propose_vault_note",
      "noctis_propose_vault_revision",
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

    // A panel the core would refuse goes back to the agent to fix, not into the thread.
    const refused = await client.callTool({
      name: "noctis_propose_surface",
      arguments: {
        surfaceKind: "options",
        role: "primary",
        persistence: "restorable",
        priority: 50,
        payloadVersion: 1,
        payload: { title: "Cables", options: [{ id: "a", title: "A", image: "C:\\a.png" }] },
      },
    });

    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("options.0.image");
    expect(r.items).toHaveLength(1);

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
          trigger: { kind: "at_pc", nodeId: "0199a000-0000-7000-8000-0000000000e1", repeat: false },
        },
      ],
      ["note", { title: "Thought", body: "Keep this" }],
      ["task_action", { taskId: "0199a000-0000-7000-8000-0000000000e1", action: "pause" }],
    ] as const) {
      const captured = await client.callTool({ name: `noctis_propose_${kind}`, arguments: args });
      expect(captured.isError).not.toBe(true);
      const item = r.items.at(-1);
      expect(item?.kind).toBe("proposal");
      if (item?.kind === "proposal") expect(item.proposal).toMatchObject({ kind, ...args });
    }

    await client.close();
    release();
    await turn;
  });

  it("noctis_delegate hands the work to the core and returns the child's thread, reply and outputs", async () => {
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

    const called = await client.callTool({
      name: "noctis_delegate",
      arguments: { runtime: "codex", prompt: "draw frame 1" },
    });

    expect(r.delegations).toEqual([{ runtime: "codex", prompt: "draw frame 1" }]);
    expect(called.isError).not.toBe(true);

    const [content] = called.content as Array<{ type: string; text: string }>;

    expect(JSON.parse(content?.text ?? "")).toEqual({
      outcome: "completed",
      threadId: "0199a000-0000-7000-8000-0000000000c1",
      reply: "frame drawn",
      outputs: [
        {
          mediaType: "image/png",
          path: "C:\\frames\\1.png",
          attachmentId: "0199a000-0000-7000-8000-0000000000f1",
        },
      ],
    });

    await client.close();
    release();
    await turn;
  });

  it("waits for the SDK child exit when its stream ends during cancellation", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      killed: false,
      kill: () => {
        child.killed = true;
        return true;
      },
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    let sdkSignal: AbortSignal | undefined;
    const { query } = scripted(async function* (params) {
      sdkSignal = params.options?.abortController?.signal;
      params.options?.spawnClaudeCodeProcess?.({
        command: "fake-claude",
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
      yield init();
      await new Promise<void>((resolve) =>
        params.options?.abortController?.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
    });
    const controller = new AbortController();
    let settled = false;
    const turn = createClaudeRuntime({ query })
      .turn(input({}, controller.signal), recorder().sink)
      .then((result) => {
        settled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(child.stderr.readableFlowing).toBe(true);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      expect(settled).toBe(false);
      expect(child.killed).toBe(true);
      expect(sdkSignal?.aborted).toBe(false);
    } finally {
      child.exitCode = 1;
      child.emit("exit", 1, null);
      await turn;
      vi.mocked(spawn).mockClear();
    }
    expect(sdkSignal?.aborted).toBe(true);
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
          const content = message.message.content;
          const text =
            typeof content === "string"
              ? content
              : content[0]?.type === "text"
                ? content[0].text
                : "";

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

      await runtime.close?.();
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

      await runtime.close?.();
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

      await runtime.close?.();
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
      await runtime.close?.();
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
