import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, query as sdkQuery, tool } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeAsk, RuntimeItem, RuntimeProbe, RuntimeTurnEvidence } from "@noctis/contracts";
import { RuntimeProposalSchema } from "@noctis/contracts";
import { classifyAsk } from "@noctis/domain";
import { z } from "zod";

import { AGENT_VERSION } from "../agent.js";
import type { ResolvedRoots, Runtime, RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { AdapterRefused } from "./Runtime.js";
import { BILLING_KEYS } from "./env.js";
import { probeClaudeInstalled } from "./probe.js";

/**
 * Claude Code behind the node boundary, through the Agent SDK (ADR-0020/0021).
 *
 * `query()` spawns the SDK's own bundled CLI (never the CLI's bare mode, never
 * an API key: the environment arrives stripped and the login is the owner's
 * claude.ai subscription). `settingSources: []` and `strictMcpConfig: true`
 * keep the owner's ~/.claude hooks, plugins and MCP servers out of the turn.
 * Every consequential tool call comes back through `canUseTool`, is classified
 * by `classifyAsk`, and waits on `sink.ask`; the runtime never decides.
 *
 * The Noctis proposal tools are hosted in-process with `createSdkMcpServer`:
 * an `sdk`-type server is relayed over the CLI child's stdio control channel,
 * so no port opens and no proposals file is needed on this route.
 */

export type ClaudeQuery = (params: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export interface ClaudeRuntimeOptions {
  /** The SDK's `query`; tests hand in a scripted generator. */
  query?: ClaudeQuery;
  env?: NodeJS.ProcessEnv;
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const AGENT_TOOLS = new Set(["Task", "Agent"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);
/** Reading, listing, planning, delegating: allowed locally, no ask (ADR-0021 read_inspect). */
const LOCAL_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "TodoWrite",
  "TodoRead",
  ...AGENT_TOOLS,
]);
const NOCTIS_PREFIX = "mcp__noctis__";
const DECLINED = "declined by Noctis authority";

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

/** The ask one tool call raises, or nothing when its class is read_inspect. */
function askFor(
  toolName: string,
  raw: unknown,
  itemId: string,
  roots: ResolvedRoots,
): Omit<RuntimeAsk, "askId"> | undefined {
  if (LOCAL_TOOLS.has(toolName)) {
    return undefined;
  }

  const input = fields(raw);
  const scope = { writableRoots: roots.writable, readableRoots: roots.readable };
  let ask: Omit<RuntimeAsk, "askId">;

  if (toolName === "Bash") {
    const command = input.command ?? "";
    const cwd = input.cwd ?? roots.cwd;
    const cls = classifyAsk({ kind: "command", command, cwd, ...scope });

    ask = {
      itemId,
      kind: "command",
      summary: clip(command, 2000).trim() || "run a command",
      operationClass: cls.operationClass,
      reversibility: cls.reversibility,
      capability: cls.capability,
      target: { type: "command", id: clip(command, 200).trim() || "command" },
      detail: { command: clip(command, 4000), cwd: clip(cwd, 1024) },
    };
  } else if (FILE_TOOLS.has(toolName)) {
    const paths = [input.file_path ?? input.notebook_path ?? ""]
      .filter((p) => p !== "")
      .map((p) => clip(p, 1024));
    const cls = classifyAsk({ kind: "file_change", paths, ...scope });

    ask = {
      itemId,
      kind: "file_change",
      summary: clip(`edit ${paths.join(", ") || "a file"}`, 2000),
      operationClass: cls.operationClass,
      reversibility: cls.reversibility,
      capability: cls.capability,
      target: { type: "file_change", id: clip(paths[0] ?? itemId, 200) },
      detail: { paths },
    };
  } else if (WEB_TOOLS.has(toolName)) {
    const cls = classifyAsk({ kind: "permission", ...scope });

    ask = {
      itemId,
      kind: "permission",
      summary: clip(`${toolName} ${input.url ?? input.query ?? ""}`, 2000).trim(),
      operationClass: cls.operationClass,
      reversibility: cls.reversibility,
      capability: cls.capability,
      target: { type: "permission", id: toolName },
    };
  } else {
    const name = toolLabel(toolName);
    const cls = classifyAsk({ kind: "tool_call", tool: name, ...scope });

    ask = {
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

  return ask.operationClass === "read_inspect" ? undefined : ask;
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

  if (toolName === "Bash") {
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

export function createClaudeRuntime(options: ClaudeRuntimeOptions = {}): Runtime {
  const query: ClaudeQuery = options.query ?? sdkQuery;

  return {
    providerId: "claude",
    probe: (): Promise<RuntimeProbe> => probeClaudeInstalled(options.env ?? process.env),
    async turn(input: RuntimeTurnInput, sink: RuntimeSink): Promise<RuntimeTurnEvidence> {
      const { payload, roots, signal } = input;

      if (signal.aborted) {
        throw new AdapterRefused("job was cancelled");
      }

      // The adapter already stripped these; this is the boundary, so it is asserted, not assumed.
      const leaked = Object.keys(input.env).find((key) =>
        (BILLING_KEYS as readonly string[]).includes(key.toUpperCase()),
      );

      if (leaked !== undefined) {
        throw new AdapterRefused(`billing key ${leaked} in the runtime environment`);
      }

      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const pending = new Map<string, { name: string; input: unknown }>();
      const denied = new Set<string>();
      let itemCount = 0;
      let proposals = 0;
      let messageIndex = 0;
      let fresh = false;
      let sessionRef: string | undefined;
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
          ...(sessionRef === undefined ? {} : { sessionRef: clip(sessionRef, 512) }),
          itemCount,
          ...(finalText === undefined ? {} : { finalText: clip(finalText, 20_000) }),
          ...(usage === undefined ? {} : { usage }),
          stoppedReason,
        };
      }

      const canUseTool: CanUseTool = async (
        toolName,
        toolInput,
        ctx,
      ): Promise<PermissionResult> => {
        const ask = askFor(toolName, toolInput, clip(ctx.toolUseID, 128), roots);

        if (ask === undefined) {
          return { behavior: "allow", updatedInput: toolInput };
        }

        try {
          const answer = await sink.ask(ask);

          if (answer.decision === "allow") {
            return { behavior: "allow", updatedInput: toolInput };
          }

          denied.add(ctx.toolUseID);

          return { behavior: "deny", message: answer.reason ?? DECLINED };
        } catch {
          // Cancelled or disconnected mid-ask: fail closed and stop the turn.
          denied.add(ctx.toolUseID);

          return { behavior: "deny", message: "Noctis authority did not answer", interrupt: true };
        }
      };

      const [surface, objective] = RuntimeProposalSchema.options;

      function record(kind: "surface" | "objective", args: unknown) {
        proposals += 1;
        emit({
          itemId: `proposal-${String(proposals)}`,
          kind: "proposal",
          status: "completed",
          proposal: RuntimeProposalSchema.parse({ kind, ...(args as object) }),
        });

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
        ],
      });

      // The SDK does not split read from write access: `additionalDirectories`
      // grants both, so writes into a read root are caught by canUseTool +
      // classifyAsk (a path outside every writable root is external_write).
      const sdkOptions: Options = {
        cwd: roots.cwd,
        additionalDirectories: [
          ...roots.writable.filter((r) => r !== roots.cwd),
          ...roots.readable,
        ],
        env: input.env,
        model: payload.model.model,
        permissionMode: "default",
        settingSources: [],
        strictMcpConfig: true,
        includePartialMessages: true,
        abortController: controller,
        mcpServers: { noctis },
        canUseTool,
        ...(payload.sessionRef === undefined ? {} : { resume: payload.sessionRef }),
      };

      signal.addEventListener("abort", abort, { once: true });

      try {
        for await (const message of query({ prompt: payload.prompt, options: sdkOptions })) {
          switch (message.type) {
            case "system": {
              if (message.subtype !== "init") {
                break;
              }

              sessionRef = message.session_id;

              if (message.apiKeySource !== "none") {
                // A key would bill per token; the whole route exists to avoid that.
                controller.abort();
                throw new AdapterRefused(
                  `claude_api_key_login_is_metered: ${message.apiKeySource}`,
                );
              }

              break;
            }
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

                return evidence(message.is_error ? "failed" : "completed");
              }

              return evidence(signal.aborted ? "cancelled" : "failed");
            }
            default:
              // Hooks, tasks, rate limits, status: the CLI's bookkeeping, not evidence.
              break;
          }
        }
      } catch (error) {
        if (error instanceof AdapterRefused) {
          throw error;
        }

        if (signal.aborted) {
          return evidence("cancelled");
        }

        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }

      if (signal.aborted) {
        return evidence("cancelled");
      }

      throw new Error("claude turn ended without a result");
    },
  };
}
