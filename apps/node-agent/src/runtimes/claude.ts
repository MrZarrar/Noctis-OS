import type {
  CanUseTool,
  HookJSONOutput,
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, query as sdkQuery, tool } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeAsk, RuntimeItem, RuntimeProbe, RuntimeTurnEvidence } from "@noctis/contracts";
import { RuntimeProposalSchema } from "@noctis/contracts";
import { classifyAsk, isConfirmLevel } from "@noctis/domain";
import { z } from "zod";

import { AGENT_VERSION } from "../agent.js";
import type { ResolvedRoots, Runtime, RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { AdapterRefused, ApprovalTimedOut } from "./Runtime.js";
import { BILLING_KEYS } from "./env.js";
import { PLAYWRIGHT_SERVER, playwrightServer, refusedBrowserTool } from "./mcp-config.js";
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

export interface ClaudeRuntimeOptions {
  /** The SDK's `query`; tests hand in a scripted generator. */
  query?: ClaudeQuery;
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
const NOCTIS_PREFIX = "mcp__noctis__";
const DECLINED = "declined by Noctis authority";
const NO_TURN = "no Noctis turn is running";
const HOOK_TIMEOUT_SECONDS = 24 * 60 * 60;

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
  const scope = { writableRoots: roots.writable, readableRoots: roots.readable };

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
    : classifyAsk({ kind: "tool_call", tool: name, ...scope });

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
  propose(kind: "surface" | "objective" | "preference", args: unknown): void;
  /** The CLI ended under the turn. */
  stop(error: Error): void;
}

interface ClaudeProcess extends LiveProcess {
  send(prompt: string): void;
  current: ClaudeTurn | undefined;
  failure: Error | undefined;
}

export function createClaudeRuntime(options: ClaudeRuntimeOptions = {}): Runtime {
  const query: ClaudeQuery = options.query ?? sdkQuery;
  const pool = createProcessPool<ClaudeProcess>(options.idleMs);

  /** One CLI for one thread, opened with the roots and model of the turn that needed it. */
  function open(input: RuntimeTurnInput, key: string): ClaudeProcess {
    const { payload, roots } = input;
    const controller = new AbortController();
    const inbox = createInbox();
    let alive = true;

    const proc: ClaudeProcess = {
      key,
      sessionRef: undefined,
      current: undefined,
      failure: undefined,
      get alive() {
        return alive;
      },
      send(prompt) {
        inbox.push({
          type: "user",
          message: { role: "user", content: prompt },
          parent_tool_use_id: null,
        });
      },
      close() {
        if (alive) {
          alive = false;
          inbox.end();
          controller.abort();
        }
      },
    };

    function end(error: Error): void {
      proc.failure ??= error;
      proc.close();
      proc.current?.stop(error);
    }

    const [surface, objective, preference] = RuntimeProposalSchema.options;

    function record(kind: "surface" | "objective" | "preference", args: unknown) {
      proc.current?.propose(kind, args);

      return Promise.resolve({ content: [{ type: "text" as const, text: "recorded" }] });
    }

    const noctis = createSdkMcpServer({
      name: "noctis",
      version: AGENT_VERSION,
      tools: [
        tool(
          "noctis_propose_surface",
          "Propose a surface for Noctis to place. Noctis validates it and decides; nothing is placed by this call.",
          surface.omit({ kind: true }).shape,
          (args) => record("surface", args),
        ),
        tool(
          "noctis_propose_objective",
          "Propose an objective for the operator to consider. It is recorded as a suggestion, never started.",
          objective.omit({ kind: true }).shape,
          (args) => record("objective", args),
        ),
        tool(
          "noctis_remember_preference",
          "Record one durable thing learned about how to work with the owner. Noctis applies its own rules to the Agent Brain and may refuse; nothing is written by this call.",
          preference.omit({ kind: true }).shape,
          (args) => record("preference", args),
        ),
      ],
    });

    // One browser profile per thread, and only on this route: see mcp-config.
    const browser = playwrightServer(input.env, payload.threadId);

    // The SDK does not split read from write access: `additionalDirectories`
    // grants both, so a write into a read root is caught by the gate, where
    // `classifyAsk` calls a path outside every writable root external_write.
    const sdkOptions: Options = {
      cwd: roots.cwd,
      additionalDirectories: [...roots.writable.filter((r) => r !== roots.cwd), ...roots.readable],
      env: input.env,
      model: payload.model.model,
      permissionMode: "auto",
      settingSources: ["user", "project", "local"],
      skills: "all",
      includePartialMessages: true,
      abortController: controller,
      mcpServers: {
        noctis,
        ...(browser === undefined
          ? {}
          : { [PLAYWRIGHT_SERVER]: { type: "stdio" as const, ...browser } }),
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
    const pending = new Map<string, { name: string; input: unknown }>();
    const denied = new Set<string>();
    let itemCount = 0;
    let proposals = 0;
    let messageIndex = 0;
    let fresh = false;
    let finalText: string | undefined;
    let usage: RuntimeTurnEvidence["usage"];

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
      const cancel = (): void => proc.close();

      function settle(outcome: RuntimeTurnEvidence | Error): void {
        if (settled) {
          return;
        }

        settled = true;
        signal.removeEventListener("abort", cancel);

        if (proc.current === turn) {
          proc.current = undefined;
        }

        if (outcome instanceof Error) {
          reject(outcome);
        } else {
          resolve(outcome);
        }
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
            proc.close();
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
          // Refused, not asked: a browser tool outside the allowlist is not a
          // decision the owner should be handed. `browser_evaluate` and
          // `browser_run_code_unsafe` are on the same server as the five.
          if (refusedBrowserTool(toolName)) {
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
          if (refusedBrowserTool(toolName)) {
            return { behavior: "deny", message: `${toolName} is not a tool Noctis lends` };
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
                  pending.set(block.id, { name: block.name, input: block.input });
                  emit(
                    toolItem(clip(block.id, 128), block.name, block.input, roots, "in_progress"),
                  );
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

                const status =
                  block.is_error === true
                    ? denied.has(block.tool_use_id)
                      ? "declined"
                      : "failed"
                    : "completed";

                emit(
                  toolItem(
                    clip(block.tool_use_id, 128),
                    started.name,
                    started.input,
                    roots,
                    status,
                    resultText(block.content),
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

                settle(evidence(message.is_error ? "failed" : "completed"));
              } else {
                settle(evidence(signal.aborted ? "cancelled" : "failed"));
              }

              break;
            }
            default:
              // Init, hooks, tasks, rate limits, status: the CLI's bookkeeping, not evidence.
              break;
          }
        },
      };

      proc.current = turn;
      signal.addEventListener("abort", cancel, { once: true });
      proc.send(payload.prompt);

      if (!proc.alive) {
        turn.stop(proc.failure ?? new Error("claude ended before the turn started"));
      }
    });
  }

  return {
    providerId: "claude",
    probe: (): Promise<RuntimeProbe> => probeClaudeInstalled(options.env ?? process.env),
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
