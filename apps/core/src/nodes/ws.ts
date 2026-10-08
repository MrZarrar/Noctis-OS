import type { IncomingMessage } from "node:http";

import type { NodeCapability, NodeServerFrame, RuntimeProbe } from "@noctis/contracts";
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
import { completeJob, getJob, renewLease, startJob } from "./jobs.js";
import {
  connectNode,
  disconnectNode,
  getCredentialGeneration,
  getNode,
  listGrants,
} from "./registry.js";
import type { RuntimeFrameHub } from "./runtime-frames.js";

/** The node realm. Not interchangeable with `/ws/clients` (Section 10). */
export const NODE_SOCKET_PATH = "/ws/nodes";

const MAX_FRAME_BYTES = 64 * 1024;

/**
 * Advisory frames (progress, stream, delta, ask) a node may send about one job.
 * A node that sends more is either broken or trying to keep the core busy, and
 * neither is worth serving. A turn streams a token at a time, so its budget is
 * sized for deltas; everything else reports progress and nothing more.
 */
export const FRAME_BUDGET: Record<NodeCapability, number> = {
  "environment.inspect": 200,
  "file.search": 200,
  "verification.noop": 200,
  "runtime.turn": 100_000,
  "file.list": 200,
  /** A heartbeat every ten seconds while bytes flow: hours of film. */
  "file.read": 2_000,
  "session.list": 200,
};

/** In-flight jobs the core will track frames for on one connection. */
const MAX_TRACKED_JOBS = 256;

/** What the socket remembers about a job it has seen frames for. */
interface HeldJob {
  capability: NodeCapability;
  frames: number;
  /** Whether `startJob` has run, so a thousand frames cost one status change. */
  started: boolean;
}

export interface NodeSocketDeps {
  kernel: Kernel;
  config: CoreConfig;
  dispatcher: Dispatcher;
  runtime: RuntimeFrameHub;
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
    const held = new Map<string, HeldJob>();

    let connection: NodeConnection | undefined;
    let alive = true;

    function context(): CommandContext {
      return { correlationId: deps.kernel.ids.nextId(), actorType: "node", actorId: nodeId };
    }

    function closeWith(code: number, reason: string): void {
      logger.log("warn", "closing node socket", { code, reason });
      ws.close(code, reason);
    }

    function onHello(
      agentVersion: string,
      advertised: readonly string[],
      providers: readonly RuntimeProbe[],
    ): void {
      if (connection !== undefined) {
        closeWith(CLOSE_POLICY, "already connected");
        return;
      }

      const connected = connectNode(
        deps.kernel,
        context(),
        { nodeId, connectionId, agentVersion, providers },
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

    /**
     * Admits one advisory frame about `jobId`, or closes the socket and returns
     * undefined. Every check a node could fail is here: it said hello, the job
     * is leased or running to this node, the frame budget holds, and the lease
     * is still live (renewed as a side effect — the frame is the heartbeat).
     */
    function admit(jobId: string, kind: string): HeldJob | undefined {
      if (connection === undefined) {
        closeWith(CLOSE_POLICY, `${kind} before hello`);
        return undefined;
      }

      let entry = held.get(jobId);

      if (entry === undefined) {
        if (held.size >= MAX_TRACKED_JOBS) {
          closeWith(CLOSE_POLICY, "too many concurrent jobs");
          return undefined;
        }

        // Looked up once per job, not per frame: a delta arrives every few
        // hundred milliseconds and the row's capability does not change.
        const record = getJob(deps.kernel.db, jobId);
        const status = record?.job.status;

        if (
          record === undefined ||
          record.job.nodeId !== nodeId ||
          (status !== "leased" && status !== "running")
        ) {
          closeWith(CLOSE_POLICY, "frame for a job this node does not hold");
          return undefined;
        }

        entry = { capability: record.job.capability as NodeCapability, frames: 0, started: false };
        held.set(jobId, entry);
      }

      if (entry.frames >= FRAME_BUDGET[entry.capability]) {
        closeWith(CLOSE_POLICY, "frame budget exhausted");
        return undefined;
      }

      entry.frames += 1;

      if (!renewLease(deps.kernel.db, { jobId, nodeId, now: deps.kernel.clock.now() })) {
        // The lease is what authorised the work. A frame after it lapsed is
        // from a node the core has already given up on; the sweep settles the job.
        logger.log("debug", "frame after lease lapsed", { jobId, kind });
        return undefined;
      }

      return entry;
    }

    /** The first stream, delta or ask is the runtime starting: leased -> running. */
    function markStarted(jobId: string, entry: HeldJob): void {
      if (entry.started) {
        return;
      }

      entry.started = true;

      const started = startJob(deps.kernel, context(), { jobId, nodeId });

      if (!started.ok) {
        logger.log("warn", "could not mark a job running", {
          jobId,
          conflict: started.conflict.kind,
        });
      }
    }

    function onProgress(jobId: string, percent: number, note: string): void {
      if (admit(jobId, "progress") === undefined) {
        return;
      }

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

      held.delete(jobId);

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

      // Stream, delta, ask and delegate are handed to the hub and nothing else. What
      // becomes durable is the subscriber's decision; a delta never does.
      switch (frame.kind) {
        case "hello":
          onHello(frame.agentVersion, frame.capabilities, frame.providers);
          return;
        case "progress":
          onProgress(frame.jobId, frame.percent, frame.note);
          return;
        case "stream": {
          const entry = admit(frame.jobId, "stream");

          if (entry !== undefined) {
            markStarted(frame.jobId, entry);
            deps.runtime.onStreamItem(nodeId, frame.jobId, frame.sequence, frame.item);
          }

          return;
        }
        case "delta": {
          const entry = admit(frame.jobId, "delta");

          if (entry !== undefined) {
            markStarted(frame.jobId, entry);
            deps.runtime.onDelta(nodeId, frame.jobId, frame.delta);
          }

          return;
        }
        case "ask": {
          const entry = admit(frame.jobId, "ask");

          if (entry !== undefined) {
            markStarted(frame.jobId, entry);
            deps.runtime.onAsk(nodeId, frame.jobId, frame.ask);
          }

          return;
        }
        case "delegate": {
          const entry = admit(frame.jobId, "delegate");

          if (entry !== undefined) {
            markStarted(frame.jobId, entry);
            deps.runtime.onDelegate(nodeId, frame.jobId, frame.delegation);
          }

          return;
        }
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

      if (deps.dispatcher.isConnected(nodeId)) {
        // This socket was replaced rather than lost: one node has one
        // connection, so a reconnect (or an operator handing the agent from one
        // terminal to another) closes the older one *after* the newer is
        // registered. Writing `offline` here would describe a socket that is
        // open, and `unregister` has already declined to touch the live entry.
        logger.log("info", "a replaced connection closed; the node is still connected");
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
