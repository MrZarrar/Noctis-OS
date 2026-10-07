import type { Readable, Writable } from "node:stream";

import { z } from "zod";

/**
 * A line-delimited JSON-RPC 2.0 peer over a child's stdio.
 *
 * Symmetric on purpose: both sides request, notify, and answer, so the fake
 * app-server in tests is this same code wired crosswise.
 */

export interface JsonRpcIo {
  input: Readable;
  output: Writable;
}

export interface JsonRpcClientOptions {
  /** A request the peer has not answered by then rejects. */
  timeoutMs?: number;
  /** A single inbound line longer than this is a protocol failure, not a message. */
  maxLineBytes?: number;
  /**
   * Called once when the client stops reading, for whatever reason. Without it
   * a peer that is still running but no longer heard looks like a quiet one.
   */
  onClose?: (reason: string) => void;
}

export type NotificationHandler = (method: string, params: unknown) => void;
export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

export interface JsonRpcClient {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: NotificationHandler): void;
  /** Peer → us. Throw a `JsonRpcError` to answer with a code; anything else is -32603. */
  onRequest(handler: RequestHandler): void;
  close(reason?: string): void;
}

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 1_048_576;

/**
 * The peer's envelope, not ours: Codex omits `jsonrpc` on replies and adds
 * `emittedAtMs` to notifications, so this is loose and reads only what it uses.
 */
const InboundSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
      .loose()
      .optional(),
  })
  .loose();

interface Pending {
  resolve(result: unknown): void;
  reject(reason: Error): void;
  timer: NodeJS.Timeout;
}

export function createJsonRpcClient(
  io: JsonRpcIo,
  options: JsonRpcClientOptions = {},
): JsonRpcClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const pending = new Map<number, Pending>();
  let onNotification: NotificationHandler = () => undefined;
  let onRequest: RequestHandler = (method) =>
    Promise.reject(new JsonRpcError(METHOD_NOT_FOUND, `no handler for ${method}`));
  let buffer = "";
  let nextId = 0;
  let closed = false;

  function write(message: Record<string, unknown>): void {
    if (!closed && io.output.writable) {
      io.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    }
  }

  function fail(reason: string): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }

    pending.clear();
  }

  function close(reason = "client closed"): void {
    if (closed) {
      return;
    }

    closed = true;
    fail(reason);
    io.input.off("data", onData);
    io.input.off("end", onEnd);
    io.input.off("close", onEnd);
    options.onClose?.(reason);
  }

  function answer(id: string | number, work: Promise<unknown>): void {
    work.then(
      (result) => write({ id, result: result ?? null }),
      (error: unknown) => {
        const rpc =
          error instanceof JsonRpcError
            ? error
            : new JsonRpcError(INTERNAL_ERROR, error instanceof Error ? error.message : "unknown");

        write({
          id,
          error: {
            code: rpc.code,
            message: rpc.message,
            ...(rpc.data === undefined ? {} : { data: rpc.data }),
          },
        });
      },
    );
  }

  function dispatch(line: string): void {
    let parsed: z.infer<typeof InboundSchema>;

    try {
      parsed = InboundSchema.parse(JSON.parse(line));
    } catch {
      // Not ours to crash on: a stray log line on stdout is the peer's bug, not a message.
      return;
    }

    const { id, method } = parsed;

    if (method !== undefined) {
      if (id === undefined) {
        onNotification(method, parsed.params);
      } else {
        answer(id, onRequest(method, parsed.params));
      }

      return;
    }

    const entry = typeof id === "number" ? pending.get(id) : undefined;

    if (entry === undefined) {
      return;
    }

    pending.delete(id as number);
    clearTimeout(entry.timer);

    if (parsed.error !== undefined) {
      entry.reject(new JsonRpcError(parsed.error.code, parsed.error.message, parsed.error.data));
    } else {
      entry.resolve(parsed.result);
    }
  }

  function onData(chunk: Buffer | string): void {
    buffer += chunk.toString();

    if (buffer.length > maxLineBytes) {
      close(`inbound line exceeded ${String(maxLineBytes)} bytes`);
      return;
    }

    let newline = buffer.indexOf("\n");

    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();

      buffer = buffer.slice(newline + 1);

      if (line !== "") {
        dispatch(line);
      }

      newline = buffer.indexOf("\n");
    }
  }

  function onEnd(): void {
    close("peer ended the stream");
  }

  io.input.on("data", onData);
  io.input.on("end", onEnd);
  io.input.on("close", onEnd);

  return {
    request(method, params = {}) {
      if (closed) {
        return Promise.reject(new Error("client closed"));
      }

      nextId += 1;

      const id = nextId;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${String(timeoutMs)} ms`));
        }, timeoutMs);

        timer.unref();
        pending.set(id, { resolve, reject, timer });
        write({ id, method, params });
      });
    },
    notify(method, params = {}) {
      write({ method, params });
    },
    onNotification(handler) {
      onNotification = handler;
    },
    onRequest(handler) {
      onRequest = handler;
    },
    close,
  };
}
