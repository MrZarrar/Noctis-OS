import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CanUseTool,
  HookJSONOutput,
  ListSessionsOptions,
  Options,
  PermissionResult,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createSdkMcpServer,
  getSessionMessages as sdkGetSessionMessages,
  listSessions as sdkListSessions,
  query as sdkQuery,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ExternalSession,
  RuntimeAsk,
  RuntimeItem,
  RuntimeProbe,
  RuntimeProposal,
  RuntimeTargets,
  RuntimeTurnEvidence,
  SessionExchange,
} from "@noctis/contracts";
import {
  MAX_HISTORY_EXCHANGES,
  MAX_LISTED_SESSIONS,
  RuntimeDelegationSchema,
  RuntimeProposalSchema,
} from "@noctis/contracts";
import { classifyAsk, isConfirmLevel } from "@noctis/domain";
import { z } from "zod";

import { AGENT_VERSION } from "../agent.js";
import { PANEL_TOOL_DESCRIPTION, surfaceProblem } from "../panel-tool.js";
import type { ResolvedRoots, Runtime, RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { AdapterRefused, ApprovalTimedOut } from "./Runtime.js";
import { BILLING_KEYS } from "./env.js";
import { trackChild } from "./orphans.js";
import { killProcessTree, type KillableChild } from "./kill-tree.js";
import { identityCard, ownerClockBlock, isOwnerClockBlock } from "./identity.js";
import {
  DELEGATE_TOOL_DESCRIPTION,
  PRODUCTIVITY_TOOLS,
  proposalSchema,
} from "../proposal-tools.js";
import {
  BROWSER_SERVER,
  DESKTOP_SERVER,
  browserServer,
  desktopServer,
  refusedTool,
  type StdioServer,
} from "./mcp-config.js";
import { probeClaudeInstalled } from "./probe.js";
import type { LiveProcess } from "./sessions.js";
import { createProcessPool, processKey } from "./sessions.js";

/**
 * Claude Code behind the node boundary, through the Agent SDK (ADR-0020/0021).
 *
 * One `query()` per thread, kept open between turns and fed one user message
 * per turn, so a follow-up does not pay for a CLI start and a session reload.
 * `query()` spawns the SDK's own bundled CLI (never the CLI's bare mode, never
 * an API key: the environment arrives stripped and the login is the owner's
 * claude.ai subscription). It loads the owner's real setup: user, project and
 * local settings, CLAUDE.md, skills, plugins, hooks and MCP servers.
 *
 * Permissions are split by consequence. The CLI runs in auto mode and decides
 * the everyday itself. A `PreToolUse` hook classifies every call with
 * `classifyAsk` and stops only the Section 9.1 confirm-level ones until the
 * core answers. When the CLI's own permission system asks, `canUseTool`
 * forwards that to the owner as well.
 *
 * The Noctis proposal tools are hosted in-process with `createSdkMcpServer`:
 * an `sdk`-type server is relayed over the CLI child's stdio control channel,
 * so no port opens and no proposals file is needed on this route.
 */

export type ClaudeQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export type ClaudeListSessions = (
  options: ListSessionsOptions,
) => Promise<Array<Pick<SDKSessionInfo, "sessionId" | "summary" | "lastModified" | "customTitle">>>;

export type ClaudeGetSessionMessages = (
  sessionId: string,
  options: { dir: string },
) => Promise<Array<Pick<SessionMessage, "type" | "message" | "parent_tool_use_id">>>;

export interface ClaudeRuntimeOptions {
  /** The SDK's `query`; tests hand in a scripted generator. */
  query?: ClaudeQuery;
  /** The SDK's `listSessions`; tests hand in a fixed list. */
  listSessions?: ClaudeListSessions;
  /** The SDK's `getSessionMessages`; tests hand in a transcript. */
  getSessionMessages?: ClaudeGetSessionMessages;
  env?: NodeJS.ProcessEnv;
  /** How long a thread's CLI waits for its next message before it is closed. */
  idleMs?: number;
}

/** On Windows the CLI offers PowerShell where it would offer Bash; both take `command`. */
const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const AGENT_TOOLS = new Set(["Task", "Agent"]);
/**
 * Claude Code's own tools that reach nothing outside the machine by themselves:
 * reading, searching the web, planning, delegating, loading a skill. Whatever
 * they lead to (a Bash call, an edit) is classified on its own. A tool missing
 * from this list is treated as external until someone adds it, so a new
 * built-in that sends or publishes is stopped rather than waved through.
 */
const LOCAL_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "TodoWrite",
  "TodoRead",
  "Skill",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "BashOutput",
  "KillShell",
  "KillBash",
  "TaskOutput",
  "TaskStop",
  "Monitor",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "CronList",
  "ListAgents",
  "EnterWorktree",
  "ExitWorktree",
  "ReportFindings",
  "ScheduleWakeup",
  "Workflow",
  // A notification to the owner's own devices, which is where approvals go anyway.
  "PushNotification",
  ...AGENT_TOOLS,
]);
/**
 * Text that arrives as a user message but was not typed as a prompt: VS Code's
 * open-file and selection notes, background task notices, slash-command
 * plumbing, interruption markers.
 */
const NOT_A_PROMPT =
  /^\s*(?:<(?:ide_|task-notification|system-reminder|local-command|command-)|\[Request interrupted)/;
const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string() }).loose();

/** A transcript message's own words, without tool calls, results, thinking or wrappers. */
function spokenText(content: unknown): string {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;

  return (Array.isArray(blocks) ? blocks : [])
    .flatMap((block) => {
      const text = TextBlockSchema.safeParse(block);

      return text.success &&
        !NOT_A_PROMPT.test(text.data.text) &&
        !isOwnerClockBlock(text.data.text)
        ? [text.data.text.trim()]
        : [];
    })
    .filter((text) => text !== "")
    .join("\n\n");
}

/**
 * A transcript as exchanges: each prompt the owner typed and the last thing
 * the agent said before the next one, which is the answer it ended on.
 * Subagents' own messages are theirs, not the conversation's.
 */
function exchangesOf(
  messages: ReadonlyArray<Pick<SessionMessage, "type" | "message" | "parent_tool_use_id">>,
): SessionExchange[] {
  const exchanges: SessionExchange[] = [];

  for (const message of messages) {
    const text =
      message.parent_tool_use_id === null
        ? spokenText((message.message as { content?: unknown } | null)?.content)
        : "";
    const last = exchanges.at(-1);

    if (text === "") {
      continue;
    }

    if (message.type === "user") {
      exchanges.push({ prompt: text, reply: "" });
    } else if (message.type === "assistant" && last !== undefined) {
      last.reply = text;
    }
  }

  return exchanges.slice(-MAX_HISTORY_EXCHANGES);
}

const NOCTIS_PREFIX = "mcp__noctis__";
const DECLINED = "declined by Noctis authority";
const NO_TURN = "no Noctis turn is running";
const HOOK_TIMEOUT_SECONDS = 24 * 60 * 60;
/**
 * Claude Code keeps its scratchpad under the temp folder, outside every root
 * the owner granted, so each draft written there was stopped as an external
 * write. It is the CLI's own working space on this PC; reaching out from it is
 * still classified on its own, as a command or a tool call.
 */
const SCRATCH_ROOTS = [...new Set([tmpdir(), realTmpdir()])].map((dir) => join(dir, "claude"));

function realTmpdir(): string {
  try {
    return realpathSync.native(tmpdir());
  } catch {
    return tmpdir();
  }
}

/** Claude's artifact publishing, which competed with Noctis's own panels for showing work. */
const DISALLOWED_TOOLS = ["Artifact", "ArtifactComments", "ArtifactData", "DesignSync"];

const QUESTIONS_IN_THREAD =
  "Noctis has shown these questions and their options to the owner in the thread. " +
  "End your turn now: do not pick an answer yourself or carry on with a default. " +
  "Their answer arrives as the next message.";

function gateDecision(decision: "allow" | "deny", reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

/** Claude Code's tool inputs, not ours: only the fields the mapping reads, the rest passes through. */
const ToolInputSchema = z
  .object({
    command: z.string().optional(),
    cwd: z.string().optional(),
    file_path: z.string().optional(),
    notebook_path: z.string().optional(),
    description: z.string().optional(),
    subagent_type: z.string().optional(),
    prompt: z.string().optional(),
    url: z.string().optional(),
    query: z.string().optional(),
  })
  .loose();

type ToolInput = z.infer<typeof ToolInputSchema>;

function fields(input: unknown): ToolInput {
  const parsed = ToolInputSchema.safeParse(input);

  return parsed.success ? parsed.data : {};
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function toolLabel(toolName: string): string {
  return toolName.startsWith(NOCTIS_PREFIX) ? toolName.slice(NOCTIS_PREFIX.length) : toolName;
}

/** One tool call as the ask it would raise, classified, whether or not anyone is asked. */
function describeCall(
  toolName: string,
  raw: unknown,
  itemId: string,
  roots: ResolvedRoots,
): Omit<RuntimeAsk, "askId"> {
  const input = fields(raw);
  const scope = {
    writableRoots: [...roots.writable, ...SCRATCH_ROOTS],
    readableRoots: roots.readable,
  };

  if (COMMAND_TOOLS.has(toolName)) {
    const command = input.command ?? "";
    const cwd = input.cwd ?? roots.cwd;
    const cls = classifyAsk({ kind: "command", command, cwd, ...scope });

    return {
      itemId,
      kind: "command",
      summary: clip(command, 2000).trim() || "run a command",
      operationClass: cls.operationClass,
      reversibility: cls.reversibility,
      capability: cls.capability,
      target: { type: "command", id: clip(command, 200).trim() || "command" },
      detail: { command: clip(command, 4000), cwd: clip(cwd, 1024) },
    };
  }

  if (FILE_TOOLS.has(toolName)) {
    const paths = [input.file_path ?? input.notebook_path ?? ""]
      .filter((p) => p !== "")
      .map((p) => clip(p, 1024));
    const cls = classifyAsk({ kind: "file_change", paths, ...scope });

    return {
      itemId,
      kind: "file_change",
      summary: clip(`edit ${paths.join(", ") || "a file"}`, 2000),
      operationClass: cls.operationClass,
      reversibility: cls.reversibility,
      capability: cls.capability,
      target: { type: "file_change", id: clip(paths[0] ?? itemId, 200) },
      detail: { paths },
    };
  }

  const name = toolLabel(toolName);
  const cls = LOCAL_TOOLS.has(toolName)
    ? ({
        operationClass: "read_inspect",
        reversibility: "reversible",
        capability: "runtime.tool_call",
      } as const)
    : classifyAsk({ kind: "tool_call", tool: name, args: raw, ...scope });

  return {
    itemId,
    kind: "tool_call",
    summary: clip(`call ${name}`, 2000),
    operationClass: cls.operationClass,
    reversibility: cls.reversibility,
    capability: cls.capability,
    target: { type: "tool_call", id: clip(name, 200) },
    detail: { tool: clip(name, 128) },
  };
}

/** A tool_use block (and later its tool_result) as one RuntimeItem. */
function toolItem(
  itemId: string,
  toolName: string,
  raw: unknown,
  roots: ResolvedRoots,
  status: RuntimeItem["status"],
  output?: string,
): RuntimeItem {
  const input = fields(raw);
  const base = { itemId, status } as const;

  if (COMMAND_TOOLS.has(toolName)) {
    return {
      ...base,
      kind: "command",
      command: clip(input.command ?? "", 4000),
      cwd: clip(input.cwd ?? roots.cwd, 1024),
      ...(output === undefined ? {} : { output: clip(output, 4000) }),
    };
  }

  if (FILE_TOOLS.has(toolName)) {
    const path = input.file_path ?? input.notebook_path;

    return {
      ...base,
      kind: "file_change",
      paths: path === undefined ? [] : [clip(path, 1024)],
      ...(output === undefined ? {} : { summary: clip(output, 2000) }),
    };
  }

  if (AGENT_TOOLS.has(toolName)) {
    return {
      ...base,
      kind: "sub_agent",
      label: clip(input.description ?? input.subagent_type ?? "sub-agent", 200),
      ...(input.prompt === undefined ? {} : { task: clip(input.prompt, 2000) }),
      ...(output === undefined ? {} : { report: clip(output, 4000) }),
    };
  }

  return {
    ...base,
    kind: "tool_call",
    tool: clip(toolLabel(toolName), 128),
    ...(raw === undefined ? {} : { input: raw }),
    ...(output === undefined ? {} : { output: clip(output, 4000) }),
  };
}

/** Marks a sub-agent's own step with the sub-agent it belongs to. */
function withParent(item: RuntimeItem, parent: string | null): RuntimeItem {
  return parent === null ? item : { ...item, parentItemId: clip(parent, 128) };
}

/** The text of a tool_result: a string, or the text blocks joined. */
function resultText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");

  return text === "" ? undefined : text;
}

/** The user messages a live CLI is streamed, one per turn. Ending it lets the CLI exit. */
function createInbox(): AsyncIterable<SDKUserMessage> & {
  push(message: SDKUserMessage): void;
  end(): void;
} {
  const queued: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;

  return {
    push(message) {
      queued.push(message);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const message = queued.shift();

        if (message !== undefined) {
          yield message;
        } else if (ended) {
          return;
        } else {
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
        }
      }
    },
  };
}

/** The turn a live CLI is currently answering. Everything the CLI says goes to it. */
interface ClaudeTurn {
  message(message: SDKMessage): void;
  /** Noctis's gate, before the CLI's own permission system sees the call. */
  gate(toolName: string, toolInput: unknown, toolUseId: string): Promise<HookJSONOutput>;
  /** The CLI's own permission system asking. */
  canUseTool: CanUseTool;
  propose(kind: RuntimeProposal["kind"], args: unknown): void;
  delegate: RuntimeSink["delegate"];
  /** The CLI ended under the turn. */
  stop(error: Error): void;
}

interface ClaudeProcess extends LiveProcess {
  send(prompt: string, timeZone?: string, targets?: RuntimeTargets): void;
  current: ClaudeTurn | undefined;
  failure: Error | undefined;
  /** Sub-agent labels by the tool call that started them, kept across turns. */
  agents: Map<string, { label: string; task?: string }>;
  /** The sub-agent calls running in the background, whose tool result is only a placeholder. */
  background: Set<string>;
  /** Background tasks the CLI says are running, ambient ones left out. */
  liveTasks: number;
}

export function createClaudeRuntime(options: ClaudeRuntimeOptions = {}): Runtime {
  const query: ClaudeQuery = options.query ?? sdkQuery;
  const pool = createProcessPool<ClaudeProcess>(options.idleMs);
  /** Per thread, how to end a turn that is only staying open for background work. */
  const holds = new Map<string, () => void>();

  /** One CLI for one thread, opened with the roots and model of the turn that needed it. */
  function open(input: RuntimeTurnInput, key: string): ClaudeProcess {
    const { payload, roots } = input;
    const controller = new AbortController();
    const inbox = createInbox();
    let alive = true;
    let child: KillableChild | undefined;
    let closing: Promise<void> | undefined;

    const proc: ClaudeProcess = {
      key,
      sessionRef: undefined,
      current: undefined,
      failure: undefined,
      agents: new Map(),
      background: new Set(),
      liveTasks: 0,
      get alive() {
        return alive;
      },
      send(prompt, timeZone, targets) {
        inbox.push({
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "text", text: ownerClockBlock(timeZone, targets) },
            ],
          },
          parent_tool_use_id: null,
        });
      },
      close() {
        if (alive) {
          alive = false;
          const stopSdk = (): void => {
            inbox.end();
            controller.abort();
          };
          if (child === undefined) {
            stopSdk();
            closing = Promise.resolve();
          } else {
            // Keep the root alive for taskkill to discover descendants before SDK teardown.
            closing = killProcessTree(child).then(stopSdk);
          }
        }
        return closing ?? Promise.resolve();
      },
    };

    function end(error: Error): void {
      proc.failure ??= error;
      void proc.close();
      proc.current?.stop(error);
    }

    const surface = proposalSchema("surface");
    const objective = proposalSchema("objective");
    const preference = proposalSchema("preference");

    function record(kind: RuntimeProposal["kind"], args: unknown) {
      proc.current?.propose(kind, args);

      return Promise.resolve({ content: [{ type: "text" as const, text: "recorded" }] });
    }

    const noctis = createSdkMcpServer({
      name: "noctis",
      version: AGENT_VERSION,
      tools: [
        ...PRODUCTIVITY_TOOLS.map(({ kind, description, inputSchema }) =>
          tool(`noctis_propose_${kind}`, description, inputSchema.shape, (args) =>
            record(kind, args),
          ),
        ),
        tool(
          "noctis_propose_surface",
          PANEL_TOOL_DESCRIPTION,
          surface.omit({ kind: true }).shape,
          (args) => {
            const problem = surfaceProblem(args);

            return problem === undefined
              ? record("surface", args)
              : Promise.resolve({
                  content: [{ type: "text" as const, text: problem }],
                  isError: true,
                });
          },
        ),
        tool(
          "noctis_propose_objective",
          "Propose an objective for the operator to consider. It is recorded as a suggestion, never started.",
          objective.omit({ kind: true }).shape,
          (args) => record("objective", args),
        ),
        tool(
          "noctis_delegate",
          DELEGATE_TOOL_DESCRIPTION,
          RuntimeDelegationSchema.omit({ delegationId: true }).shape,
          async (args) => {
            const current = proc.current;

            if (current === undefined) {
              return { content: [{ type: "text" as const, text: NO_TURN }], isError: true };
            }

            try {
              const result = await current.delegate(args);
              // The delegation id is Noctis's bookkeeping; the agent needs the thread.
              const text = JSON.stringify(result, (key, value: unknown) =>
                key === "delegationId" ? undefined : value,
              );

              return {
                content: [{ type: "text" as const, text }],
                ...(result.outcome === "completed" ? {} : { isError: true }),
              };
            } catch (error) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `delegation did not finish: ${error instanceof Error ? error.message : "unknown"}`,
                  },
                ],
                isError: true,
              };
            }
          },
        ),
        tool(
          "noctis_remember_preference",
          "Record one durable thing learned about how to work with the owner. Noctis applies its own rules to the Agent Brain and may refuse; nothing is written by this call.",
          preference.omit({ kind: true }).shape,
          (args) => record("preference", args),
        ),
      ],
    });

    // The owner's browser and desktop, where this PC has them.
    const screen = Object.entries({
      [BROWSER_SERVER]: browserServer(input.env, payload.threadId),
      [DESKTOP_SERVER]: desktopServer(input.env),
    }).filter((entry): entry is [string, StdioServer] => entry[1] !== undefined);

    // The SDK does not split read from write access: `additionalDirectories`
    // grants both, so a write into a read root is caught by the gate, where
    // `classifyAsk` calls a path outside every writable root external_write.
    const card = identityCard({
      identityId: payload.identityId,
      runtime: "claude",
      model: payload.model.model,
      env: input.env,
      readable: roots.readable,
      timeZone: payload.ownerTimeZone,
    });
    const sdkOptions: Options = {
      cwd: roots.cwd,
      additionalDirectories: [...roots.writable.filter((r) => r !== roots.cwd), ...roots.readable],
      env: input.env,
      model: payload.model.model,
      permissionMode: "auto",
      // Without these the CLI's own permission system asks about every click; the
      // PreToolUse gate still runs first and stops a step that commits the owner.
      allowedTools: screen.map(([name]) => `mcp__${name}`),
      disallowedTools: DISALLOWED_TOOLS,
      settingSources: ["user", "project", "local"],
      skills: "all",
      // The preset keeps Claude Code's own prompt, so the owner's setup still loads.
      ...(card === undefined
        ? {}
        : {
            systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: card },
          }),
      includePartialMessages: true,
      // A line on what each sub-agent is doing, so the owner is not watching a spinner.
      agentProgressSummaries: true,
      abortController: controller,
      spawnClaudeCodeProcess(spawnOptions) {
        const spawned = spawn(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
        spawned.stderr.resume();
        trackChild(spawned, spawnOptions.command);
        child = spawned;
        return spawned;
      },
      mcpServers: {
        noctis,
        ...Object.fromEntries(
          screen.map(([name, server]) => [name, { type: "stdio" as const, ...server }]),
        ),
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              (hookInput, toolUseId) =>
                hookInput.hook_event_name !== "PreToolUse"
                  ? Promise.resolve({})
                  : proc.current === undefined
                    ? Promise.resolve(gateDecision("deny", NO_TURN))
                    : proc.current.gate(
                        hookInput.tool_name,
                        hookInput.tool_input,
                        toolUseId ?? hookInput.tool_use_id,
                      ),
            ],
            // A person may take minutes. The node's own approval timeout ends
            // the wait first and fails the turn; this only must not end it sooner.
            timeout: HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
      // A tool call with no turn to ask on has nobody to answer it.
      canUseTool: (toolName, toolInput, ctx) =>
        proc.current === undefined
          ? Promise.resolve({ behavior: "deny", message: NO_TURN })
          : proc.current.canUseTool(toolName, toolInput, ctx),
      ...(payload.sessionRef === undefined ? {} : { resume: payload.sessionRef }),
      // A session started outside Noctis may still be open in VS Code: carry
      // its context into a copy rather than append to the file it is writing.
      ...(payload.sessionRef !== undefined && payload.forkSession === true
        ? { forkSession: true }
        : {}),
    };

    const messages = query({ prompt: inbox, options: sdkOptions });

    void (async () => {
      try {
        for await (const message of messages) {
          if (message.type === "system" && message.subtype === "init") {
            proc.sessionRef = message.session_id;

            if (message.apiKeySource !== "none") {
              // A key would bill per token; the whole route exists to avoid that.
              end(new AdapterRefused(`claude_api_key_login_is_metered: ${message.apiKeySource}`));
              return;
            }
          }

          proc.current?.message(message);
        }

        end(new Error("claude turn ended without a result"));
      } catch (error) {
        end(error instanceof Error ? error : new Error("claude stream failed"));
      }
    })();

    return proc;
  }

  /** One user message sent to a live CLI, answered when its `result` arrives. */
  function answer(
    proc: ClaudeProcess,
    input: RuntimeTurnInput,
    sink: RuntimeSink,
  ): Promise<RuntimeTurnEvidence> {
    const { payload, roots, signal } = input;
    const pending = new Map<string, { name: string; input: unknown; parent: string | null }>();
    const denied = new Set<string>();
    let itemCount = 0;
    let proposals = 0;
    let messageIndex = 0;
    let fresh = false;
    let finalText: string | undefined;
    let usage: RuntimeTurnEvidence["usage"];
    let held: RuntimeTurnEvidence | undefined;

    function emit(item: RuntimeItem): void {
      if (item.status !== "in_progress") {
        itemCount += 1;
      }

      sink.item(item);
    }

    function evidence(stoppedReason: RuntimeTurnEvidence["stoppedReason"]): RuntimeTurnEvidence {
      return {
        model: payload.model,
        ...(proc.sessionRef === undefined ? {} : { sessionRef: clip(proc.sessionRef, 512) }),
        itemCount,
        ...(finalText === undefined ? {} : { finalText: clip(finalText, 20_000) }),
        ...(usage === undefined ? {} : { usage }),
        stoppedReason,
      };
    }

    return new Promise<RuntimeTurnEvidence>((resolve, reject) => {
      let settled = false;
      // Cancelling closes the CLI; the next turn resumes the session in a new one.
      const cancel = (): void => {
        void Promise.resolve(proc.close()).then(() => turn.stop(new Error("claude cancelled")));
      };

      function settle(outcome: RuntimeTurnEvidence | Error): void {
        if (settled) {
          return;
        }

        settled = true;
        signal.removeEventListener("abort", cancel);

        if (holds.get(payload.threadId) === release) {
          holds.delete(payload.threadId);
        }

        if (proc.current === turn) {
          proc.current = undefined;
        }

        const cleanup =
          outcome instanceof Error || signal.aborted || !proc.alive ? proc.close() : undefined;
        void Promise.resolve(cleanup).then(() => {
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        });
      }

      /** The owner's next message takes over whatever background work is still running. */
      function release(): void {
        if (held !== undefined) settle(held);
      }

      /** Asks the core and waits. A timeout fails the turn in its own words. */
      async function consult(
        ask: Omit<RuntimeAsk, "askId">,
        toolUseId: string,
      ): Promise<{ allowed: boolean; message: string; stop: boolean }> {
        try {
          const answer = await sink.ask(ask);

          if (answer.decision === "allow") {
            return { allowed: true, message: "", stop: false };
          }

          denied.add(toolUseId);

          return { allowed: false, message: answer.reason ?? DECLINED, stop: false };
        } catch (error) {
          denied.add(toolUseId);

          if (error instanceof ApprovalTimedOut) {
            // The CLI is mid-call; a later turn must not inherit it. The next
            // message resumes the session in a new process.
            void proc.close();
            settle(error);
          }

          // Cancelled or disconnected mid-ask: fail closed and stop the turn.
          return { allowed: false, message: "Noctis authority did not answer", stop: true };
        }
      }

      const turn: ClaudeTurn = {
        stop(error) {
          settle(
            error instanceof AdapterRefused || !signal.aborted ? error : evidence("cancelled"),
          );
        },

        delegate: (delegation) => sink.delegate(delegation),

        propose(kind, args) {
          proposals += 1;
          emit({
            itemId: `proposal-${String(proposals)}`,
            kind: "proposal",
            status: "completed",
            proposal: RuntimeProposalSchema.parse({ kind, ...(args as object) }),
          });
        },

        async gate(toolName, toolInput, toolUseId) {
          // Refused, not asked: raw code in the owner's browser is not a
          // decision the owner should be handed.
          if (refusedTool(toolName)) {
            return gateDecision("deny", `${toolName} is not a tool Noctis lends`);
          }

          const ask = describeCall(toolName, toolInput, clip(toolUseId, 128), roots);

          if (!isConfirmLevel(ask.operationClass)) {
            // Below confirm-level the agent's own permission system decides.
            return {};
          }

          const answer = await consult({ ...ask, askedBy: "noctis" }, toolUseId);

          return answer.allowed
            ? gateDecision("allow", "confirmed in Noctis")
            : gateDecision("deny", answer.message);
        },

        async canUseTool(toolName, toolInput, ctx): Promise<PermissionResult> {
          if (refusedTool(toolName)) {
            return { behavior: "deny", message: `${toolName} is not a tool Noctis lends` };
          }

          // An approval card has no room for the questions or their options. The
          // thread shows them from the tool call itself, and the owner's pick
          // arrives as the next message.
          if (toolName === "AskUserQuestion") {
            denied.add(ctx.toolUseID);
            return { behavior: "deny", message: QUESTIONS_IN_THREAD };
          }

          // The agent wanted a person, so a person answers, whatever the class.
          const ask = describeCall(toolName, toolInput, clip(ctx.toolUseID, 128), roots);
          const answer = await consult({ ...ask, askedBy: "runtime" }, ctx.toolUseID);

          return answer.allowed
            ? { behavior: "allow", updatedInput: toolInput }
            : {
                behavior: "deny",
                message: answer.message,
                ...(answer.stop ? { interrupt: true } : {}),
              };
        },

        message(message) {
          switch (message.type) {
            case "stream_event": {
              if (message.parent_tool_use_id !== null) {
                break;
              }

              const event = message.event;

              if (event.type === "message_start") {
                messageIndex += 1;
                fresh = true;
              } else if (
                event.type === "content_block_delta" &&
                event.delta.type === "text_delta" &&
                event.delta.text !== ""
              ) {
                sink.delta(`msg-${String(messageIndex)}`, clip(event.delta.text, 2000));
              }

              break;
            }
            case "assistant": {
              for (const block of message.message.content) {
                if (block.type === "text" && message.parent_tool_use_id === null) {
                  // The deltas ran under the index message_start opened; a text
                  // block with no stream before it opens its own.
                  if (!fresh) {
                    messageIndex += 1;
                  }

                  fresh = false;
                  finalText = block.text;
                  emit({
                    itemId: `msg-${String(messageIndex)}`,
                    kind: "agent_message",
                    status: "completed",
                    text: clip(block.text, 20_000),
                  });
                } else if (block.type === "tool_use") {
                  const parent = message.parent_tool_use_id;
                  pending.set(block.id, { name: block.name, input: block.input, parent });
                  const item = withParent(
                    toolItem(clip(block.id, 128), block.name, block.input, roots, "in_progress"),
                    parent,
                  );

                  if (item.kind === "sub_agent") {
                    proc.agents.set(block.id, {
                      label: item.label,
                      ...(item.task === undefined ? {} : { task: item.task }),
                    });
                  }

                  emit(item);
                }
              }

              break;
            }
            case "user": {
              const content = message.message.content;

              if (typeof content === "string") {
                break;
              }

              for (const block of content) {
                if (block.type !== "tool_result") {
                  continue;
                }

                const started = pending.get(block.tool_use_id);

                if (started === undefined) {
                  continue;
                }

                pending.delete(block.tool_use_id);

                // "Async agent launched": the sub-agent has only just started.
                if (proc.background.has(block.tool_use_id)) {
                  continue;
                }

                proc.agents.delete(block.tool_use_id);

                const status =
                  block.is_error === true
                    ? denied.has(block.tool_use_id)
                      ? "declined"
                      : "failed"
                    : "completed";

                emit(
                  withParent(
                    toolItem(
                      clip(block.tool_use_id, 128),
                      started.name,
                      started.input,
                      roots,
                      status,
                      resultText(block.content),
                    ),
                    started.parent,
                  ),
                );
              }

              break;
            }
            case "result": {
              usage = {
                inputTokens: message.usage.input_tokens,
                outputTokens: message.usage.output_tokens,
              };

              if (message.subtype === "success") {
                if (message.result !== "") {
                  finalText = message.result;
                }

                const outcome = evidence(message.is_error ? "failed" : "completed");

                // The CLI wakes itself when a background task settles and answers
                // again; without a turn open, that answer had nowhere to go and
                // every tool call in it was refused.
                if (!message.is_error && proc.liveTasks > 0) {
                  held = outcome;
                  holds.set(payload.threadId, release);
                } else {
                  settle(outcome);
                }
              } else {
                settle(evidence(signal.aborted ? "cancelled" : "failed"));
              }

              break;
            }
            case "system": {
              if (message.subtype === "background_tasks_changed") {
                proc.liveTasks = message.tasks.filter((task) => task.ambient !== true).length;
                break;
              }

              if (message.subtype === "task_started") {
                if (message.is_backgrounded === true && message.tool_use_id !== undefined) {
                  proc.background.add(message.tool_use_id);
                }
                break;
              }

              if (message.subtype !== "task_progress" && message.subtype !== "task_notification") {
                // Init, hooks, rate limits, status: the CLI's bookkeeping, not evidence.
                break;
              }

              const id = message.tool_use_id;
              const agent = id === undefined ? undefined : proc.agents.get(id);

              if (id === undefined || agent === undefined) {
                break;
              }

              const base = {
                itemId: clip(id, 128),
                kind: "sub_agent",
                ...agent,
                ...(message.usage === undefined
                  ? {}
                  : {
                      tokens: message.usage.total_tokens,
                      toolUses: message.usage.tool_uses,
                      durationMs: message.usage.duration_ms,
                    }),
              } as const;

              if (message.subtype === "task_progress") {
                const activity =
                  message.summary ??
                  (message.last_tool_name === undefined
                    ? undefined
                    : `using ${toolLabel(message.last_tool_name)}`);

                emit({
                  ...base,
                  status: "in_progress",
                  ...(activity === undefined ? {} : { activity: clip(activity, 200) }),
                });
              } else if (proc.background.delete(id)) {
                // A foreground sub-agent ends with its tool result instead.
                proc.agents.delete(id);
                emit({
                  ...base,
                  status: message.status === "completed" ? "completed" : "failed",
                  ...(message.summary === "" ? {} : { report: clip(message.summary, 4000) }),
                });
              }

              break;
            }
            default:
              // Rate limits, tool progress: the CLI's bookkeeping, not evidence.
              break;
          }
        },
      };

      proc.current = turn;
      signal.addEventListener("abort", cancel, { once: true });
      proc.send(payload.prompt, payload.ownerTimeZone, payload.targets);

      if (!proc.alive) {
        turn.stop(proc.failure ?? new Error("claude ended before the turn started"));
      }
    });
  }

  return {
    providerId: "claude",
    probe: (): Promise<RuntimeProbe> => probeClaudeInstalled(options.env ?? process.env),
    /**
     * The folder's sessions from Claude Code's own store, through the SDK. The
     * programmatic ones are left out: Noctis's turns run through the SDK, and
     * those are threads already.
     */
    async listSessions(cwd: string): Promise<ExternalSession[]> {
      const found = await (options.listSessions ?? sdkListSessions)({
        dir: cwd,
        limit: MAX_LISTED_SESSIONS,
        includeProgrammatic: false,
      });

      return found.map((session) => ({
        providerId: "claude" as const,
        sessionRef: clip(session.sessionId, 200),
        title: clip(session.customTitle ?? session.summary, 200),
        lastActiveAt: new Date(session.lastModified).toISOString(),
      }));
    },
    /** Looked up in that folder's store only, so a session kept elsewhere is not found. */
    async readHistory(cwd: string, sessionRef: string): Promise<SessionExchange[]> {
      return exchangesOf(
        await (options.getSessionMessages ?? sdkGetSessionMessages)(sessionRef, { dir: cwd }),
      );
    },
    turn(input: RuntimeTurnInput, sink: RuntimeSink): Promise<RuntimeTurnEvidence> {
      const { payload, roots, signal } = input;

      if (signal.aborted) {
        return Promise.reject(new AdapterRefused("job was cancelled"));
      }

      // The adapter already stripped these; this is the boundary, so it is asserted, not assumed.
      const leaked = Object.keys(input.env).find((key) =>
        (BILLING_KEYS as readonly string[]).includes(key.toUpperCase()),
      );

      if (leaked !== undefined) {
        return Promise.reject(
          new AdapterRefused(`billing key ${leaked} in the runtime environment`),
        );
      }

      holds.get(payload.threadId)?.();

      const key = processKey(payload, roots);

      return pool.run(
        payload.threadId,
        { key, sessionRef: payload.sessionRef },
        () => open(input, key),
        (proc) => answer(proc, input, sink),
      );
    },
    close: () => pool.closeAll(),
  };
}
