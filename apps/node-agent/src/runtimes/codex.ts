import { spawn as spawnChild } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import type {
  ExternalSession,
  RuntimeAsk,
  RuntimeItem,
  RuntimeItemStatus,
  RuntimeProbe,
  RuntimeTurnEvidence,
  SessionExchange,
} from "@noctis/contracts";
import { MAX_HISTORY_EXCHANGES, MAX_LISTED_SESSIONS } from "@noctis/contracts";
import { classifyAsk } from "@noctis/domain";
import { z } from "zod";

import { AGENT_VERSION } from "../agent.js";
import type { ProposalChannel } from "../proposals-file.js";
import { createProposalChannel } from "../proposals-file.js";
import type { Runtime, RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { AdapterRefused, ApprovalTimedOut } from "./Runtime.js";
import { resolveCodexCommand } from "./codex-command.js";
import { installCodexRules } from "./codex-rules.js";
import { childEnvironment } from "./env.js";
import { identityCard, ownerClockBlock, isOwnerClockBlock } from "./identity.js";
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
  /** Where Codex reads the owner's config and rules; `CODEX_HOME`, else `~/.codex`. */
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  /** How long a thread's app-server waits for its next message before it is closed. */
  idleMs?: number;
  /** The largest single message read from the app-server. Tests lower it. */
  maxMessageBytes?: number;
}

const KILL_AFTER_INTERRUPT_MS = 5_000;
/**
 * A generated image arrives inside one notification as base64, so a message
 * has to fit the largest output the core will store (10 MB, a third more as
 * base64) with room to spare.
 */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
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
    savedPath: z.string().nullable().optional(),
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
const ThreadListResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string(),
          name: z.string().nullish(),
          preview: z.string().nullish(),
          /** Seconds. */
          updatedAt: z.number(),
          source: z.unknown().optional(),
        })
        .loose(),
    ),
  })
  .loose();

const ThreadReadResponseSchema = z
  .object({ thread: z.object({ cwd: z.string().nullish() }).loose() })
  .loose();
const TurnsListResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          items: z.array(
            z
              .object({
                type: z.string(),
                text: z.string().optional(),
                content: z
                  .array(z.object({ type: z.string(), text: z.string().optional() }).loose())
                  .optional(),
              })
              .loose(),
          ),
        })
        .loose(),
    ),
  })
  .loose();

/** How long a listing may take before the folder is reported as having no Codex threads. */
const LIST_TIMEOUT_MS = 15_000;

/**
 * The spellings of a Windows path a Codex client may have recorded. The
 * `thread/list` filter is an exact match, and VS Code writes the drive letter
 * in lower case where Noctis's `realpath` writes it in upper.
 */
function cwdSpellings(cwd: string): string[] {
  return /^[A-Za-z]:/.test(cwd)
    ? [...new Set([cwd[0]?.toUpperCase() + cwd.slice(1), cwd[0]?.toLowerCase() + cwd.slice(1)])]
    : [cwd];
}
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

const IMAGE_SIGNATURES: ReadonlyArray<readonly [string, string, number[]]> = [
  ["image/png", "png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", "jpg", [0xff, 0xd8, 0xff]],
  ["image/webp", "webp", [0x52, 0x49, 0x46, 0x46]],
];

/**
 * The bytes of a generated image, from the item's base64 `result`, and what
 * they are. Judged by the bytes, not by the file name Codex chose, because the
 * type is what the page will be told to render them as.
 */
export function generatedImage(
  item: ThreadItem,
): { bytes: Uint8Array; mediaType: string; extension: string } | undefined {
  if (typeof item.result !== "string" || item.result === "") {
    return undefined;
  }

  const bytes = new Uint8Array(Buffer.from(item.result.replace(/^data:[^,]*,/, ""), "base64"));
  const match = IMAGE_SIGNATURES.find(([, , magic]) =>
    magic.every((byte, index) => bytes[index] === byte),
  );

  return match === undefined ? undefined : { bytes, mediaType: match[0], extension: match[1] };
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
  const codexHome =
    options.codexHome ??
    ((options.env ?? process.env).CODEX_HOME?.trim() || join(homedir(), ".codex"));

  /** One app-server for one thread. The JSON-RPC handshake waits for its first turn. */
  function open(input: RuntimeTurnInput, key: string, command: string): CodexProcess {
    const { payload, roots } = input;
    // Named for the thread, because the MCP child it is handed lives as long as this process.
    const proposals = createProposalChannel(options.proposalsDir, payload.threadId);

    // Before the spawn: Codex reads its rules when it starts.
    installCodexRules(codexHome);
    const child = spawn(
      command,
      spawnArgs(payload.model.model, mcpEntry, proposals.path),
      // Stripped again here: the adapter already did, and this is the boundary.
      { cwd: roots.cwd, env: childEnvironment(input.env) },
    );
    const rpc = createJsonRpcClient(
      { input: child.stdout, output: child.stdin },
      {
        maxLineBytes: options.maxMessageBytes ?? MAX_MESSAGE_BYTES,
        // Once nothing more can be read, nothing can finish the turn either.
        // A close Noctis started itself already said why.
        onClose: (reason) => {
          if (alive) {
            end(new Error(`codex app-server could not be read: ${reason}`));
          }
        },
      },
    );
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

    // The turn hears the reason first: closing kills the child, and its exit
    // would otherwise arrive as a second, less useful one.
    function end(error: Error): void {
      proc.current?.ended(error);
      proc.close();
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
    /** Generated images still on their way to the core. The turn ends after them. */
    const uploads: Array<Promise<void>> = [];

    /**
     * A generated image becomes an output the owner can open anywhere. A failed
     * upload still records where the file is on this machine.
     */
    async function imageOutput(item: ThreadItem): Promise<void> {
      const itemId = clip(item.id ?? "image", 128);
      const path = typeof item.savedPath === "string" ? clip(item.savedPath, 1024) : undefined;
      const image = generatedImage(item);
      let attachmentId: string | undefined;

      if (image !== undefined) {
        try {
          attachmentId = await sink.upload({
            filename: `${itemId.replace(/[^\w-]/g, "_")}.${image.extension}`,
            mediaType: image.mediaType,
            bytes: image.bytes,
          });
        } catch {
          attachmentId = undefined;
        }
      }

      emit({
        itemId,
        kind: "output",
        status: "completed",
        mediaType: image?.mediaType ?? "application/octet-stream",
        ...(path === undefined ? {} : { path }),
        ...(attachmentId === undefined ? {} : { attachmentId }),
      });
    }

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

        // The result is what tells the core the turn is over, so every output
        // item has to have reached it first.
        void Promise.allSettled(uploads).then(() => {
          resolve({
            model: payload.model,
            ...(proc.threadId === undefined ? {} : { sessionRef: proc.threadId }),
            itemCount,
            ...(finalText === undefined ? {} : { finalText }),
            ...(usage === undefined ? {} : { usage }),
            stoppedReason: outcome.evidence,
          });
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
              const { item } = ItemNotificationSchema.parse(params);

              if (item.type === "imageGeneration" && item.status !== "failed") {
                uploads.push(imageOutput(item));
                return;
              }

              const mapped = toRuntimeItem(item, "completed");

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
          const card = identityCard({
            identityId: payload.identityId,
            runtime: "codex",
            model: payload.model.model,
            env: input.env,
            readable: roots.readable,
            timeZone: payload.ownerTimeZone,
          });
          // developerInstructions adds to Codex's own prompt; baseInstructions would replace it.
          const thread = {
            cwd: roots.cwd,
            model: payload.model.model,
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            ...(card === undefined ? {} : { developerInstructions: card }),
          };

          if (payload.sessionRef !== undefined) {
            // A thread started outside Noctis is continued in a fork, so a
            // VS Code window that still has it open is never written under.
            const method = payload.forkSession === true ? "thread/fork" : "thread/resume";

            try {
              proc.threadId = ThreadResponseSchema.parse(
                await rpc.request(method, { threadId: payload.sessionRef, ...thread }),
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
            input: [
              { type: "text", text: payload.prompt, text_elements: [] },
              { type: "text", text: ownerClockBlock(payload.ownerTimeZone), text_elements: [] },
            ],
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

  /**
   * One question for an app-server started for it and stopped after: no
   * model, no sandbox, no Noctis MCP server, because it runs no turn.
   * Undefined when Codex is not installed.
   */
  async function askAppServer<T>(
    cwd: string,
    env: NodeJS.ProcessEnv,
    what: string,
    question: (rpc: JsonRpcClient) => Promise<T>,
  ): Promise<T | undefined> {
    const command = options.command ?? resolveCodexCommand({ env });

    if (command === undefined) {
      return undefined;
    }

    const child = spawn(command, ["app-server", "--listen", "stdio://"], {
      cwd,
      env: childEnvironment(env),
    });
    const rpc = createJsonRpcClient({ input: child.stdout, output: child.stdin });
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        (async () => {
          await rpc.request("initialize", {
            clientInfo: { name: "noctis-node-agent", title: null, version: AGENT_VERSION },
            capabilities: null,
          });

          return question(rpc);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`codex ${what} timed out`)), LIST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      rpc.close();

      if (child.exitCode === null) {
        child.kill();
      }
    }
  }

  /**
   * The folder's Codex threads. Codex's default source filter already leaves
   * out the threads Noctis made through its own app-server.
   */
  async function listSessions(cwd: string, env: NodeJS.ProcessEnv): Promise<ExternalSession[]> {
    const listed = await askAppServer(cwd, env, "thread/list", async (rpc) =>
      ThreadListResponseSchema.parse(
        await rpc.request("thread/list", {
          cwd: cwdSpellings(cwd),
          limit: MAX_LISTED_SESSIONS,
          // The default, created_at, drops an old thread touched today.
          sortKey: "updated_at",
        }),
      ),
    );

    return (listed?.data ?? []).map((thread) => ({
      providerId: "codex" as const,
      sessionRef: clip(thread.id, 200),
      title: clip(thread.name ?? thread.preview ?? "Untitled Codex thread", 200),
      lastActiveAt: new Date(thread.updatedAt * 1000).toISOString(),
      ...(typeof thread.source === "string" ? { source: clip(thread.source, 64) } : {}),
    }));
  }

  /**
   * A thread's last turns, each as its prompt and the reply it ended on: the
   * `summary` view, read from the rollout without loading the thread. The
   * app-server reads any thread id it is given, so the thread's own folder is
   * checked first.
   */
  async function readHistory(
    cwd: string,
    sessionRef: string,
    env: NodeJS.ProcessEnv,
  ): Promise<SessionExchange[]> {
    const turns = await askAppServer(cwd, env, "thread/turns/list", async (rpc) => {
      const { thread } = ThreadReadResponseSchema.parse(
        await rpc.request("thread/read", { threadId: sessionRef }),
      );

      if (!cwdSpellings(cwd).includes(thread.cwd ?? "")) {
        throw new AdapterRefused("that Codex thread is not kept for this folder");
      }

      return TurnsListResponseSchema.parse(
        await rpc.request("thread/turns/list", {
          threadId: sessionRef,
          limit: MAX_HISTORY_EXCHANGES,
          itemsView: "summary",
        }),
      ).data;
    });

    // Newest first from the app-server; the page reads oldest first.
    return [...(turns ?? [])].reverse().map((turn) => ({
      prompt: turn.items
        .filter((item) => item.type === "userMessage")
        .flatMap((item) => item.content ?? [])
        .map((input) => input.text ?? "")
        .filter((text) => !isOwnerClockBlock(text))
        .join("\n\n")
        .trim(),
      reply: turn.items.filter((item) => item.type === "agentMessage").at(-1)?.text ?? "",
    }));
  }

  return {
    providerId: "codex",
    probe: (): Promise<RuntimeProbe> => probeCodexInstalled(options.env ?? process.env),
    listSessions,
    readHistory,
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
