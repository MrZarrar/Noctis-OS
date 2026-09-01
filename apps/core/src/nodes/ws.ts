import type { IncomingMessage } from "node:http";

import type { NodeServerFrame } from "@noctis/contracts";
import { NODE_ENVELOPE_VERSION, NodeFrameSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { WebSocketServer, type WebSocket } from "ws";

import type { SocketRealm } from "../api/ws.js";
import { CLOSE_POLICY, HEARTBEAT_MS, refuseUpgrade } from "../api/ws.js";
import type { CoreConfig } from "../config/server.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { parseNodeAuthorization, verifyCredential } from "./credentials.js";
import type { Dispatcher, NodeConnection } from "./dispatch.js";
import type { NodeJobRecord } from "./jobs.js";
import { completeJob } from "./jobs.js";
import {
  connectNode,
  disconnectNode,
  getCredentialGeneration,
  getNode,
  listGrants,
} from "./registry.js";

/** The node realm. Not interchangeable with `/ws/clients` (Section 10). */
export const NODE_SOCKET_PATH = "/ws/nodes";

const MAX_FRAME_BYTES = 64 * 1024;

/**
 * Progress is advisory. A node that sends more than this about a single job is
 * either broken or trying to keep the core busy, and neither is worth serving.
 */
const MAX_PROGRESS_FRAMES_PER_JOB = 200;

/** In-flight jobs the core will track progress for on one connection. */
const MAX_TRACKED_JOBS = 256;

export interface NodeSocketDeps {
  kernel: Kernel;
  config: CoreConfig;
  dispatcher: Dispatcher;
}

/**
 * Serves `/ws/nodes`.
 *
 * A different realm from the client socket in every respect that matters: a
 * different credential (derived per node, not the core token), a different
 * message schema (`NodeFrameSchema`, not `ClientFrameSchema`), and a different
 * direction of trust — the core reads nothing from a node without checking it
 * against what the core already knows.
 */
export function attachNodeSocket(deps: NodeSocketDeps): SocketRealm {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  sockets.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const authorization = parseNodeAuthorization(req.headers.authorization);

    if (authorization === undefined) {
      // Cannot happen: the upgrade already parsed it. Fail closed rather than
      // continue with a connection whose identity is unknown.
      ws.close(CLOSE_POLICY, "unidentified node");
      return;
    }

    const nodeId = authorization.nodeId;
    const connectionId = deps.kernel.ids.nextId();
    const logger = deps.kernel.logger.child({ connectionId, nodeId, socket: NODE_SOCKET_PATH });
    const progressCounts = new Map<string, number>();

    let connection: NodeConnection | undefined;
    let alive = true;

    function context(): CommandContext {
      return { correlationId: deps.kernel.ids.nextId(), actorType: "node", actorId: nodeId };
    }

    function closeWith(code: number, reason: string): void {
      logger.log("warn", "closing node socket", { code, reason });
      ws.close(code, reason);
    }

    function onHello(agentVersion: string, advertised: readonly string[]): void {
      if (connection !== undefined) {
        closeWith(CLOSE_POLICY, "already connected");
        return;
      }

      const connected = connectNode(
        deps.kernel,
        context(),
        { nodeId, connectionId, agentVersion },
        deps.config.token,
      );

      if (!connected.ok) {
        closeWith(CLOSE_POLICY, "node is not paired");
        return;
      }

      const live: NodeConnection = {
        nodeId,
        connectionId,
        credential: connected.value.credential,
        send(payload: NodeServerFrame) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(payload));
          }
        },
        close(code, reason) {
          ws.close(code, reason);
        },
      };

      connection = live;

      const grants = listGrants(deps.kernel.db, nodeId).filter(
        (grant) => grant.revokedAt === undefined,
      );

      live.send({
        kind: "welcome",
        envelopeVersion: NODE_ENVELOPE_VERSION,
        nodeId,
        generation: connected.value.generation,
        credential: connected.value.credential,
        grants,
      });

      deps.dispatcher.register(live);

      logger.log("info", "node connected", {
        agentVersion,
        advertised: [...advertised],
        granted: grants.map((grant) => grant.capability),
      });

      // Anything already queued for this node can go out now.
      deps.dispatcher.pass();
    }

    function onProgress(jobId: string, percent: number, note: string): void {
      if (connection === undefined) {
        closeWith(CLOSE_POLICY, "progress before hello");
        return;
      }

      const seen = progressCounts.get(jobId) ?? 0;

      if (seen === 0 && progressCounts.size >= MAX_TRACKED_JOBS) {
        closeWith(CLOSE_POLICY, "too many concurrent jobs");
        return;
      }

      if (seen >= MAX_PROGRESS_FRAMES_PER_JOB) {
        closeWith(CLOSE_POLICY, "progress frame budget exhausted");
        return;
      }

      progressCounts.set(jobId, seen + 1);

      // ponytail: validated, counted, and dropped. Nothing consumes progress yet
      // — persisting it would be a write and an event every few hundred
      // milliseconds for a fact no reader has. Forward it to a surface in the
      // phase that renders one.
      logger.log("debug", "job progress", { jobId, percent, note });
    }

    function onResult(
      jobId: string,
      outcome: "succeeded" | "failed",
      evidence: unknown,
      failureReason: string | undefined,
    ): void {
      if (connection === undefined) {
        closeWith(CLOSE_POLICY, "result before hello");
        return;
      }

      progressCounts.delete(jobId);

      let recorded: Result<NodeJobRecord>;

      try {
        recorded = completeJob(deps.kernel, context(), {
          jobId,
          nodeId,
          outcome,
          evidence,
          ...(failureReason === undefined ? {} : { failureReason }),
        });
      } catch (error) {
        // Evidence that does not match the capability's schema. The job keeps
        // its lease and lapses, rather than being recorded as a result the
        // contract cannot describe.
        logger.log("warn", "rejected node evidence", {
          jobId,
          reason: error instanceof Error ? error.message : "unknown",
        });
        closeWith(CLOSE_POLICY, "evidence does not match the capability contract");
        return;
      }

      if (!recorded.ok) {
        logger.log("warn", "rejected node result", {
          jobId,
          conflict: recorded.conflict.kind,
        });
        return;
      }

      logger.log("info", "job result recorded", { jobId, outcome });
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

      const parsed = NodeFrameSchema.safeParse(json);

      if (!parsed.success) {
        // Fail closed, exactly as the client realm does. A node frame that does
        // not parse is a protocol mismatch or an attack; either way the core has
        // no business guessing what it meant.
        closeWith(CLOSE_POLICY, "frame does not match the node protocol");
        return;
      }

      const frame = parsed.data;

      switch (frame.kind) {
        case "hello":
          onHello(frame.agentVersion, frame.capabilities);
          return;
        case "progress":
          onProgress(frame.jobId, frame.percent, frame.note);
          return;
        case "result":
          onResult(frame.jobId, frame.outcome, frame.evidence, frame.failureReason);
          return;
      }
    });

    ws.on("pong", () => {
      alive = true;
    });

    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }

      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);

    ws.on("close", () => {
      clearInterval(heartbeat);

      if (connection === undefined) {
        return;
      }

      deps.dispatcher.unregister(connection);

      if (deps.dispatcher.isStopping()) {
        // `stop` already wrote the offline transition for every connection it
        // held, and the database is closing behind this event.
        return;
      }

      const marked = disconnectNode(deps.kernel, context(), { nodeId, connectionId });

      if (!marked.ok) {
        logger.log("warn", "could not mark node offline", { conflict: marked.conflict.kind });
      }
    });

    ws.on("error", (error: Error) => {
      logger.log("warn", "node socket error", { reason: error.message });
    });
  });

  return {
    sockets,
    tryUpgrade(req, socket, head) {
      const url = new URL(req.url ?? "/", `http://${deps.config.bindAddress}`);

      if (url.pathname !== NODE_SOCKET_PATH) {
        return false;
      }

      // A node agent is not a browser and never sends an Origin. A request that
      // does is a page, and a page must not be able to become a worker no matter
      // which origin it is served from.
      if (req.headers.origin !== undefined) {
        refuseUpgrade(socket, 403, "Forbidden");
        return true;
      }

      const authorization = parseNodeAuthorization(req.headers.authorization);

      if (authorization === undefined) {
        refuseUpgrade(socket, 401, "Unauthorized");
        return true;
      }

      const generation = getCredentialGeneration(deps.kernel.db, authorization.nodeId);
      const node = getNode(deps.kernel.db, authorization.nodeId);

      // An unknown node and a wrong credential are the same answer. Telling them
      // apart would turn this into an oracle for which node ids exist.
      if (
        generation === undefined ||
        node === undefined ||
        !verifyCredential({
          coreToken: deps.config.token,
          nodeId: authorization.nodeId,
          generation,
          presented: authorization.credential,
        })
      ) {
        refuseUpgrade(socket, 401, "Unauthorized");
        return true;
      }

      if (node.status === "revoked") {
        // Checked after the credential so a revoked node learns nothing a
        // stranger would not, and refused separately so the log says why.
        deps.kernel.logger.log("warn", "refused a revoked node", { nodeId: node.id });
        refuseUpgrade(socket, 403, "Forbidden");
        return true;
      }

      sockets.handleUpgrade(req, socket, head, (ws) => {
        sockets.emit("connection", ws, req);
      });

      return true;
    },
  };
}
