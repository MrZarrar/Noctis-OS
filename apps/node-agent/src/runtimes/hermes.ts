import { spawn as spawnChild } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeAsk, RuntimeItem, RuntimeProbe, RuntimeTurnEvidence } from "@noctis/contracts";
import { classifyAsk, isConfirmLevel } from "@noctis/domain";
import { z } from "zod";

import type { Runtime, RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { AdapterRefused, ApprovalTimedOut } from "./Runtime.js";
import type { ProposalChannel } from "../proposals-file.js";
import { createProposalChannel } from "../proposals-file.js";
import type { CodexSpawn } from "./codex.js";
import { childEnvironment } from "./env.js";
import {
  ACTING_INSTRUCTIONS,
  WRITING_INSTRUCTIONS,
  identityCard,
  mindVaultNote,
  ownerTimeContext,
  ownerClockBlock,
  PRODUCTIVITY_INSTRUCTIONS,
} from "./identity.js";
import type { ModelHost } from "./lmstudio.js";
import { ensureModel } from "./local.js";
import type { StdioServer } from "./mcp-config.js";
import {
  BROWSER_SERVER,
  DESKTOP_SERVER,
  browserServer,
  desktopServer,
  refusedTool,
} from "./mcp-config.js";
import type { JsonRpcClient } from "./jsonrpc.js";
import { JsonRpcError, METHOD_NOT_FOUND, createJsonRpcClient } from "./jsonrpc.js";
import type { LiveProcess } from "./sessions.js";
import { createProcessPool, processKey } from "./sessions.js";
import { trackChild } from "./orphans.js";
import { killProcessTree } from "./kill-tree.js";

/**
 * Hermes Agent behind the node boundary (ADR-0030, v1 S3), over the Agent
 * Client Protocol: `hermes-acp` on stdio, one process per thread, kept open
 * between turns like Codex's app-server. A thread's Hermes session is its
 * session ref; a cold turn resumes it with `session/load`.
 *
 * Hermes runs on a home Noctis owns, never the owner's own: the model server
 * on this PC is its only provider, its approvals stay on (`manual`), and
 * pushing and publishing are refused outright by `approvals.deny`, because
 * Hermes has no sandbox. Whatever Hermes asks about comes to the owner as an
 * ask. It thinks on the local model, so its turns are costed as local.
 * Inside that home Hermes is left whole: it remembers, searches its past
 * sessions and learns skills as it normally does. Only its scheduler is off.
 */

export interface HermesRuntimeOptions {
  /** `hermes-acp.exe`; resolved from the machine when absent. */
  command?: string | undefined;
  spawn?: CodexSpawn;
  /** Noctis's own Hermes home: its config, sessions and state. */
  hermesHome: string;
  /** One proposals file per thread lands here, for the Noctis MCP tools (ADR-0030). */
  proposalsDir: string;
  /** `dist/noctis-mcp.js`; the sibling of this file's parent in the build. */
  mcpEntry?: string;
  /** The local model server's probe: Hermes thinks with what it serves. */
  localProbe: () => Promise<RuntimeProbe>;
  /** LM Studio's CLI, when the node drives it: the model is loaded for the turn, not kept loaded. */
  host?: ModelHost | undefined;
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
}

/** What Hermes needs to plan with tools: below this it refuses to start. */
const HERMES_CONTEXT = 65_536;
/** A turn is the agent working, so it may take a long while; cancel is how it ends early. */
const TURN_TIMEOUT_MS = 2 * 60 * 60_000;
const KILL_AFTER_CANCEL_MS = 5_000;
/** Refused by Hermes whatever anyone answers: these leave the PC and cannot be called back. */
const DENIED = ["*git push*", "*npm publish*", "*pnpm publish*", "*yarn publish*", "*gh release*"];
/** Who Jester is: Hermes's SOUL.md on Jester's home. */
const jesterSoul = (
  readable: readonly string[],
): string => `You are Jester, one of the two identities in Noctis, running on the owner's own PC on a local model. Vesper is the calm one; you are the contrarian.

Your job is to make the owner's ideas better by attacking them. Find the premise doing the most work and test it. Name the part they are pretending will solve itself. Ask the one uncomfortable question that matters. Be specific, brief and a little irreverent: wit, never contempt. You are on the owner's side. When an idea survives, say so plainly and propose the cheapest real test of it.

You also do things. When the owner asks for something done rather than argued with, do it, in your own voice. ${ACTING_INSTRUCTIONS} You run on this PC alone: for another of the owner's PCs, or a long task beyond a local model, say Vesper should take it. Noctis asks the owner before anything consequential, and a refusal is final.

${WRITING_INSTRUCTIONS}

${mindVaultNote(readable)}
`;
/** Hermes's own scheduler stays off until scheduling runs through Noctis, where the owner can see and stop it. */
const NO_SCHEDULER = ["cronjob"];

/**
 * Hermes runs a tool on a server the client lends without asking anyone: only servers in its own
 * config can be marked untrusted. This plugin makes it ask first, through the same approval it
 * uses for risky commands, before every step on the owner's screen. The step's input goes as the
 * reason, so Noctis can judge the step by what it presses.
 */
const SCREEN_PLUGIN = "noctis-screen";
const SCREEN_PLUGIN_MANIFEST = `name: ${SCREEN_PLUGIN}
version: "1.0.0"
description: "Noctis decides every step on the owner's browser and desktop."
provides_hooks:
  - pre_tool_call
`;
const SCREEN_PLUGIN_CODE = `import json

SCREEN = ("mcp__${BROWSER_SERVER}__", "mcp__${DESKTOP_SERVER}__")


def _ask(tool_name, args, **_):
    if str(tool_name).startswith(SCREEN):
        return {"action": "approve", "message": json.dumps(args, ensure_ascii=False, default=str)}
    return None


def register(ctx):
    ctx.register_hook("pre_tool_call", _ask)
`;
/** How a step the plugin escalated reaches Noctis: the tool's name, as Hermes's approval words it. */
const SCREEN_STEP = new RegExp(
  `^<(mcp__(?:${BROWSER_SERVER}|${DESKTOP_SERVER})__\\w+)> \\(plugin approval rule\\)$`,
);

/** `hermes-acp.exe` where Hermes's own installer puts it, unless the operator names one. */
export function resolveHermesCommand(env: NodeJS.ProcessEnv): string | undefined {
  const named = env.NOCTIS_HERMES_PATH?.trim();
  const installed =
    env.LOCALAPPDATA === undefined
      ? undefined
      : join(env.LOCALAPPDATA, "hermes", "bin", "hermes-acp.exe");

  if (named !== undefined && named !== "") {
    return named;
  }

  return installed !== undefined && existsSync(installed) ? installed : undefined;
}

/** The config Noctis writes for its Hermes home before each process starts. */
function hermesConfig(model: string): string {
  return [
    "model:",
    `  default: ${JSON.stringify(model)}`,
    '  provider: "lmstudio"',
    `  context_length: ${String(HERMES_CONTEXT)}`,
    "approvals:",
    "  mode: manual",
    // As long as Noctis waits for the owner; Hermes denies by itself after it.
    "  timeout: 600",
    "  deny:",
    ...DENIED.map((pattern) => `    - ${JSON.stringify(pattern)}`),
    // Hermes keeps what it learns, in this home's own MEMORY.md and USER.md, so
    // Vesper and Jester each remember separately. These are its own defaults,
    // written out so a change upstream cannot quietly move them.
    "memory:",
    "  memory_enabled: true",
    "  user_profile_enabled: true",
    "  memory_char_limit: 2200",
    "  user_char_limit: 1375",
    "  nudge_interval: 10",
    "auxiliary:",
    "  background_review:",
    "    enabled: true",
    "skills:",
    "  creation_nudge_interval: 10",
    "agent:",
    "  disabled_toolsets:",
    ...NO_SCHEDULER.map((toolset) => `    - ${JSON.stringify(toolset)}`),
    "plugins:",
    "  enabled:",
    `    - ${JSON.stringify(SCREEN_PLUGIN)}`,
    "",
  ].join("\n");
}

const UpdateSchema = z
  .object({
    sessionId: z.string(),
    update: z
      .object({
        sessionUpdate: z.string(),
        messageId: z.string().optional(),
        content: z.unknown().optional(),
        toolCallId: z.string().optional(),
        title: z.string().optional(),
        kind: z.string().optional(),
        status: z.string().optional(),
        rawInput: z.object({ command: z.string().optional() }).loose().nullish(),
      })
      .loose(),
  })
  .loose();
const PermissionSchema = z
  .object({
    sessionId: z.string(),
    toolCall: z
      .object({
        toolCallId: z.string(),
        title: z.string().nullish(),
        kind: z.string().nullish(),
        locations: z.array(z.object({ path: z.string() }).loose()).nullish(),
        rawInput: z
          .object({ command: z.string().optional(), description: z.string().optional() })
          .loose()
          .nullish(),
      })
      .loose(),
    options: z.array(z.object({ optionId: z.string(), kind: z.string() }).loose()),
  })
  .loose();
const PromptResultSchema = z
  .object({
    stopReason: z.string(),
    usage: z
      .object({ inputTokens: z.number().int(), outputTokens: z.number().int() })
      .loose()
      .nullish(),
  })
  .loose();
const NewSessionSchema = z.object({ sessionId: z.string().min(1) }).loose();
const TextSchema = z.object({ type: z.literal("text"), text: z.string() }).loose();

const STOPPED: Readonly<Record<string, RuntimeTurnEvidence["stoppedReason"]>> = {
  end_turn: "completed",
  cancelled: "cancelled",
};

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** A lent server in ACP's shape, where env is a list of names and values. */
function acpServer(name: string, server: StdioServer) {
  return {
    name,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value })),
  };
}

function parseJson(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** The text in an ACP content value: one block, or a tool's list of content entries. */
function textOf(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((entry) => textOf((entry as { content?: unknown } | null)?.content ?? entry))
      .join("");
  }

  const block = TextSchema.safeParse(content);

  return block.success ? block.data.text : "";
}

/** The turn a live Hermes process is running. Everything it says goes to it. */
interface HermesTurn {
  update(params: unknown): void;
  permission(params: unknown): Promise<unknown>;
}

interface HermesProcess extends LiveProcess {
  rpc: JsonRpcClient;
  /** Set while `session/load` replays history, which is no turn's to report. */
  loading: boolean;
  current: HermesTurn | undefined;
  proposals: ProposalChannel;
  killSoon(): void;
}

export function createHermesRuntime(options: HermesRuntimeOptions): Runtime {
  const spawn: CodexSpawn =
    options.spawn ??
    ((file, args, spawnOptions) =>
      spawnChild(file, [...args], {
        ...spawnOptions,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      }));
  const mcpEntry = options.mcpEntry ?? fileURLToPath(new URL("../noctis-mcp.js", import.meta.url));
  const pool = createProcessPool<HermesProcess>(options.idleMs);

  function open(input: RuntimeTurnInput, key: string, command: string): HermesProcess {
    // ponytail: one config per home, so two threads opening on different models
    // at the same moment race for it. A Hermes profile per model if that happens.
    // Jester is Hermes with its own soul (ADR-0030), on a home of its own, so
    // its sessions never mix with Vesper's. Hermes reads SOUL.md as who it is.
    const jester = input.payload.identityId === "jester";
    const home = jester ? `${options.hermesHome}-jester` : options.hermesHome;

    const plugin = join(home, "plugins", SCREEN_PLUGIN);

    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(home, "config.yaml"), hermesConfig(input.payload.model.model));
    writeFileSync(join(plugin, "plugin.yaml"), SCREEN_PLUGIN_MANIFEST);
    writeFileSync(join(plugin, "__init__.py"), SCREEN_PLUGIN_CODE);

    const soul = jester
      ? `${jesterSoul(input.roots.readable)}\n${ownerTimeContext(new Date(), input.payload.ownerTimeZone)}\n${PRODUCTIVITY_INSTRUCTIONS}`
      : identityCard({
          identityId: input.payload.identityId,
          runtime: "hermes",
          model: input.payload.model.model,
          env: input.env,
          readable: input.roots.readable,
          timeZone: input.payload.ownerTimeZone,
        });

    if (soul === undefined) {
      // A soul left over from when cards were on would keep speaking for Vesper.
      rmSync(join(home, "SOUL.md"), { force: true });
    } else {
      writeFileSync(join(home, "SOUL.md"), soul);
    }

    const child = spawn(command, [], {
      cwd: input.roots.cwd,
      env: { ...childEnvironment(input.env), HERMES_HOME: home },
    });
    trackChild(child, command);
    let alive = true;
    let closing: Promise<void> | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const rpc = createJsonRpcClient(
      { input: child.stdout, output: child.stdin },
      { timeoutMs: TURN_TIMEOUT_MS },
    );

    const proc: HermesProcess = {
      key,
      sessionRef: undefined,
      loading: false,
      current: undefined,
      rpc,
      // Named for the thread, because the MCP child Hermes is handed lives as long as this process.
      proposals: createProposalChannel(options.proposalsDir, `hermes-${input.payload.threadId}`),
      get alive() {
        return alive && child.exitCode === null;
      },
      killSoon() {
        killTimer ??= setTimeout(() => {
          void proc.close();
        }, KILL_AFTER_CANCEL_MS);
        killTimer.unref();
      },
      close() {
        if (alive) {
          alive = false;
          clearTimeout(killTimer);
          rpc.close();
        }
        return (closing ??= killProcessTree(child));
      },
    };

    child.on("exit", () => {
      alive = false;
      rpc.close("hermes exited");
    });
    child.on("error", () => {
      void proc.close();
    });
    rpc.onNotification((method, params) => {
      if (method === "session/update" && !proc.loading) {
        proc.current?.update(params);
      }
    });
    rpc.onRequest((method, params) => {
      if (method === "session/request_permission" && proc.current !== undefined) {
        return proc.current.permission(params);
      }

      // No file system or terminal is offered to Hermes; it uses its own tools.
      return Promise.reject(new JsonRpcError(METHOD_NOT_FOUND, `${method} is not offered`));
    });

    return proc;
  }

  /** The process's session: the one the core names, resumed, else a new one. */
  async function session(
    proc: HermesProcess,
    input: RuntimeTurnInput,
    sink: RuntimeSink,
  ): Promise<string> {
    if (proc.sessionRef !== undefined) {
      return proc.sessionRef;
    }

    await proc.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });

    const cwd = input.roots.cwd;
    const named = input.payload.sessionRef;
    const screen = Object.entries({
      [BROWSER_SERVER]: browserServer(input.env, input.payload.threadId),
      [DESKTOP_SERVER]: desktopServer(input.env),
    }).filter((entry): entry is [string, StdioServer] => entry[1] !== undefined);
    // The Noctis MCP tools, as Codex has them: what they propose lands in this thread's file.
    const mcpServers = [
      {
        name: "noctis",
        command: process.execPath,
        args: [mcpEntry, "--proposals", proc.proposals.path],
        env: [],
      },
      ...screen.map(([name, server]) => acpServer(name, server)),
    ];

    if (named !== undefined) {
      proc.loading = true;

      try {
        await proc.rpc.request("session/load", { sessionId: named, cwd, mcpServers });
        proc.sessionRef = named;

        return named;
      } catch {
        sink.item({
          itemId: "resume-failed",
          kind: "agent_message",
          status: "completed",
          text: `Hermes could not resume session ${named}; started a new one.`,
        });
      } finally {
        proc.loading = false;
      }
    }

    const created = NewSessionSchema.parse(
      await proc.rpc.request("session/new", { cwd, mcpServers }),
    );

    proc.sessionRef = created.sessionId;

    return created.sessionId;
  }

  async function run(
    proc: HermesProcess,
    input: RuntimeTurnInput,
    sink: RuntimeSink,
  ): Promise<RuntimeTurnEvidence> {
    const { payload, roots, signal } = input;
    const cancelOpening = (): void => {
      void proc.close();
    };
    signal.addEventListener("abort", cancelOpening, { once: true });
    let sessionId: string;
    try {
      if (signal.aborted) cancelOpening();
      sessionId = await session(proc, input, sink);
    } catch (error) {
      await proc.close();
      if (signal.aborted) return { model: payload.model, itemCount: 0, stoppedReason: "cancelled" };
      throw error;
    } finally {
      signal.removeEventListener("abort", cancelOpening);
    }
    const commands = new Map<string, string>();
    /** Tool calls Hermes started; it also closes its permission requests' bubbles, which are not. */
    const started = new Set<string>();
    const messages = new Map<string, string>();
    let lastMessage: string | undefined;
    let itemCount = 0;
    let timedOut: ApprovalTimedOut | undefined;

    const item = (value: RuntimeItem): void => {
      itemCount += 1;
      sink.item(value);
    };

    /** The owner's answer to Hermes's own ask; false when nobody could answer. */
    async function decide(ask: Omit<RuntimeAsk, "askId">): Promise<boolean> {
      try {
        return (await sink.ask({ ...ask, askedBy: "runtime" })).decision === "allow";
      } catch (error) {
        if (error instanceof ApprovalTimedOut) {
          timedOut = error;
        }

        return false;
      }
    }

    /** The option Hermes offered that says what the owner decided, once only. */
    function answer(p: z.infer<typeof PermissionSchema>, allowed: boolean): unknown {
      const kind = allowed ? "allow" : "reject";
      const optionId =
        p.options.find((option) => option.kind === `${kind}_once`)?.optionId ??
        p.options.find((option) => option.kind.startsWith(kind))?.optionId;

      return {
        outcome:
          optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
      };
    }

    /** Hermes asking to write files: the owner sees which. */
    function editAsk(p: z.infer<typeof PermissionSchema>): Omit<RuntimeAsk, "askId"> {
      const paths = (
        p.toolCall.locations?.map((location) => location.path) ?? [
          (p.toolCall.title ?? "").replace(/^Approve edit:\s*/, ""),
        ]
      )
        .filter((path) => path !== "")
        .slice(0, 200)
        .map((path) => clip(path, 1024));
      const cls = classifyAsk({
        kind: "file_change",
        paths,
        writableRoots: roots.writable,
        readableRoots: roots.readable,
      });

      return {
        itemId: clip(p.toolCall.toolCallId, 128),
        kind: "file_change",
        summary: clip(`edit ${paths.join(", ")}`, 2000),
        operationClass: cls.operationClass,
        reversibility: cls.reversibility,
        capability: cls.capability,
        target: { type: "file_change", id: clip(paths[0] ?? p.toolCall.toolCallId, 200) },
        detail: { paths },
      };
    }

    /**
     * A step on the owner's screen, as Codex and Claude have them: raw code is refused, an
     * ordinary step runs, and one that commits the owner is theirs to decide.
     */
    async function screenStep(p: z.infer<typeof PermissionSchema>, tool: string): Promise<boolean> {
      if (refusedTool(tool)) {
        return false;
      }

      const args = parseJson(p.toolCall.rawInput?.description);
      const cls = classifyAsk({
        kind: "tool_call",
        tool,
        args,
        writableRoots: roots.writable,
        readableRoots: roots.readable,
      });

      // With no input to judge the step by, the owner judges it.
      if (args !== undefined && !isConfirmLevel(cls.operationClass)) {
        return true;
      }

      return decide({
        itemId: clip(p.toolCall.toolCallId, 128),
        kind: "tool_call",
        summary: clip(`call ${tool}`, 2000),
        operationClass: cls.operationClass,
        reversibility: cls.reversibility,
        capability: cls.capability,
        target: { type: "tool_call", id: clip(tool, 200) },
        detail: { tool: clip(tool, 128) },
      });
    }

    /** A message is finished once another starts, or the turn ends. */
    const closeMessage = (): void => {
      if (lastMessage !== undefined) {
        item({
          itemId: clip(lastMessage, 128),
          kind: "agent_message",
          status: "completed",
          text: clip(messages.get(lastMessage) ?? "", 20_000),
        });
      }
    };

    proc.current = {
      update(params) {
        const parsed = UpdateSchema.safeParse(params);

        if (!parsed.success || parsed.data.sessionId !== sessionId) {
          return;
        }

        const u = parsed.data.update;

        switch (u.sessionUpdate) {
          case "agent_message_chunk": {
            const id = u.messageId ?? lastMessage ?? "message";
            const text = textOf(u.content);

            if (id !== lastMessage) {
              closeMessage();
              lastMessage = id;
            }

            messages.set(id, (messages.get(id) ?? "") + text);

            if (text !== "") {
              sink.delta(clip(id, 128), clip(text, 2000));
            }

            break;
          }
          case "tool_call":
          case "tool_call_update": {
            if (
              u.toolCallId === undefined ||
              (u.sessionUpdate === "tool_call_update" && !started.has(u.toolCallId))
            ) {
              break;
            }

            started.add(u.toolCallId);

            const status =
              u.status === "completed"
                ? "completed"
                : u.status === "failed"
                  ? "failed"
                  : "in_progress";
            const output = textOf(u.content);

            if (u.kind === "execute" || commands.has(u.toolCallId)) {
              const command =
                u.rawInput?.command ??
                commands.get(u.toolCallId) ??
                (u.title ?? "").replace(/^terminal:\s*/, "");

              commands.set(u.toolCallId, command);
              item({
                itemId: clip(u.toolCallId, 128),
                kind: "command",
                status,
                command: clip(command, 4000),
                cwd: clip(roots.cwd, 1024),
                ...(u.sessionUpdate === "tool_call_update" && output !== ""
                  ? { output: clip(output, 4000) }
                  : {}),
              });
            } else {
              item({
                itemId: clip(u.toolCallId, 128),
                kind: "tool_call",
                status,
                tool: clip(u.title ?? u.kind ?? "tool", 128),
                ...(u.sessionUpdate === "tool_call_update" && output !== ""
                  ? { output: clip(output, 4000) }
                  : {}),
              });
            }

            break;
          }
          default:
            // Thoughts, plans, usage, commands lists: Hermes's bookkeeping, not evidence.
            break;
        }
      },
      async permission(params) {
        const p = PermissionSchema.parse(params);
        const step = SCREEN_STEP.exec(p.toolCall.rawInput?.command ?? "")?.[1];

        if (step !== undefined) {
          return answer(p, await screenStep(p, step));
        }

        if (p.toolCall.kind === "edit") {
          return answer(p, await decide(editAsk(p)));
        }

        const command = p.toolCall.rawInput?.command ?? p.toolCall.title ?? "";
        const cls = classifyAsk({
          kind: "command",
          command,
          cwd: roots.cwd,
          writableRoots: roots.writable,
          readableRoots: roots.readable,
        });
        return answer(
          p,
          await decide({
            itemId: clip(p.toolCall.toolCallId, 128),
            kind: "command",
            summary: clip(command, 2000).trim() || "run a command",
            operationClass: cls.operationClass,
            reversibility: cls.reversibility,
            capability: cls.capability,
            target: { type: "command", id: clip(command, 200).trim() || "command" },
            detail: { command: clip(command, 4000), cwd: clip(roots.cwd, 1024) },
          }),
        );
      },
    };

    const cancel = (): void => {
      proc.rpc.notify("session/cancel", { sessionId });
      proc.killSoon();
    };

    signal.addEventListener("abort", cancel, { once: true });

    let proposals = 0;
    const stopChannel = proc.proposals.start((proposal) => {
      proposals += 1;
      item({
        itemId: `proposal-${String(proposals)}`,
        kind: "proposal",
        status: "completed",
        proposal,
      });
    });

    try {
      const result = PromptResultSchema.parse(
        await proc.rpc.request("session/prompt", {
          sessionId,
          prompt: [
            { type: "text", text: payload.prompt },
            { type: "text", text: ownerClockBlock(payload.ownerTimeZone, payload.targets) },
          ],
        }),
      );

      closeMessage();

      if (timedOut !== undefined) {
        throw timedOut;
      }

      const finalText = lastMessage === undefined ? "" : (messages.get(lastMessage) ?? "");

      return {
        model: payload.model,
        sessionRef: sessionId,
        itemCount,
        ...(finalText === "" ? {} : { finalText: clip(finalText, 20_000) }),
        ...(result.usage == null
          ? {}
          : {
              usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
              },
            }),
        stoppedReason: signal.aborted ? "cancelled" : (STOPPED[result.stopReason] ?? "failed"),
      };
    } catch (error) {
      await proc.close();
      if (signal.aborted) {
        return {
          model: payload.model,
          sessionRef: sessionId,
          itemCount,
          stoppedReason: "cancelled",
        };
      }

      throw error;
    } finally {
      stopChannel();
      signal.removeEventListener("abort", cancel);
      proc.current = undefined;
      if (signal.aborted || !proc.alive) await proc.close();
    }
  }

  return {
    providerId: "hermes",
    /** Installed, and something to think with: the local server's models are Hermes's. */
    async probe(): Promise<RuntimeProbe> {
      if ((options.command ?? resolveHermesCommand(options.env ?? process.env)) === undefined) {
        return {
          providerId: "hermes",
          available: false,
          authMode: "local",
          reason: "hermes_not_found",
          models: [],
        };
      }

      const local = await options.localProbe();

      return {
        providerId: "hermes",
        available: local.available,
        authMode: "local",
        ...(local.reason === undefined ? {} : { reason: local.reason }),
        models: local.models.map((model) => ({ ...model, providerId: "hermes" as const })),
      };
    },
    async turn(input: RuntimeTurnInput, sink: RuntimeSink): Promise<RuntimeTurnEvidence> {
      const command = options.command ?? resolveHermesCommand(input.env);

      if (command === undefined) {
        throw new AdapterRefused("hermes_not_found");
      }

      // Asked every turn, not just at hello: LM Studio may have stopped since.
      // Hermes is then unavailable, never quietly carried by something else.
      // When the node drives LM Studio it starts it and loads the model instead.
      const local = options.host === undefined ? await options.localProbe() : undefined;

      await ensureModel(options.host, input.payload.model.model);

      if (local !== undefined && !local.available) {
        throw new AdapterRefused(
          `LM Studio is not running, so Hermes has nothing to think with (${local.reason ?? "no models"})`,
        );
      }

      if (input.signal.aborted) {
        throw new AdapterRefused("job was cancelled");
      }

      const key = processKey(input.payload, input.roots);

      return pool.run(
        input.payload.threadId,
        { key, sessionRef: input.payload.sessionRef },
        () => open(input, key, command),
        (proc) => run(proc, input, sink),
      );
    },
    /**
     * Loads the model, which is most of a cold start (about 35 seconds for
     * Qwen at Hermes's context). Hermes itself starts on the first turn: a
     * process opened now would hold no session the core knows of, and the pool
     * would replace it. Nothing to load when the node does not drive LM Studio.
     */
    async warm(input) {
      if (options.host === undefined) {
        return false;
      }

      await ensureModel(options.host, input.payload.model.model);

      return true;
    },
    close: () => pool.closeAll(),
  };
}
