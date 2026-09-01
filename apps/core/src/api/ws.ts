import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { OrchestrationEvent, ServerFrame } from "@noctis/contracts";
import { ClientFrameSchema, ENVELOPE_VERSION } from "@noctis/contracts";
import { WebSocketServer, type WebSocket } from "ws";

import { latestSequence, readEventsAfter } from "../db/events.js";
import type { ApiDeps } from "./http.js";
import { isAuthorized, isOriginAllowed } from "./auth.js";

/** The client realm. `/ws/nodes` is a separate realm and is not served here. */
export const CLIENT_SOCKET_PATH = "/ws/clients";

const MAX_FRAME_BYTES = 64 * 1024;
const REPLAY_PAGE_SIZE = 500;
const HEARTBEAT_MS = 30_000;
/** A client this far behind is not reading. Close it; it can resume by sequence. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** RFC 6455 close codes used here. */
const CLOSE_POLICY = 1008;
const CLOSE_OVERLOADED = 1011;

function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function frame(payload: ServerFrame): string {
  return JSON.stringify(payload);
}

/**
 * Serves `/ws/clients`: authenticated, resumable delivery of committed events.
 *
 * Resume is by global sequence, not by an offset the client invents. Anything a
 * client missed while disconnected is still in `orchestration_events`, so a
 * reconnect is a read, not a replay buffer the core has to keep.
 */
export function attachClientSocket(server: HttpServer, deps: ApiDeps): WebSocketServer {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${deps.config.bindAddress}`);

    if (url.pathname !== CLIENT_SOCKET_PATH) {
      refuseUpgrade(socket, 404, "Not Found");
      return;
    }

    if (!isOriginAllowed(req.headers.origin, deps.config.allowedOrigins)) {
      refuseUpgrade(socket, 403, "Forbidden");
      return;
    }

    if (!isAuthorized(req.headers.authorization, deps.config.token)) {
      refuseUpgrade(socket, 401, "Unauthorized");
      return;
    }

    sockets.handleUpgrade(req, socket, head, (ws) => {
      sockets.emit("connection", ws, req);
    });
  });

  sockets.on("connection", (ws: WebSocket) => {
    const connectionId = deps.kernel.ids.nextId();
    const logger = deps.kernel.logger.child({ connectionId, socket: CLIENT_SOCKET_PATH });

    let streaming = false;
    let subscribed = false;
    let delivered = 0;
    let pending: OrchestrationEvent[] = [];
    let unsubscribe: () => void = () => undefined;
    let alive = true;

    function closeWith(code: number, reason: string): void {
      logger.log("warn", "closing client socket", { code, reason });
      unsubscribe();
      ws.close(code, reason);
    }

    function deliver(events: readonly OrchestrationEvent[]): void {
      for (const event of events) {
        if (ws.readyState !== ws.OPEN) {
          return;
        }

        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          closeWith(CLOSE_OVERLOADED, "client is not consuming events");
          return;
        }

        ws.send(frame({ kind: "event", envelopeVersion: ENVELOPE_VERSION, event }));
        delivered = event.sequence;
      }
    }

    function startStream(afterSequence: number): void {
      // Subscribe before reading the backfill, and hold live events aside until
      // the backfill is sent. The read below is synchronous today, so nothing
      // can currently interleave — but the ordering is what makes that an
      // optimisation rather than the only reason this is correct.
      unsubscribe = deps.kernel.broker.subscribe((events) => {
        if (streaming) {
          deliver(events);
        } else {
          pending.push(...events);
        }
      });

      const latest = latestSequence(deps.kernel.db);
      let cursor = afterSequence;

      if (afterSequence > latest) {
        // The client's cursor is ahead of the ledger: a different database, or a
        // restored backup. Say so rather than silently resuming from nowhere.
        ws.send(
          frame({
            kind: "gap",
            envelopeVersion: ENVELOPE_VERSION,
            fromSequence: latest,
            toSequence: afterSequence,
          }),
        );
        cursor = latest;
      }

      for (;;) {
        const page = readEventsAfter(deps.kernel.db, cursor, REPLAY_PAGE_SIZE);

        if (page.length === 0) {
          break;
        }

        deliver(page);
        cursor = page[page.length - 1]?.sequence ?? cursor;

        if (page.length < REPLAY_PAGE_SIZE) {
          break;
        }
      }

      streaming = true;

      const missed = pending.filter((event) => event.sequence > Math.max(cursor, delivered));
      pending = [];
      deliver(missed);

      logger.log("info", "client stream started", { afterSequence, resumedTo: delivered });
    }

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        closeWith(CLOSE_POLICY, "binary frames are not accepted");
        return;
      }

      let json: unknown;

      try {
        json = JSON.parse(data.toString("utf8")) as unknown;
      } catch {
        closeWith(CLOSE_POLICY, "frame is not valid JSON");
        return;
      }

      const parsed = ClientFrameSchema.safeParse(json);

      if (!parsed.success) {
        // Fail closed. An unknown envelope version or an unregistered frame kind
        // is a protocol mismatch, and guessing what the peer meant is how a
        // versioned envelope stops being a version.
        closeWith(CLOSE_POLICY, "frame does not match the client protocol");
        return;
      }

      if (parsed.data.kind === "acknowledge") {
        // ponytail: validated and dropped. The core needs no per-client cursor
        // while every event is durable and resume is by sequence. Wire it up
        // when something actually prunes the ledger.
        return;
      }

      if (subscribed) {
        closeWith(CLOSE_POLICY, "already subscribed");
        return;
      }

      subscribed = true;
      startStream(parsed.data.afterSequence);
    });

    ws.on("pong", () => {
      alive = true;
    });

    // Without this a half-open TCP connection holds a broker subscription
    // forever, and the core slowly fills with sockets nobody is on the far end of.
    const heartbeat = setInterval(() => {
      if (!alive) {
        unsubscribe();
        ws.terminate();
        return;
      }

      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);

    ws.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    ws.on("error", (error: Error) => {
      logger.log("warn", "client socket error", { reason: error.message });
    });
  });

  return sockets;
}
