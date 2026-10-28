import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { RuntimeAnswer, RuntimeAsk, RuntimeItem, RuntimeTurnPayload } from "@noctis/contracts";
import { RuntimeItemSchema, RuntimeTurnEvidenceSchema } from "@noctis/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { ACTING_INSTRUCTIONS, WRITING_INSTRUCTIONS } from "./identity.js";
import type { CodexSpawn, SpawnedChild } from "./codex.js";
import { AdapterRefused } from "./Runtime.js";
import { createHermesRuntime } from "./hermes.js";
import type { JsonRpcClient } from "./jsonrpc.js";
import { createJsonRpcClient } from "./jsonrpc.js";
import { browserServer } from "./mcp-config.js";

const ROOTS = { cwd: "C:\\work", writable: ["C:\\work"], readable: [], localOnly: true };
const MODEL = { providerId: "hermes" as const, model: "qwen/qwen3.5-9b" };
const THREAD = "0199a000-0000-7000-8000-0000000000e1";
const MCP_ENTRY = "C:\\noctis\\dist\\noctis-mcp.js";

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
  env: NodeJS.ProcessEnv;
  cwd: string;
  child: FakeChild;
  requests: Map<string, unknown[]>;
  notes: Array<[string, unknown]>;
}

/** What the scripted agent does with a prompt, once `session/prompt` arrives. */
type Script = (server: JsonRpcClient, sessionId: string) => Promise<string>;

function update(sessionId: string, body: Record<string, unknown>): unknown {
  return { sessionId, update: body };
}

/** Says something, runs `cat notes.txt` through its terminal tool, then answers. */
const HAPPY: Script = (server, sessionId) => {
  server.notify(
    "session/update",
    update(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "hm" },
    }),
  );
  server.notify(
    "session/update",
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "terminal: cat notes.txt",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "cat notes.txt" },
    }),
  );
  server.notify(
    "session/update",
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "hello" } }],
    }),
  );

  for (const text of ["It says ", "hello."]) {
    server.notify(
      "session/update",
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: "m-1",
        content: { type: "text", text },
      }),
    );
  }

  return Promise.resolve("end_turn");
};

function fakeHermes(script: Script): { spawn: CodexSpawn; spawned: Spawned[] } {
  const spawned: Spawned[] = [];

  const spawn: CodexSpawn = (_file, _args, options) => {
    const child = new FakeChild();
    const server = createJsonRpcClient({ input: child.stdin, output: child.stdout });
    const record: Spawned = {
      env: options.env,
      cwd: options.cwd,
      child,
      requests: new Map(),
      notes: [],
    };

    spawned.push(record);
    server.onNotification((method, params) => record.notes.push([method, params]));
    server.onRequest(async (method, params) => {
      record.requests.set(method, [...(record.requests.get(method) ?? []), params]);

      switch (method) {
        case "initialize":
          return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
        case "session/new":
          return { sessionId: "hs-1" };
        case "session/load": {
          const { sessionId } = params as { sessionId: string };

          // History replays as updates before the answer; none of it is this turn's.
          server.notify(
            "session/update",
            update(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "an old reply" },
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 5));

          return null;
        }
        case "session/prompt": {
          const { sessionId } = params as { sessionId: string };

          return {
            stopReason: await script(server, sessionId),
            usage: { inputTokens: 40, outputTokens: 7 },
          };
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    });

    return child;
  };

  return { spawn, spawned };
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "noctis-hermes-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The MCP servers as ACP names them to Hermes: the node's own, writing to this thread's file, then the owner's browser. */
function lentMcp(): unknown[] {
  const browser = browserServer(input().env, THREAD);

  return [
    {
      name: "noctis",
      command: process.execPath,
      args: [MCP_ENTRY, "--proposals", join(scratch, "proposals", `hermes-${THREAD}.jsonl`)],
      env: [],
    },
    ...(browser === undefined
      ? []
      : [{ name: "browser", command: browser.command, args: browser.args, env: [] }]),
  ];
}

/** A step on a lent server as Hermes asks about it: Noctis's plugin escalates it, giving its input as the reason. */
function screenStep(
  server: JsonRpcClient,
  sessionId: string,
  id: number,
  tool: string,
  reason: string,
): Promise<unknown> {
  const command = `<${tool}> (plugin approval rule)`;

  return server.request("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: `perm-check-${String(id)}`,
      title: `${reason}: ${command}`,
      kind: "execute",
      status: "pending",
      content: [{ type: "content", content: { type: "text", text: `${reason}\n$ ${command}` } }],
      rawInput: { command, description: reason },
    },
    options: [
      { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
      { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
      { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
      { optionId: "deny", kind: "reject_once", name: "Deny" },
      { optionId: "deny_always", kind: "reject_always", name: "Deny always" },
    ],
  });
}

function payload(overrides: Partial<RuntimeTurnPayload> = {}): RuntimeTurnPayload {
  return {
    threadId: THREAD,
    identityId: "vesper",
    model: MODEL,
    userMessageId: "0199a000-0000-7000-8000-0000000000e2",
    prompt: "what does notes.txt say?",
    primaryRootGrantId: "w",
    objectiveActive: false,
    ...overrides,
  };
}

function input(
  overrides: Partial<RuntimeTurnPayload> = {},
  signal = new AbortController().signal,
): RuntimeTurnInput {
  return { payload: payload(overrides), roots: ROOTS, env: { PATH: "C:\\bin" }, signal };
}

function recorder(decision: RuntimeAnswer["decision"] = "allow") {
  const items: RuntimeItem[] = [];
  const deltas: string[] = [];
  const asks: Array<Omit<RuntimeAsk, "askId">> = [];
  const sink: RuntimeSink = {
    item: (item) => items.push(RuntimeItemSchema.parse(item)),
    delta: (_itemId, text) => deltas.push(text),
    ask: (ask) => {
      asks.push(ask);

      return Promise.resolve({
        askId: "0199a000-0000-7000-8000-0000000000a5",
        decision,
        approvalId: "0199a000-0000-7000-8000-0000000000a6",
      });
    },
    delegate: () => Promise.reject(new Error("no delegation expected")),
    upload: () => Promise.reject(new Error("no upload expected")),
  };

  return { sink, items, deltas, asks };
}

/** Jester's turn payload with nothing said in it: what a wake carries. */
function warmPayload() {
  const { threadId, identityId, model, primaryRootGrantId, objectiveActive } = input({
    identityId: "jester",
  }).payload;

  return { threadId, identityId, model, primaryRootGrantId, objectiveActive };
}

function runtime(
  script: Script = HAPPY,
  models = ["qwen/qwen3.5-9b"],
  host?: { downloaded: () => Promise<string[]>; ensure: (model: string) => Promise<void> },
) {
  const fake = fakeHermes(script);

  return {
    ...fake,
    runtime: createHermesRuntime({
      command: "C:\\hermes\\bin\\hermes-acp.exe",
      spawn: fake.spawn,
      hermesHome: join(scratch, "hermes"),
      proposalsDir: join(scratch, "proposals"),
      mcpEntry: MCP_ENTRY,
      ...(host === undefined ? {} : { host }),
      localProbe: () =>
        Promise.resolve({
          providerId: "local",
          available: models.length > 0,
          authMode: "local",
          models: models.map((model) => ({ providerId: "local" as const, model })),
        }),
    }),
  };
}

describe("the Hermes runtime (ACP)", () => {
  it("runs a turn on a new session in the folder, streaming the reply and the commands it ran", async () => {
    const { runtime: hermes, spawned } = runtime();
    const r = recorder();

    const evidence = RuntimeTurnEvidenceSchema.parse(await hermes.turn(input(), r.sink));

    expect(spawned[0]?.cwd).toBe("C:\\work");
    expect(spawned[0]?.requests.get("session/new")).toEqual([
      { cwd: "C:\\work", mcpServers: lentMcp() },
    ]);
    expect(spawned[0]?.requests.get("session/prompt")).toEqual([
      {
        sessionId: "hs-1",
        prompt: [
          { type: "text", text: "what does notes.txt say?" },
          { type: "text", text: expect.stringContaining("<noctis-clock>") as string },
        ],
      },
    ]);
    expect(r.deltas).toEqual(["It says ", "hello."]);
    expect(r.items).toEqual([
      {
        itemId: "tc-1",
        kind: "command",
        status: "in_progress",
        command: "cat notes.txt",
        cwd: "C:\\work",
      },
      {
        itemId: "tc-1",
        kind: "command",
        status: "completed",
        command: "cat notes.txt",
        cwd: "C:\\work",
        output: "hello",
      },
      { itemId: "m-1", kind: "agent_message", status: "completed", text: "It says hello." },
    ]);
    expect(evidence).toMatchObject({
      model: MODEL,
      sessionRef: "hs-1",
      finalText: "It says hello.",
      stoppedReason: "completed",
      usage: { inputTokens: 40, outputTokens: 7 },
    });
  });

  it("runs on a Hermes home Noctis owns: the local model server, its approvals, no pushes", async () => {
    const { runtime: hermes, spawned } = runtime();

    await hermes.turn(input(), recorder().sink);

    const home = join(scratch, "hermes");
    const config = readFileSync(join(home, "config.yaml"), "utf8");

    expect(spawned[0]?.env.HERMES_HOME).toBe(home);
    expect(config).toContain('provider: "lmstudio"');
    expect(config).toContain('default: "qwen/qwen3.5-9b"');
    expect(config).toContain("mode: manual");
    expect(config).toContain('"*git push*"');
  });

  it("lets Hermes remember and learn on both homes, but schedules nothing", async () => {
    const { runtime: hermes } = runtime();

    await hermes.turn(input(), recorder().sink);
    await hermes.turn(
      input({ identityId: "jester", threadId: "0199a000-0000-7000-8000-0000000000f1" }),
      recorder().sink,
    );

    for (const home of ["hermes", "hermes-jester"]) {
      const config = readFileSync(join(scratch, home, "config.yaml"), "utf8");

      expect(config).toContain("memory_enabled: true");
      expect(config).toContain("user_profile_enabled: true");
      expect(config).toContain("memory_char_limit: 2200");
      expect(config).toContain("user_char_limit: 1375");
      expect(config).toContain("nudge_interval: 10");
      expect(config).toMatch(/background_review:\n {4}enabled: true/);
      expect(config).toContain("creation_nudge_interval: 10");
      expect(config).toMatch(/disabled_toolsets:\n {4}- "cronjob"\n/);
      expect(config).not.toContain('"memory"');
      expect(config).not.toContain('"session_search"');
    }
  });

  it("attaches the Noctis MCP tools, and turns what they propose into proposal items (ADR-0030)", async () => {
    const proposing: Script = (_server, sessionId) => {
      // The model's MCP tool wrote a proposal; the runtime tails the file named in the MCP args.
      const servers = (
        fake.spawned[0]?.requests.get("session/new")?.[0] as {
          mcpServers: Array<{ args: string[] }>;
        }
      ).mcpServers;
      const args = servers[0]?.args ?? [];

      appendFileSync(
        args[args.indexOf("--proposals") + 1] ?? "",
        `${JSON.stringify({ kind: "objective", title: "Suggested", intent: "later" })}\n`,
      );

      return Promise.resolve(sessionId === "hs-1" ? "end_turn" : "refusal");
    };
    const fake = runtime(proposing);
    const r = recorder();

    await fake.runtime.turn(input(), r.sink);

    expect(r.items).toContainEqual({
      itemId: "proposal-1",
      kind: "proposal",
      status: "completed",
      proposal: { kind: "objective", title: "Suggested", intent: "later" },
    });
  });

  it("lends the owner's browser and desktop on new and resumed sessions, env in ACP's form", async () => {
    const exe = join(scratch, "windows-mcp.exe");
    writeFileSync(exe, "");
    const env = { PATH: "C:\\bin", NOCTIS_WINDOWS_MCP: exe, NOCTIS_BROWSER_EXTENSION_TOKEN: "tok" };
    const { runtime: hermes, spawned } = runtime();

    await hermes.turn({ ...input(), env }, recorder().sink);
    await hermes.turn(
      {
        ...input({ threadId: "0199a000-0000-7000-8000-0000000000f2", sessionRef: "hs-9" }),
        env,
      },
      recorder().sink,
    );

    const lent = [
      spawned[0]?.requests.get("session/new")?.[0],
      spawned[1]?.requests.get("session/load")?.[0],
    ].map((params) => (params as { mcpServers: Array<{ name: string }> }).mcpServers);

    for (const servers of lent) {
      expect(servers.map((server) => server.name)).toEqual(["noctis", "browser", "desktop"]);
      expect(servers[1]).toEqual({
        name: "browser",
        command: process.execPath,
        args: expect.arrayContaining(["--extension"]) as unknown,
        env: [{ name: "PLAYWRIGHT_MCP_EXTENSION_TOKEN", value: "tok" }],
      });
      expect(servers[2]).toMatchObject({ name: "desktop", command: exe });
    }
  });

  it("installs the plugin that makes Hermes ask before every step on the owner's screen", async () => {
    const { runtime: hermes } = runtime();

    await hermes.turn(input(), recorder().sink);

    const home = join(scratch, "hermes");
    const plugin = join(home, "plugins", "noctis-screen");

    expect(readFileSync(join(home, "config.yaml"), "utf8")).toMatch(
      /\nplugins:\n {2}enabled:\n {4}- "noctis-screen"\n/,
    );
    expect(readFileSync(join(plugin, "plugin.yaml"), "utf8")).toContain("name: noctis-screen");

    const code = readFileSync(join(plugin, "__init__.py"), "utf8");

    expect(code).toContain('ctx.register_hook("pre_tool_call"');
    expect(code).toContain('"mcp__browser__"');
    expect(code).toContain('"mcp__desktop__"');
    expect(code).toContain('"action": "approve"');
  });

  it("lets routine screen steps run and asks the owner before one that commits them", async () => {
    const answers: unknown[] = [];
    const stepping: Script = async (server, sessionId) => {
      const step = (id: number, tool: string, reason: string) =>
        screenStep(server, sessionId, id, tool, reason);

      answers.length = 0;
      answers.push(
        await step(
          1,
          "mcp__browser__browser_click",
          JSON.stringify({ element: "Search button", ref: "e3" }),
        ),
        await step(2, "mcp__browser__browser_evaluate", JSON.stringify({ function: "() => 1" })),
        await step(
          3,
          "mcp__browser__browser_click",
          JSON.stringify({ element: "Place order", ref: "e9" }),
        ),
        // No input to judge it by, so the owner judges it.
        await step(4, "mcp__desktop__Click", "not json"),
      );

      return "end_turn";
    };
    const allow = { outcome: { outcome: "selected", optionId: "allow_once" } };
    const deny = { outcome: { outcome: "selected", optionId: "deny" } };

    const declined = recorder("deny");
    await runtime(stepping).runtime.turn(input(), declined.sink);
    expect(answers).toEqual([allow, allow, deny, deny]);
    expect(declined.asks).toEqual([
      {
        itemId: "perm-check-3",
        kind: "tool_call",
        askedBy: "runtime",
        summary: "call mcp__browser__browser_click",
        operationClass: "external_write",
        reversibility: expect.any(String) as unknown,
        capability: "runtime.tool_call",
        target: { type: "tool_call", id: "mcp__browser__browser_click" },
        detail: { tool: "mcp__browser__browser_click" },
      },
      expect.objectContaining({
        itemId: "perm-check-4",
        kind: "tool_call",
        target: { type: "tool_call", id: "mcp__desktop__Click" },
      }),
    ]);

    const allowed = recorder("allow");
    await runtime(stepping).runtime.turn(input(), allowed.sink);
    expect(answers).toEqual([allow, allow, allow, allow]);
  });

  it("resumes a session in a new process without replaying its history as this turn, then reuses the process", async () => {
    const { runtime: hermes, spawned } = runtime();
    const r = recorder();

    const evidence = await hermes.turn(input({ sessionRef: "hs-9" }), r.sink);

    expect(spawned[0]?.requests.get("session/load")).toEqual([
      { sessionId: "hs-9", cwd: "C:\\work", mcpServers: lentMcp() },
    ]);
    expect(spawned[0]?.requests.has("session/new")).toBe(false);
    expect(r.deltas).not.toContain("an old reply");
    expect(evidence.sessionRef).toBe("hs-9");

    await hermes.turn(input({ sessionRef: "hs-9", prompt: "and now?" }), recorder().sink);
    expect(spawned).toHaveLength(1);
  });

  it("asks the owner when Hermes asks, and answers with the option the owner chose", async () => {
    let answers: unknown[] = [];
    const asking: Script = async (server, sessionId) => {
      const ask = (command: string) =>
        server.request("session/request_permission", {
          sessionId,
          toolCall: {
            toolCallId: "perm-check-1",
            title: `Recursive delete: ${command}`,
            kind: "execute",
            status: "pending",
            rawInput: { command, description: "Recursive delete" },
          },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
            { optionId: "deny", kind: "reject_once", name: "Deny" },
          ],
        });

      answers = [await ask("rm -rf build")];

      return "end_turn";
    };

    const allowed = recorder("allow");
    await runtime(asking).runtime.turn(input(), allowed.sink);
    expect(allowed.asks).toEqual([
      expect.objectContaining({
        kind: "command",
        askedBy: "runtime",
        target: { type: "command", id: "rm -rf build" },
        detail: { command: "rm -rf build", cwd: "C:\\work" },
      }),
    ]);
    expect(answers).toEqual([{ outcome: { outcome: "selected", optionId: "allow_once" } }]);

    const declined = recorder("deny");
    await runtime(asking).runtime.turn(input(), declined.sink);
    expect(answers).toEqual([{ outcome: { outcome: "selected", optionId: "deny" } }]);
  });

  it("asks about an edit as a file change, and reports no item for a permission's own bubble", async () => {
    const editing: Script = async (server, sessionId) => {
      await server.request("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "perm-edit-1",
          title: "Approve edit: C:/work/script.md",
          kind: "edit",
          status: "pending",
          locations: [{ path: "C:/work/script.md" }],
        },
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
      });
      // Hermes closes the request's bubble; nothing started it as a tool call.
      server.notify(
        "session/update",
        update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "perm-edit-1",
          status: "failed",
        }),
      );

      return "end_turn";
    };
    const r = recorder("deny");

    await runtime(editing).runtime.turn(input(), r.sink);

    expect(r.asks).toEqual([
      expect.objectContaining({
        kind: "file_change",
        detail: { paths: ["C:/work/script.md"] },
        target: { type: "file_change", id: "C:/work/script.md" },
      }),
    ]);
    expect(r.items).toEqual([]);
  });

  it("cancels during session initialization and waits for OS exit", async () => {
    const controller = new AbortController();
    const child = new FakeChild();
    child.kill = () => {
      child.killed = true;
      return true;
    };
    const hermes = createHermesRuntime({
      command: "fake-hermes",
      spawn: () => child,
      hermesHome: join(scratch, "hermes"),
      proposalsDir: join(scratch, "proposals"),
      localProbe: () =>
        Promise.resolve({ providerId: "local", available: true, authMode: "local", models: [] }),
    });
    let settled = false;
    const turn = hermes.turn(input({}, controller.signal), recorder().sink).then(
      (result) => {
        settled = true;
        return result;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      expect(child.killed).toBe(true);
      expect(settled).toBe(false);
    } finally {
      child.exitCode = 1;
      child.emit("exit", 1, null);
      await turn;
    }
    expect(await turn).toMatchObject({ stoppedReason: "cancelled" });
  });

  it("waits for OS exit after ACP acknowledges cancellation", async () => {
    const controller = new AbortController();
    const { runtime: hermes, spawned } = runtime(
      () =>
        new Promise((resolve) => {
          controller.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
        }),
    );
    let settled = false;
    const turn = hermes.turn(input({}, controller.signal), recorder().sink).then((result) => {
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

  it("cancels the turn through ACP when the job is cancelled", async () => {
    const controller = new AbortController();
    const slow: Script = () =>
      new Promise((resolve) => {
        controller.signal.addEventListener("abort", () =>
          setTimeout(() => resolve("cancelled"), 5),
        );
      });
    const { runtime: hermes, spawned } = runtime(slow);
    const turn = hermes.turn(input({}, controller.signal), recorder().sink);

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    expect((await turn).stoppedReason).toBe("cancelled");
    expect(spawned[0]?.notes).toContainEqual(["session/cancel", { sessionId: "hs-1" }]);
  });

  it("tells Jester where the shared MindVault is", async () => {
    const { runtime: hermes } = runtime();
    const vault = join(scratch, "MindVault");
    mkdirSync(join(vault, "agent"), { recursive: true });
    writeFileSync(join(vault, "agent", "brain.md"), "# Agent Brain\n");

    await hermes.turn(
      { ...input({ identityId: "jester" }), roots: { ...ROOTS, readable: [vault] } },
      recorder().sink,
    );

    expect(readFileSync(join(scratch, "hermes-jester", "SOUL.md"), "utf8")).toContain(
      `shared with you, read only, at ${vault}`,
    );
  });

  it("speaks as Jester on Jester's own Hermes home, and keeps Vesper's soul on Vesper's", async () => {
    const { runtime: hermes, spawned } = runtime();

    await hermes.turn(input({ identityId: "jester" }), recorder().sink);
    await hermes.turn(
      input({ identityId: "vesper", threadId: "0199a000-0000-7000-8000-0000000000f1" }),
      recorder().sink,
    );

    const jesterHome = join(scratch, "hermes-jester");
    const soul = readFileSync(join(jesterHome, "SOUL.md"), "utf8");

    expect(spawned[0]?.env.HERMES_HOME).toBe(jesterHome);
    expect(soul).toMatch(/^You are Jester/);
    // A contrarian that also does what it is asked on the PC, up to the step that commits the owner.
    expect(soul).toContain("contrarian");
    expect(soul).toContain(ACTING_INSTRUCTIONS);
    expect(soul).toContain(WRITING_INSTRUCTIONS);
    expect(soul).not.toContain("You prepare; you do not commit");
    // Jester took recalled notes for something the owner pasted, and Hermes's
    // own browser vault for the MindVault.
    expect(soul).toContain("MindVault");
    expect(soul).toContain("not a password");
    expect(readFileSync(join(jesterHome, "config.yaml"), "utf8")).toContain("memory_enabled: true");
    expect(spawned[1]?.env.HERMES_HOME).toBe(join(scratch, "hermes"));
    expect(readFileSync(join(scratch, "hermes", "SOUL.md"), "utf8")).toMatch(/^You are Vesper/);
  });

  it("writes the identity card as Vesper's soul, and removes it once cards are off", async () => {
    const { runtime: hermes } = runtime();
    const soul = join(scratch, "hermes", "SOUL.md");

    await hermes.turn(input(), recorder().sink);

    expect(readFileSync(soul, "utf8")).toMatch(/^You are Vesper/);
    expect(readFileSync(soul, "utf8")).toContain("running as Hermes on");

    await hermes.turn(
      {
        ...input({ threadId: "0199a000-0000-7000-8000-0000000000f2" }),
        env: { PATH: "C:\\bin", NOCTIS_IDENTITY_CARDS: "0" },
      },
      recorder().sink,
    );

    expect(existsSync(soul)).toBe(false);
  });

  it("starts LM Studio and loads the model before Hermes starts, when the node drives LM Studio", async () => {
    const ensured: string[] = [];
    // Stopped at hello: the probe says no server, but the node can start it.
    const { runtime: hermes, spawned } = runtime(HAPPY, [], {
      downloaded: () => Promise.resolve(["qwen/qwen3.5-9b"]),
      ensure: (model) => {
        ensured.push(model);
        return Promise.resolve();
      },
    });

    await hermes.turn(input({ identityId: "jester" }), recorder().sink);

    expect(ensured).toEqual(["qwen/qwen3.5-9b"]);
    expect(spawned).toHaveLength(1);
  });

  it("wakes by loading the model, and starts nothing and says nothing", async () => {
    const ensured: string[] = [];
    const { runtime: hermes, spawned } = runtime(HAPPY, [], {
      downloaded: () => Promise.resolve(["qwen/qwen3.5-9b"]),
      ensure: (model) => {
        ensured.push(model);
        return Promise.resolve();
      },
    });
    const warm = warmPayload();

    expect(
      await hermes.warm?.({ payload: warm, env: {}, signal: new AbortController().signal }),
    ).toBe(true);
    expect(ensured).toEqual(["qwen/qwen3.5-9b"]);
    expect(spawned).toHaveLength(0);
  });

  it("has nothing to wake when the node does not drive LM Studio", async () => {
    const { runtime: hermes } = runtime();
    const warm = warmPayload();

    expect(
      await hermes.warm?.({ payload: warm, env: {}, signal: new AbortController().signal }),
    ).toBe(false);
  });

  it("refuses, saying why and spawning nothing, when LM Studio cannot load the model", async () => {
    const { runtime: hermes, spawned } = runtime(HAPPY, [], {
      downloaded: () => Promise.resolve([]),
      ensure: () => Promise.reject(new Error("out of memory")),
    });
    const turn = hermes.turn(input({ identityId: "jester" }), recorder().sink);

    await expect(turn).rejects.toBeInstanceOf(AdapterRefused);
    await expect(turn).rejects.toThrow(/LM Studio could not load .*out of memory/);
    expect(spawned).toHaveLength(0);
  });

  it("refuses at once, never falling back elsewhere, when the local model server is down (ADR-0030)", async () => {
    const { runtime: hermes, spawned } = runtime(HAPPY, []);
    const turn = hermes.turn(input({ identityId: "jester" }), recorder().sink);

    await expect(turn).rejects.toBeInstanceOf(AdapterRefused);
    await expect(turn).rejects.toThrow(/LM Studio is not running/);
    expect(spawned).toHaveLength(0);
  });

  it("offers the local server's models as Hermes models, and is unavailable without them", async () => {
    expect(await runtime().runtime.probe()).toEqual({
      providerId: "hermes",
      available: true,
      authMode: "local",
      models: [{ providerId: "hermes", model: "qwen/qwen3.5-9b" }],
    });
    expect(await runtime(HAPPY, []).runtime.probe()).toMatchObject({
      providerId: "hermes",
      available: false,
      authMode: "local",
    });
  });
});
