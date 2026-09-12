import { spawn as spawnChild } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import type {
  RuntimeAsk,
  RuntimeItem,
  RuntimeItemStatus,
  RuntimeProbe,
  RuntimeTurnEvidence,
} from "@noctis/contracts";
import { classifyAsk } from "@noctis/domain";
import { z } from "zod";

import { AGENT_VERSION } from "../agent.js";
import { createProposalChannel } from "../proposals-file.js";
import type { Runtime, RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { AdapterRefused } from "./Runtime.js";
import { resolveCodexCommand } from "./codex-command.js";
import { childEnvironment } from "./env.js";
import { JsonRpcError, METHOD_NOT_FOUND, createJsonRpcClient } from "./jsonrpc.js";
import { probeCodexInstalled } from "./probe.js";

/**
 * Codex App Server behind the node boundary (ADR-0020/0021).
 *
 * One `codex app-server` process per turn, spoken to over stdio JSON-RPC. The
 * owner's config.toml is overridden on the command line and per request:
 * model, sandbox, approval policy, and every MCP server or plugin that would
 * hand the model a tool no ask ever sees. Each approval Codex raises becomes
 * a `sink.ask` classified by `classifyAsk`; the runtime never decides.
 */

/** What `spawn` returns, narrowed to what a turn touches so tests can hand in a fake. */
export interface SpawnedChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | null;
  exitCode: number | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(): unknown;
}

export type CodexSpawn = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => SpawnedChild;

export interface CodexRuntimeOptions {
  /** Path to `codex.exe`; resolved from the machine when absent. */
  command?: string;
  spawn?: CodexSpawn;
  /** One proposals file per turn lands here. */
  proposalsDir: string;
  /** `dist/noctis-mcp.js`; the sibling of this file's parent in the build. */
  mcpEntry?: string;
  /** The owner's `~/.codex`, read only for the MCP servers it declares. */
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
}

const KILL_AFTER_INTERRUPT_MS = 5_000;
const STDERR_TAIL_BYTES = 2_000;
const NO_INPUT_TEXT =
  "Noctis does not answer runtime questions mid-turn; continue without the input.";

/* ------------------------------------------------------------------------ */
/* Codex's shapes, not ours: loose objects reading only the fields used.     */
/* ------------------------------------------------------------------------ */

const ThreadItemSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    status: z.string().optional(),
    text: z.string().optional(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    aggregatedOutput: z.string().nullable().optional(),
    exitCode: z.number().nullable().optional(),
    changes: z
      .array(z.object({ path: z.string(), kind: z.object({ type: z.string() }).loose() }).loose())
      .optional(),
    tool: z.unknown().optional(),
    arguments: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
    contentItems: z
      .array(z.object({ type: z.string(), text: z.string().optional() }).loose())
      .nullable()
      .optional(),
    kind: z.string().optional(),
    agentPath: z.string().optional(),
  })
  .loose();

type ThreadItem = z.infer<typeof ThreadItemSchema>;

const ItemNotificationSchema = z.object({ item: ThreadItemSchema }).loose();
const DeltaNotificationSchema = z.object({ itemId: z.string(), delta: z.string() }).loose();
const TurnCompletedSchema = z
  .object({ turn: z.object({ id: z.string(), status: z.string() }).loose() })
  .loose();
const TokenUsageSchema = z
  .object({
    tokenUsage: z
      .object({ total: z.object({ inputTokens: z.number(), outputTokens: z.number() }).loose() })
      .loose(),
  })
  .loose();
const ThreadResponseSchema = z.object({ thread: z.object({ id: z.string() }).loose() }).loose();
const TurnResponseSchema = z.object({ turn: z.object({ id: z.string() }).loose() }).loose();
const CommandApprovalSchema = z
  .object({
    itemId: z.string(),
    command: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
  })
  .loose();
const ItemIdSchema = z.object({ itemId: z.string() }).loose();
const PermissionsApprovalSchema = z
  .object({
    itemId: z.string(),
    cwd: z.string().optional(),
    reason: z.string().nullable().optional(),
    permissions: z
      .object({
        network: z.object({ enabled: z.boolean().nullable() }).loose().nullable(),
        fileSystem: z.object({}).loose().nullable(),
      })
      .loose(),
  })
  .loose();

const STATUS: Readonly<Record<string, RuntimeItemStatus>> = {
  inProgress: "in_progress",
  completed: "completed",
  failed: "failed",
  declined: "declined",
};

const STOPPED: Readonly<Record<string, RuntimeTurnEvidence["stoppedReason"]>> = {
  completed: "completed",
  interrupted: "cancelled",
  failed: "failed",
};

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** A JSON string or array is a valid TOML basic string or array, which is what `-c` parses. */
function toml(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * The MCP servers the owner's config.toml declares, so each can be switched
 * off. ponytail: bare table names only; a quoted `[mcp_servers."a b"]` cannot
 * be reached through `-c` anyway. Plugins are handled by `--disable plugins`.
 */
function ownerMcpServers(codexHome: string): string[] {
  try {
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");

    return [
      ...new Set(
        [...config.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)].map((m) => m[1] ?? ""),
      ),
    ].filter((name) => name !== "");
  } catch {
    return [];
  }
}

function spawnArgs(
  model: string,
  mcpEntry: string,
  proposalsFile: string,
  ownerServers: readonly string[],
): string[] {
  return [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    `model=${toml(model)}`,
    "-c",
    'sandbox_mode="workspace-write"',
    // The owner's plugins bundle MCP servers (browser, computer use, apps) that
    // would reach the model with no ask in between. Verified against 0.154.
    ...["plugins", "apps", "computer_use", "browser_use"].flatMap((f) => ["--disable", f]),
    ...ownerServers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
    "-c",
    `mcp_servers.noctis.command=${toml(process.execPath)}`,
    "-c",
    `mcp_servers.noctis.args=${toml([mcpEntry, "--proposals", proposalsFile])}`,
  ];
}

function toolOutput(item: ThreadItem): string | undefined {
  if (item.type === "dynamicToolCall") {
    const text = (item.contentItems ?? []).map((c) => c.text ?? "").join("");

    return text === "" ? undefined : clip(text, 4000);
  }

  const payload = item.result ?? item.error;

  return payload === undefined || payload === null
    ? undefined
    : clip(JSON.stringify(payload), 4000);
}

/** ThreadItem → RuntimeItem, or nothing for the kinds Noctis does not persist. */
function toRuntimeItem(item: ThreadItem, phase: "started" | "completed"): RuntimeItem | undefined {
  if (item.id === undefined) {
    return undefined;
  }

  const base = {
    itemId: clip(item.id, 128),
    status: STATUS[item.status ?? ""] ?? (phase === "started" ? "in_progress" : "completed"),
  } as const;

  switch (item.type) {
    case "agentMessage":
      return { ...base, kind: "agent_message", text: clip(item.text ?? "", 20_000) };
    case "commandExecution": {
      const output = item.aggregatedOutput;

      return {
        ...base,
        kind: "command",
        command: clip(item.command ?? "", 4000),
        ...(item.cwd === undefined ? {} : { cwd: clip(item.cwd, 1024) }),
        ...(output === undefined || output === null ? {} : { output: clip(output, 4000) }),
        ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
      };
    }
    case "fileChange": {
      const changes = (item.changes ?? []).slice(0, 200);

      return {
        ...base,
        kind: "file_change",
        paths: changes.map((c) => clip(c.path, 1024)),
        summary: clip(changes.map((c) => `${c.kind.type} ${c.path}`).join(", "), 2000),
      };
    }
    case "mcpToolCall":
    case "dynamicToolCall": {
      const output = toolOutput(item);

      return {
        ...base,
        kind: "tool_call",
        tool: clip(String(item.tool ?? ""), 128),
        ...(item.arguments === undefined ? {} : { input: item.arguments }),
        ...(output === undefined ? {} : { output }),
      };
    }
    case "collabAgentToolCall":
      return { ...base, kind: "sub_agent", label: clip(String(item.tool ?? "collab"), 200) };
    case "subAgentActivity":
      return {
        ...base,
        kind: "sub_agent",
        label: clip(`${item.kind ?? ""} ${item.agentPath ?? ""}`.trim() || "sub-agent", 200),
      };
    default:
      // reasoning, plan, webSearch, userMessage, …: Codex's bookkeeping, not evidence.
      return undefined;
  }
}

class Cancelled extends Error {}

export function createCodexRuntime(options: CodexRuntimeOptions): Runtime {
  const spawn: CodexSpawn =
    options.spawn ??
    ((file, args, spawnOptions) =>
      spawnChild(file, [...args], {
        ...spawnOptions,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }));
  const mcpEntry = options.mcpEntry ?? fileURLToPath(new URL("../noctis-mcp.js", import.meta.url));
  const codexHome = options.codexHome ?? join(homedir(), ".codex");

  return {
    providerId: "codex",
    probe: (): Promise<RuntimeProbe> => probeCodexInstalled(options.env ?? process.env),
    turn(input: RuntimeTurnInput, sink: RuntimeSink): Promise<RuntimeTurnEvidence> {
      const { payload, roots, signal } = input;
      const command = options.command ?? resolveCodexCommand({ env: input.env });

      if (command === undefined) {
        throw new AdapterRefused("codex_not_found");
      }

      if (signal.aborted) {
        throw new AdapterRefused("job was cancelled");
      }

      const started = new Map<string, ThreadItem>();
      let itemCount = 0;
      let proposals = 0;
      let finalText: string | undefined;
      let usage: RuntimeTurnEvidence["usage"];
      let threadId: string | undefined;
      let turnId: string | undefined;
      let stderrTail = "";
      let killTimer: NodeJS.Timeout | undefined;
      let settled = false;

      function emit(item: RuntimeItem): void {
        if (item.status !== "in_progress") {
          itemCount += 1;

          if (item.kind === "agent_message") {
            finalText = item.text;
          }
        }

        sink.item(item);
      }

      const channel = createProposalChannel(options.proposalsDir, payload.userMessageId);
      const stopChannel = channel.start((proposal) => {
        proposals += 1;
        emit({
          itemId: `proposal-${String(proposals)}`,
          kind: "proposal",
          status: "completed",
          proposal,
        });
      });

      const child = spawn(
        command,
        spawnArgs(payload.model.model, mcpEntry, channel.path, ownerMcpServers(codexHome)),
        // Stripped again here: the adapter already did, and this is the boundary.
        { cwd: roots.cwd, env: childEnvironment(input.env) },
      );
      const rpc = createJsonRpcClient({ input: child.stdout, output: child.stdin });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
      });

      const sandboxPolicy = payload.objectiveActive
        ? {
            type: "workspaceWrite",
            writableRoots: roots.writable,
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          }
        : { type: "readOnly", networkAccess: false };

      /** The core's answer as a boolean; `undefined` when the ask itself failed (cancelled, disconnected). */
      async function decide(ask: Omit<RuntimeAsk, "askId">): Promise<boolean | undefined> {
        try {
          return (await sink.ask(ask)).decision === "allow";
        } catch {
          return undefined;
        }
      }

      function approval(allowed: boolean | undefined): {
        decision: "accept" | "decline" | "cancel";
      } {
        return { decision: allowed === undefined ? "cancel" : allowed ? "accept" : "decline" };
      }

      function interrupt(): void {
        if (threadId !== undefined && turnId !== undefined) {
          rpc.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
        }

        killTimer ??= setTimeout(() => child.kill(), KILL_AFTER_INTERRUPT_MS);
        killTimer.unref();
      }

      return new Promise<RuntimeTurnEvidence>((resolve, reject) => {
        function finish(
          outcome: { evidence: RuntimeTurnEvidence["stoppedReason"] } | { error: Error },
        ): void {
          if (settled) {
            return;
          }

          settled = true;
          signal.removeEventListener("abort", interrupt);

          if (killTimer !== undefined) {
            clearTimeout(killTimer);
          }

          stopChannel();
          rpc.close();

          if (child.exitCode === null) {
            child.kill();
          }

          if ("error" in outcome) {
            reject(outcome.error);
            return;
          }

          resolve({
            model: payload.model,
            ...(threadId === undefined ? {} : { sessionRef: threadId }),
            itemCount,
            ...(finalText === undefined ? {} : { finalText }),
            ...(usage === undefined ? {} : { usage }),
            stoppedReason: outcome.evidence,
          });
        }

        signal.addEventListener("abort", interrupt, { once: true });

        child.on("error", (error) => finish({ error }));
        child.on("exit", (code, exitSignal) => {
          if (signal.aborted) {
            finish({ evidence: "cancelled" });
            return;
          }

          finish({
            error: new Error(
              `codex app-server exited (${String(code ?? exitSignal)}) before the turn completed: ${stderrTail.trim()}`,
            ),
          });
        });

        rpc.onNotification((method, params) => {
          switch (method) {
            case "item/started": {
              const { item } = ItemNotificationSchema.parse(params);

              if (item.id !== undefined) {
                started.set(item.id, item);
              }

              const mapped = toRuntimeItem(item, "started");

              if (mapped !== undefined) {
                emit(mapped);
              }

              return;
            }
            case "item/completed": {
              const mapped = toRuntimeItem(ItemNotificationSchema.parse(params).item, "completed");

              if (mapped !== undefined) {
                emit(mapped);
              }

              return;
            }
            case "item/agentMessage/delta": {
              const { itemId, delta } = DeltaNotificationSchema.parse(params);

              if (delta !== "") {
                sink.delta(clip(itemId, 128), clip(delta, 2000));
              }

              return;
            }
            case "thread/tokenUsage/updated": {
              const { total } = TokenUsageSchema.parse(params).tokenUsage;

              usage = { inputTokens: total.inputTokens, outputTokens: total.outputTokens };
              return;
            }
            case "turn/completed": {
              const { turn } = TurnCompletedSchema.parse(params);

              finish({ evidence: STOPPED[turn.status] ?? "failed" });
              return;
            }
            default:
              return;
          }
        });

        rpc.onRequest(async (method, params) => {
          switch (method) {
            case "item/commandExecution/requestApproval": {
              const p = CommandApprovalSchema.parse(params);
              const prior = started.get(p.itemId);
              const command = p.command ?? prior?.command ?? "";
              const cwd = p.cwd ?? prior?.cwd ?? roots.cwd;
              const cls = classifyAsk({
                kind: "command",
                command,
                cwd,
                writableRoots: roots.writable,
                readableRoots: roots.readable,
              });

              return approval(
                await decide({
                  itemId: clip(p.itemId, 128),
                  kind: "command",
                  summary: clip(command, 2000).trim() || "run a command",
                  operationClass: cls.operationClass,
                  reversibility: cls.reversibility,
                  capability: cls.capability,
                  target: { type: "command", id: clip(command, 200).trim() || "command" },
                  detail: { command: clip(command, 4000), cwd: clip(cwd, 1024) },
                }),
              );
            }
            case "item/fileChange/requestApproval": {
              const p = ItemIdSchema.parse(params);
              const paths = (started.get(p.itemId)?.changes ?? [])
                .slice(0, 200)
                .map((c) => clip(c.path, 1024));
              const cls = classifyAsk({
                kind: "file_change",
                paths,
                writableRoots: roots.writable,
                readableRoots: roots.readable,
              });

              return approval(
                await decide({
                  itemId: clip(p.itemId, 128),
                  kind: "file_change",
                  summary: clip(
                    `edit ${String(paths.length)} file${paths.length === 1 ? "" : "s"}: ${paths.join(", ")}`,
                    2000,
                  ),
                  operationClass: cls.operationClass,
                  reversibility: cls.reversibility,
                  capability: cls.capability,
                  target: { type: "file_change", id: clip(paths[0] ?? p.itemId, 200) },
                  detail: { paths },
                }),
              );
            }
            case "item/permissions/requestApproval": {
              const p = PermissionsApprovalSchema.parse(params);
              const cls = classifyAsk({
                kind: "permission",
                writableRoots: roots.writable,
                readableRoots: roots.readable,
              });
              const requested = Object.entries(p.permissions).filter(([, v]) => v !== null);
              const allowed = await decide({
                itemId: clip(p.itemId, 128),
                kind: "permission",
                summary:
                  clip(p.reason ?? `grant ${requested.map(([k]) => k).join(", ")}`, 2000).trim() ||
                  "grant permissions",
                operationClass: cls.operationClass,
                reversibility: cls.reversibility,
                capability: cls.capability,
                target: { type: "permission", id: requested.map(([k]) => k).join(",") || "none" },
                ...(p.cwd === undefined ? {} : { detail: { cwd: clip(p.cwd, 1024) } }),
              });

              // GrantedPermissionProfile: the requested profile minus its nulls, for this turn only.
              return {
                permissions: allowed === true ? Object.fromEntries(requested) : {},
                scope: "turn",
              };
            }
            case "item/tool/requestUserInput": {
              const p = ItemIdSchema.parse(params);

              emit({
                itemId: clip(p.itemId, 128),
                kind: "agent_message",
                status: "completed",
                text: NO_INPUT_TEXT,
              });

              return { answers: {} };
            }
            case "mcpServer/elicitation/request":
              emit({
                itemId: "elicitation",
                kind: "agent_message",
                status: "completed",
                text: NO_INPUT_TEXT,
              });

              return { action: "decline", content: null, _meta: null };
            default:
              throw new JsonRpcError(METHOD_NOT_FOUND, `noctis does not handle ${method}`);
          }
        });

        const drive = async (): Promise<void> => {
          await rpc.request("initialize", {
            clientInfo: { name: "noctis-node-agent", title: null, version: AGENT_VERSION },
            capabilities: null,
          });

          // `approval_policy` is refused as a config key by 0.154; the per-request field still takes it.
          const thread = {
            cwd: roots.cwd,
            model: payload.model.model,
            approvalPolicy: "untrusted",
            sandbox: payload.objectiveActive ? "workspace-write" : "read-only",
          };

          if (payload.sessionRef !== undefined) {
            try {
              threadId = ThreadResponseSchema.parse(
                await rpc.request("thread/resume", { threadId: payload.sessionRef, ...thread }),
              ).thread.id;
            } catch {
              emit({
                itemId: "resume-failed",
                kind: "agent_message",
                status: "completed",
                text: `Codex could not resume thread ${payload.sessionRef}; started a new one.`,
              });
            }
          }

          threadId ??= ThreadResponseSchema.parse(await rpc.request("thread/start", thread)).thread
            .id;

          if (signal.aborted) {
            throw new Cancelled();
          }

          turnId = TurnResponseSchema.parse(
            await rpc.request("turn/start", {
              threadId,
              input: [{ type: "text", text: payload.prompt, text_elements: [] }],
              sandboxPolicy,
            }),
          ).turn.id;

          if (signal.aborted) {
            // The abort raced the start; now that the turn has an id it can be interrupted.
            interrupt();
          }
        };

        drive().catch((error: unknown) => {
          if (error instanceof Cancelled || signal.aborted) {
            finish({ evidence: "cancelled" });
            return;
          }

          finish({ error: error instanceof Error ? error : new Error("codex turn failed") });
        });
      });
    },
  };
}
