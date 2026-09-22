import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  CapabilityGrant,
  NodeCredential,
  NodeFrame,
  NodeJobAssignment,
  RuntimeAnswer,
  RuntimeProbe,
  RuntimeProviderId,
} from "@noctis/contracts";
import {
  NODE_ENVELOPE_VERSION,
  NodeJobAssignmentSchema,
  NodeServerFrameSchema,
} from "@noctis/contracts";
import { createIdFactory, systemClock } from "@noctis/domain";
import { WebSocket } from "ws";

import type { Adapter, AdapterContext } from "./adapters.js";
import { ADAPTERS, AdapterRefused } from "./adapters.js";
import type { Runtime } from "./runtimes/Runtime.js";
import { probeInstalledProviders } from "./runtimes/probe.js";

export const AGENT_VERSION = "0.0.0";

/** Mirrors `apps/core/src/nodes/credentials.ts`. Both sides sign the same bytes. */
const SIGNATURE_DOMAIN = "noctis.node.assignment.v1";

const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export type AgentLogger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

export interface AgentOptions {
  credential: NodeCredential;
  /**
   * Persists the rotated credential from each `welcome`. The core keeps the
   * previous generation valid, so a failure here costs one reconnect, not the
   * pairing.
   */
  saveCredential: (next: NodeCredential) => void;
  agentVersion?: string;
  adapters?: Readonly<Record<string, Adapter>>;
  logger?: AgentLogger;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** False in tests that want exactly one connection attempt. */
  reconnect?: boolean;
  /** Which runtime answers for each provider. Empty by default: nothing is guessed. */
  runtimes?: Partial<Record<RuntimeProviderId, Runtime>>;
  /** Run once before the first connect; the result rides in every `hello`. */
  probes?: () => Promise<RuntimeProbe[]>;
  env?: NodeJS.ProcessEnv;
}

interface PendingAsk {
  resolve(answer: RuntimeAnswer): void;
  reject(reason: Error): void;
}

export interface RunningAgent {
  close(): void;
  /** Reconnect attempts since the last successful `welcome`. Read by tests. */
  attempts(): number;
  connected(): boolean;
}

function verifySignature(credential: string, assignmentJson: string, signature: string): boolean {
  const expected = createHmac("sha256", credential)
    .update(`${SIGNATURE_DOMAIN}:${assignmentJson}`)
    .digest("hex");

  // Digest-then-compare, because timingSafeEqual throws on a length mismatch.
  return timingSafeEqual(
    createHash("sha256").update(signature, "utf8").digest(),
    createHash("sha256").update(expected, "utf8").digest(),
  );
}

function socketUrl(coreUrl: string): string {
  const url = new URL("/ws/nodes", coreUrl);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
}

/**
 * The outbound worker.
 *
 * It dials the core; the core never dials it. That is the whole reason a node
 * needs no listening port, and it is why `no-listener.test.ts` can assert the
 * absence of one as a property of this directory rather than a deployment note.
 */
export function startAgent(options: AgentOptions): RunningAgent {
  const adapters = options.adapters ?? ADAPTERS;
  const agentVersion = options.agentVersion ?? AGENT_VERSION;
  const log: AgentLogger = options.logger ?? (() => undefined);
  const initialBackoff = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoff = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const runtimes = options.runtimes ?? {};
  const env = options.env ?? process.env;
  const probes = options.probes ?? (() => probeInstalledProviders(env));
  const ids = createIdFactory(systemClock);
  const running = new Map<string, AbortController>();
  /** Per job, the asks whose answer has not arrived. Rejected on cancel and on disconnect. */
  const pendingAsks = new Map<string, Map<string, PendingAsk>>();
  let providers: RuntimeProbe[] = [];

  let credential = options.credential;
  let sessionCredential: string | undefined;
  let grants: readonly CapabilityGrant[] = [];
  let socket: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let attempt = 0;
  let stopped = false;

  function send(frame: NodeFrame): void {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }

  /**
   * One attachment's bytes, over HTTP with this node's credential.
   *
   * Read from `credential` at call time rather than captured, because the core
   * rotates the credential on every `welcome` and a turn can outlive a
   * reconnect. The generation before the current one is still accepted
   * (`credentials.ts`), so a rotation that lands mid-fetch costs nothing.
   */
  async function fetchAttachment(id: string, signal: AbortSignal): Promise<Uint8Array> {
    const response = await fetch(new URL(`/node/attachments/${id}`, credential.coreUrl), {
      headers: { authorization: `Bearer ${credential.nodeId}.${credential.credential}` },
      signal,
    });

    if (!response.ok) {
      throw new AdapterRefused(`the core refused attachment ${id} with ${String(response.status)}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  function rejectAsks(jobId: string, reason: string): void {
    for (const pending of pendingAsks.get(jobId)?.values() ?? []) {
      pending.reject(new AdapterRefused(reason));
    }

    pendingAsks.delete(jobId);
  }

  async function execute(assignment: NodeJobAssignment): Promise<void> {
    const controller = new AbortController();
    const { jobId } = assignment;
    const asks = new Map<string, PendingAsk>();
    let sequence = 0;

    running.set(jobId, controller);
    pendingAsks.set(jobId, asks);
    controller.signal.addEventListener("abort", () => rejectAsks(jobId, "job was cancelled"));

    const context: AdapterContext = {
      grants,
      signal: controller.signal,
      env,
      runtimes,
      fetchAttachment: (id) => fetchAttachment(id, controller.signal),
      progress(percent, note) {
        send({ kind: "progress", envelopeVersion: NODE_ENVELOPE_VERSION, jobId, percent, note });
      },
      stream(item) {
        sequence += 1;
        send({ kind: "stream", envelopeVersion: NODE_ENVELOPE_VERSION, jobId, sequence, item });
      },
      delta(itemId, text) {
        send({
          kind: "delta",
          envelopeVersion: NODE_ENVELOPE_VERSION,
          jobId,
          delta: { itemId, text },
        });
      },
      ask(ask) {
        if (controller.signal.aborted) {
          return Promise.reject(new AdapterRefused("job was cancelled"));
        }

        const askId = ids.nextId();

        return new Promise<RuntimeAnswer>((resolve, reject) => {
          asks.set(askId, { resolve, reject });
          send({
            kind: "ask",
            envelopeVersion: NODE_ENVELOPE_VERSION,
            jobId,
            ask: { ...ask, askId },
          });
        });
      },
    };

    try {
      const adapter = adapters[assignment.capability];

      if (adapter === undefined) {
        throw new AdapterRefused(`no adapter for ${assignment.capability}`);
      }

      const evidence = await adapter(assignment.payload, context);

      send({
        kind: "result",
        envelopeVersion: NODE_ENVELOPE_VERSION,
        jobId: assignment.jobId,
        outcome: "succeeded",
        evidence,
      });
    } catch (error) {
      // A refusal and a crash are both failures to the core, and both carry a
      // reason. What the core must never receive is silence: that would hold the
      // lease until it lapses for no reason anyone can read.
      send({
        kind: "result",
        envelopeVersion: NODE_ENVELOPE_VERSION,
        jobId: assignment.jobId,
        outcome: "failed",
        evidence: null,
        failureReason: (error instanceof Error ? error.message : "unknown").slice(0, 500),
      });
    } finally {
      running.delete(jobId);
      pendingAsks.delete(jobId);
    }
  }

  function onAnswer(jobId: string, answer: RuntimeAnswer): void {
    const pending = pendingAsks.get(jobId)?.get(answer.askId);

    if (pending === undefined) {
      log("warn", "answer for an ask this node is not waiting on", { jobId, askId: answer.askId });
      return;
    }

    pendingAsks.get(jobId)?.delete(answer.askId);
    pending.resolve(answer);
  }

  function onJob(assignmentJson: string, signature: string): void {
    if (sessionCredential === undefined) {
      log("warn", "job arrived before welcome");
      return;
    }

    if (!verifySignature(sessionCredential, assignmentJson, signature)) {
      // Not executed and not reported. Something that cannot sign for this node
      // does not get to make the node act, or to learn that it tried.
      log("warn", "rejected an unsigned job frame");
      return;
    }

    let assignment: NodeJobAssignment;

    try {
      assignment = NodeJobAssignmentSchema.parse(JSON.parse(assignmentJson));
    } catch {
      log("warn", "rejected a malformed job assignment");
      return;
    }

    if (assignment.nodeId !== credential.nodeId) {
      log("warn", "rejected a job addressed to another node", { jobId: assignment.jobId });
      return;
    }

    if (Date.parse(assignment.leaseExpiresAt) <= Date.now()) {
      // The lease is the authorisation. Running past it risks doing work the
      // core has already given to somebody else.
      log("warn", "rejected a job whose lease had already expired", { jobId: assignment.jobId });
      return;
    }

    const granted = grants.some(
      (grant) => grant.capability === assignment.capability && grant.revokedAt === undefined,
    );

    if (!granted) {
      log("warn", "rejected a job for an ungranted capability", {
        jobId: assignment.jobId,
        capability: assignment.capability,
      });
      send({
        kind: "result",
        envelopeVersion: NODE_ENVELOPE_VERSION,
        jobId: assignment.jobId,
        outcome: "failed",
        evidence: null,
        failureReason: `capability ${assignment.capability} is not granted to this node`,
      });
      return;
    }

    void execute(assignment);
  }

  function scheduleReconnect(): void {
    if (stopped || options.reconnect === false) {
      return;
    }

    // Exponential with jitter. Without the jitter a fleet of nodes that lost the
    // core all come back in the same millisecond, repeatedly.
    const ceiling = Math.min(maxBackoff, initialBackoff * 2 ** Math.min(attempt, 16));
    const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));

    attempt += 1;
    // Deliberately *not* unref'd. Once the socket has gone this timer is the
    // only thing keeping the process alive, and a worker whose process exits
    // cleanly while it waits to reconnect is a worker that is gone for good —
    // exit 0 reads as success to whatever started it. `close()` clears it.
    retry = setTimeout(connect, delay);

    log("debug", "scheduled reconnect", { delay, attempt });
  }

  function connect(): void {
    if (stopped) {
      return;
    }

    const ws = new WebSocket(socketUrl(credential.coreUrl), {
      headers: { authorization: `Bearer ${credential.nodeId}.${credential.credential}` },
    });

    socket = ws;

    ws.on("open", () => {
      send({
        kind: "hello",
        envelopeVersion: NODE_ENVELOPE_VERSION,
        agentVersion,
        capabilities: Object.keys(adapters) as NodeJobAssignment["capability"][],
        providers,
      });
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        return;
      }

      let parsed;

      try {
        parsed = NodeServerFrameSchema.safeParse(JSON.parse(data.toString("utf8")));
      } catch {
        log("warn", "core frame is not valid JSON");
        return;
      }

      if (!parsed.success) {
        log("warn", "core frame does not match the node protocol");
        return;
      }

      const frame = parsed.data;

      switch (frame.kind) {
        case "welcome": {
          sessionCredential = frame.credential;
          grants = frame.grants;
          attempt = 0;

          const next: NodeCredential = {
            coreUrl: credential.coreUrl,
            nodeId: frame.nodeId,
            generation: frame.generation,
            credential: frame.credential,
          };

          credential = next;

          try {
            options.saveCredential(next);
          } catch (error) {
            // The previous generation still works, so this costs a reconnect at
            // worst. Losing the connection over it would cost more.
            log("warn", "could not persist the rotated credential", {
              reason: error instanceof Error ? error.message : "unknown",
            });
          }

          log("info", "connected", {
            nodeId: frame.nodeId,
            granted: frame.grants.map((grant) => grant.capability),
          });
          return;
        }
        case "job":
          onJob(frame.assignment, frame.signature);
          return;
        case "cancel":
          running.get(frame.jobId)?.abort();
          return;
        case "answer":
          onAnswer(frame.jobId, frame.answer);
          return;
      }
    });

    ws.on("close", () => {
      sessionCredential = undefined;
      grants = [];

      for (const jobId of running.keys()) {
        rejectAsks(jobId, "disconnected");
      }

      for (const controller of running.values()) {
        controller.abort();
      }

      running.clear();

      if (socket === ws) {
        socket = undefined;
      }

      scheduleReconnect();
    });

    ws.on("error", (error: Error) => {
      log("warn", "socket error", { reason: error.message });
    });
  }

  // Probed once, before the first hello, so the core never sees a node that
  // has not yet found out what it can run. A probe that fails reports nothing
  // rather than something.
  void probes()
    .catch((error: unknown) => {
      log("warn", "runtime probe failed", {
        reason: error instanceof Error ? error.message : "unknown",
      });

      return [];
    })
    .then((probed) => {
      providers = probed;
      connect();
    });

  return {
    close() {
      stopped = true;

      if (retry !== undefined) {
        clearTimeout(retry);
        retry = undefined;
      }

      for (const controller of running.values()) {
        controller.abort();
      }

      running.clear();
      socket?.close(1000, "agent stopping");
    },
    attempts() {
      return attempt;
    },
    connected() {
      return sessionCredential !== undefined;
    },
  };
}
