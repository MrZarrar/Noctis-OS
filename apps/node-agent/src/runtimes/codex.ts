import { spawn as spawnChild } from "node:child_process";
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
import type { ProposalChannel } from "../proposals-file.js";
import { createProposalChannel } from "../proposals-file.js";
import type { Runtime, RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { AdapterRefused, ApprovalTimedOut } from "./Runtime.js";
import { resolveCodexCommand } from "./codex-command.js";
import { childEnvironment } from "./env.js";
import type { JsonRpcClient } from "./jsonrpc.js";
import { JsonRpcError, METHOD_NOT_FOUND, createJsonRpcClient } from "./jsonrpc.js";
import { probeCodexInstalled } from "./probe.js";
import type { LiveProcess } from "./sessions.js";
import { createProcessPool, processKey } from "./sessions.js";

/**
 * Codex App Server behind the node boundary (ADR-0020/0021).
 *
 * One `codex app-server` process per thread, kept open between turns and
 * spoken to over stdio JSON-RPC; a follow-up is one `turn/start`. It runs on
 * the owner's own ~/.codex (plugins, skills, MCP servers) with three things
 * pinned: the model Noctis chose, `workspace-write` on the granted roots with
 * the network off, and approval `on-request`. Codex's own permission system
 * does the everyday work; anything it asks becomes a `sink.ask` the owner
 * answers, classified by `classifyAsk` so the card says what it is.
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
  /** One proposals file per thread lands here. */
  proposalsDir: string;
  /** `dist/noctis-mcp.js`; the sibling of this file's parent in the build. */
  mcpEntry?: string;
  env?: NodeJS.ProcessEnv;
  /** How long a thread's app-server waits for its next message before it is closed. */
  idleMs?: number;
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

function spawnArgs(model: string, mcpEntry: string, proposalsFile: string): string[] {
  return [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    `model=${toml(model)}`,
    "-c",
    'sandbox_mode="workspace-write"',
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
        // A tool name that is not a string is not a tool name. Codex's shapes
        // are loose here, and `String()` would turn an object into the literal
        // text "[object Object]" and call it a tool.
        tool: clip(typeof item.tool === "string" ? item.tool : "", 128),
        ...(item.arguments === undefined ? {} : { input: item.arguments }),
        ...(output === undefined ? {} : { output }),
      };
    }
    case "collabAgentToolCall":
      return {
        ...base,
        kind: "sub_agent",
        label: clip(typeof item.tool === "string" ? item.tool : "collab", 200),
      };
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

/** The turn a live app-server is currently running. Everything it says goes to it. */
interface CodexTurn {
  notify(method: string, params: unknown): void;
  request(method: string, params: unknown): Promise<unknown>;
  /** The process ended under the turn. */
  ended(error: Error): void;
}

interface CodexProcess extends LiveProcess {
  rpc: JsonRpcClient;
  proposals: ProposalChannel;
  /** Codex's thread, once `thread/start` or `thread/resume` has answered. */
  threadId: string | undefined;
  current: CodexTurn | undefined;
  /** Kills the process if the current turn does not stop on its own after an interrupt. */
  killSoon(): void;
}

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
  const pool = createProcessPool<CodexProcess>(options.idleMs);

  /** One app-server for one thread. The JSON-RPC handshake waits for its first turn. */
  function open(input: RuntimeTurnInput, key: string, command: string): CodexProcess {
    const { payload, roots } = input;
    // Named for the thread, because the MCP child it is handed lives as long as this process.
    const proposals = createProposalChannel(options.proposalsDir, payload.threadId);
    const child = spawn(
      command,
      spawnArgs(payload.model.model, mcpEntry, proposals.path),
      // Stripped again here: the adapter already did, and this is the boundary.
      { cwd: roots.cwd, env: childEnvironment(input.env) },
    );
    const rpc = createJsonRpcClient({ input: child.stdout, output: child.stdin });
    let alive = true;
    let stderrTail = "";
    let killTimer: NodeJS.Timeout | undefined;

    const proc: CodexProcess = {
      key,
      sessionRef: undefined,
      threadId: undefined,
      current: undefined,
      rpc,
      proposals,
      get alive() {
        return alive;
      },
      killSoon() {
        killTimer ??= setTimeout(() => proc.close(), KILL_AFTER_INTERRUPT_MS);
        killTimer.unref();
      },
      close() {
        if (alive) {
          alive = false;
          clearTimeout(killTimer);
          rpc.close();

          if (child.exitCode === null) {
            child.kill();
          }
        }
      },
    };

    function end(error: Error): void {
      proc.close();
      proc.current?.ended(error);
    }

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error) => end(error));
    child.on("exit", (code, exitSignal) =>
      end(
        new Error(
          `codex app-server exited (${String(code ?? exitSignal)}) before the turn completed: ${stderrTail.trim()}`,
        ),
      ),
    );
    rpc.onNotification((method, params) => proc.current?.notify(method, params));
    rpc.onRequest((method, params) =>
      proc.current === undefined
        ? Promise.reject(new JsonRpcError(METHOD_NOT_FOUND, `no Noctis turn is running`))
        : proc.current.request(method, params),
    );

    return proc;
  }

  /** One `turn/start` on a live app-server, settled by its `turn/completed`. */
  function run(
    proc: CodexProcess,
    input: RuntimeTurnInput,
    sink: RuntimeSink,
  ): Promise<RuntimeTurnEvidence> {
    const { payload, roots, signal } = input;
    const { rpc } = proc;
    const started = new Map<string, ThreadItem>();
    let itemCount = 0;
    let proposals = 0;
    let finalText: string | undefined;
    let usage: RuntimeTurnEvidence["usage"];
    let turnId: string | undefined;
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

    const stopChannel = proc.proposals.start((proposal) => {
      proposals += 1;
      emit({
        itemId: `proposal-${String(proposals)}`,
        kind: "proposal",
        status: "completed",
        proposal,
      });
    });

    // The network stays off whatever ~/.codex says: an external write then has
    // to escalate, and an escalation is an ask the owner answers.
    const sandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: roots.writable,
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
    let fail: (error: Error) => void = () => undefined;

    /**
     * The owner's answer to Codex's own ask, as a boolean; `undefined` when the
     * ask itself failed (cancelled, disconnected, or nobody answered in time).
     */
    async function decide(ask: Omit<RuntimeAsk, "askId">): Promise<boolean | undefined> {
      try {
        return (await sink.ask({ ...ask, askedBy: "runtime" })).decision === "allow";
      } catch (error) {
        if (error instanceof ApprovalTimedOut) {
          fail(error);
        }

        return undefined;
      }
    }

    function approval(allowed: boolean | undefined): {
      decision: "accept" | "decline" | "cancel";
    } {
      return { decision: allowed === undefined ? "cancel" : allowed ? "accept" : "decline" };
    }

    function interrupt(): void {
      if (proc.threadId !== undefined && turnId !== undefined) {
        rpc.request("turn/interrupt", { threadId: proc.threadId, turnId }).catch(() => undefined);
      }

      proc.killSoon();
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
        stopChannel();

        if (proc.current === turn) {
          proc.current = undefined;
        }

        if ("error" in outcome) {
          // Whatever went wrong may have left the process mid-turn; the next turn starts clean.
          proc.close();
          reject(outcome.error);
          return;
        }

        resolve({
          model: payload.model,
          ...(proc.threadId === undefined ? {} : { sessionRef: proc.threadId }),
          itemCount,
          ...(finalText === undefined ? {} : { finalText }),
          ...(usage === undefined ? {} : { usage }),
          stoppedReason: outcome.evidence,
        });
      }

      fail = (error) => finish({ error });

      const turn: CodexTurn = {
        ended(error) {
          finish(signal.aborted ? { evidence: "cancelled" } : { error });
        },

        notify(method, params) {
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
              const { turn: completed } = TurnCompletedSchema.parse(params);

              finish({ evidence: STOPPED[completed.status] ?? "failed" });
              return;
            }
            default:
              return;
          }
        },

        async request(method, params) {
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
        },
      };

      proc.current = turn;
      signal.addEventListener("abort", interrupt, { once: true });

      if (!proc.alive) {
        turn.ended(new Error("codex app-server ended before the turn started"));
        return;
      }

      const drive = async (): Promise<void> => {
        // A process that has answered a turn already has its thread; only a new one shakes hands.
        if (proc.threadId === undefined) {
          await rpc.request("initialize", {
            clientInfo: { name: "noctis-node-agent", title: null, version: AGENT_VERSION },
            capabilities: null,
          });

          // `approval_policy` is refused as a config key by 0.154; the per-request field still takes it.
          const thread = {
            cwd: roots.cwd,
            model: payload.model.model,
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
          };

          if (payload.sessionRef !== undefined) {
            try {
              proc.threadId = ThreadResponseSchema.parse(
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

          proc.threadId ??= ThreadResponseSchema.parse(
            await rpc.request("thread/start", thread),
          ).thread.id;
          proc.sessionRef = proc.threadId;
        }

        if (signal.aborted) {
          throw new Cancelled();
        }

        turnId = TurnResponseSchema.parse(
          await rpc.request("turn/start", {
            threadId: proc.threadId,
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
  }

  return {
    providerId: "codex",
    probe: (): Promise<RuntimeProbe> => probeCodexInstalled(options.env ?? process.env),
    turn(input: RuntimeTurnInput, sink: RuntimeSink): Promise<RuntimeTurnEvidence> {
      const { payload, roots, signal } = input;
      const command = options.command ?? resolveCodexCommand({ env: input.env });

      if (command === undefined) {
        return Promise.reject(new AdapterRefused("codex_not_found"));
      }

      if (signal.aborted) {
        return Promise.reject(new AdapterRefused("job was cancelled"));
      }

      const key = processKey(payload, roots);

      return pool.run(
        payload.threadId,
        { key, sessionRef: payload.sessionRef },
        () => open(input, key, command),
        (proc) => run(proc, input, sink),
      );
    },
    close: () => pool.closeAll(),
  };
}
