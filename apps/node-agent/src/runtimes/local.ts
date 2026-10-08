import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeProbe, RuntimeTurnEvidence } from "@noctis/contracts";
import { z } from "zod";

import type { Runtime, RuntimeSink, RuntimeTurnInput } from "./Runtime.js";
import { AdapterRefused } from "./Runtime.js";

/**
 * A model served on this PC (LM Studio by default, or anything else that
 * speaks the OpenAI-compatible chat API) as a Noctis runtime: v1 S3.
 *
 * Text in, text out. It has no tools, so it reads nothing, writes nothing and
 * runs nothing, and there is nothing to ask the owner about. The server keeps
 * no conversation between requests; the node keeps each thread's transcript
 * as a file under its own home, named by the session ref the core stores.
 * The server must listen on loopback: a model on another machine is not this
 * node's to call.
 */

export interface LocalRuntimeOptions {
  /** The server's OpenAI-compatible base. LM Studio's default when absent. */
  baseUrl?: string | undefined;
  /** Where each thread's transcript is kept. */
  sessionsDir: string;
}

/** LM Studio's server, as `lms server start` opens it. */
export const DEFAULT_LOCAL_MODEL_URL = "http://127.0.0.1:1234/v1";

const PROBE_TIMEOUT_MS = 3_000;
/** ponytail: the newest messages only, so a long thread still fits the model's context. Summarise when that bites. */
const MAX_HISTORY_MESSAGES = 40;
const MAX_TEXT = 20_000;
const SYSTEM_PROMPT =
  "You are a language model running on the owner's own PC, reached through Noctis. " +
  "You have no tools: you cannot open files, browse or run anything, so answer in text only.";

const ModelsSchema = z
  .object({ data: z.array(z.object({ id: z.string().min(1) }).loose()) })
  .loose();
const ChunkSchema = z
  .object({
    choices: z
      .array(z.object({ delta: z.object({ content: z.string().nullish() }).loose() }).loose())
      .optional(),
    usage: z
      .object({ prompt_tokens: z.number().int(), completion_tokens: z.number().int() })
      .loose()
      .nullish(),
  })
  .loose();

type Message = { role: "user" | "assistant"; content: string };

const TranscriptSchema = z.array(
  z.object({ role: z.enum(["user", "assistant"]), content: z.string() }).strict(),
);

function isLoopback(url: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function createLocalRuntime(options: LocalRuntimeOptions): Runtime {
  const base = (options.baseUrl?.trim() || DEFAULT_LOCAL_MODEL_URL).replace(/\/+$/, "");
  const loopback = isLoopback(base);

  function transcriptPath(sessionRef: string): string {
    if (!/^[A-Za-z0-9-]{1,200}$/.test(sessionRef)) {
      throw new AdapterRefused("not a local session ref");
    }

    return join(options.sessionsDir, `${sessionRef}.json`);
  }

  async function load(sessionRef: string | undefined): Promise<Message[]> {
    if (sessionRef === undefined) {
      return [];
    }

    let text: string;

    try {
      text = await readFile(transcriptPath(sessionRef), "utf8");
    } catch (error) {
      // A thread whose transcript is gone starts again, as a failed resume does elsewhere.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }

    // One that is there but unreadable fails the turn: the next save would overwrite it.
    return TranscriptSchema.parse(JSON.parse(text));
  }

  async function save(sessionRef: string, messages: Message[]): Promise<void> {
    const path = transcriptPath(sessionRef);

    await mkdir(options.sessionsDir, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;

    await writeFile(temporary, JSON.stringify(messages));
    await rename(temporary, path);
  }

  async function probe(): Promise<RuntimeProbe> {
    const unavailable = (reason: string): RuntimeProbe => ({
      providerId: "local",
      available: false,
      authMode: "local",
      reason,
      models: [],
    });

    if (!loopback) {
      return unavailable("local_model_server_not_on_this_machine");
    }

    try {
      const response = await fetch(`${base}/models`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        // Loopback is checked on this URL only; a redirect would lead elsewhere.
        redirect: "error",
      });
      const models = ModelsSchema.parse(await response.json()).data.slice(0, 64);

      return {
        providerId: "local",
        available: models.length > 0,
        authMode: "local",
        ...(models.length === 0 ? { reason: "local_model_server_has_no_models" } : {}),
        models: models.map((model) => ({
          providerId: "local" as const,
          model: model.id.slice(0, 128),
        })),
      };
    } catch {
      return unavailable(`no local model server answered at ${base}`);
    }
  }

  /** A conversation's turns one at a time, so two never read the same history and both save. */
  const queues = new Map<string, Promise<unknown>>();

  function turn(input: RuntimeTurnInput, sink: RuntimeSink): Promise<RuntimeTurnEvidence> {
    const key = input.payload.sessionRef ?? input.payload.threadId;
    const next = (queues.get(key) ?? Promise.resolve()).then(
      () => runTurn(input, sink),
      () => runTurn(input, sink),
    );
    const forget = (): void => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    };

    queues.set(key, next);
    next.then(forget, forget);

    return next;
  }

  async function runTurn(input: RuntimeTurnInput, sink: RuntimeSink): Promise<RuntimeTurnEvidence> {
    const { payload, signal } = input;

    if (!loopback) {
      throw new AdapterRefused("the local model server is not on this machine");
    }

    if (signal.aborted) {
      throw new AdapterRefused("job was cancelled");
    }

    const sessionRef = payload.sessionRef ?? randomUUID();
    const history = await load(payload.sessionRef);
    const asked: Message[] = [...history, { role: "user", content: payload.prompt }];
    let reply = "";
    let usage: RuntimeTurnEvidence["usage"];

    const evidence = (
      stoppedReason: RuntimeTurnEvidence["stoppedReason"],
    ): RuntimeTurnEvidence => ({
      model: payload.model,
      sessionRef,
      itemCount: 1,
      ...(reply === "" ? {} : { finalText: reply.slice(0, MAX_TEXT) }),
      ...(usage === undefined ? {} : { usage }),
      stoppedReason,
    });

    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: payload.model.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...asked.slice(-MAX_HISTORY_MESSAGES),
          ],
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal,
        redirect: "error",
      });

      if (!response.ok || response.body === null) {
        throw new Error(`the local model server answered ${String(response.status)}`);
      }

      const decoder = new TextDecoder();
      let pending = "";
      let done = false;

      for await (const bytes of response.body as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(bytes, { stream: true });

        const lines = pending.split("\n");

        pending = lines.pop() ?? "";

        for (const line of lines) {
          const data = line.startsWith("data:") ? line.slice(5).trim() : "";

          if (data === "[DONE]") {
            done = true;
            break;
          }

          if (data === "") {
            continue;
          }

          const chunk = ChunkSchema.parse(JSON.parse(data));
          const text = chunk.choices?.[0]?.delta.content ?? "";

          if (chunk.usage != null) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            };
          }

          if (text !== "") {
            reply += text;
            // Deltas are capped per frame; a server can send a long chunk.
            for (let at = 0; at < text.length; at += 2_000) {
              sink.delta("m1", text.slice(at, at + 2_000));
            }
          }
        }

        if (done) {
          break;
        }
      }

      if (!done) {
        throw new Error("the local model server ended before it finished the reply");
      }
    } catch (error) {
      if (signal.aborted) {
        return evidence("cancelled");
      }

      throw error;
    }

    sink.item({
      itemId: "m1",
      kind: "agent_message",
      status: "completed",
      text: reply.slice(0, MAX_TEXT),
    });
    await save(sessionRef, [...asked, { role: "assistant", content: reply }]);

    return evidence("completed");
  }

  return { providerId: "local", probe, turn };
}
