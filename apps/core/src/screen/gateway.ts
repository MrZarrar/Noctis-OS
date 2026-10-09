import type { Readable } from "node:stream";

import type { OrchestrationEvent, ScreenViewPayload } from "@noctis/contracts";
import { ScreenViewEvidenceSchema } from "@noctis/contracts";

import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import type { Dispatcher } from "../nodes/dispatch.js";
import type { NodeJobRecord } from "../nodes/jobs.js";
import { cancelJob, enqueueJobInTransaction, getJob } from "../nodes/jobs.js";
import { getNode, listGrants } from "../nodes/registry.js";

/**
 * The owner watching a PC's desktop.
 *
 * The same shape as opening a file: a `screen.view` job pinned to the PC, the
 * node streaming to `POST /node/files` for it, and that stream handed straight
 * to the browser that asked. The core stores no frame. The browser leaving
 * drops the node's upload, which is how the node knows to stop capturing.
 */

/** Why a mirror could not start, with the HTTP status that says so. */
export class ScreenUnavailable extends Error {
  constructor(
    readonly status: 403 | 404 | 423 | 503 | 504,
    readonly code: "not_granted" | "not_found" | "locked" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

/** How long a PC gets to start sending frames: a helper started on demand included. */
export const SCREEN_ANSWER_MS = 20_000;

/** How often an open mirror is checked against its grant and the viewer's session. */
export const SCREEN_RECHECK_MS = 5_000;

export interface ScreenUpload {
  /** ffmpeg's `multipart/x-mixed-replace` with its boundary, passed through as it came. */
  contentType: string;
  body: Readable;
}

export interface ScreenStream extends ScreenUpload {
  /** Cancels the job and tells the node, for a mirror whose authority has lapsed. */
  stop(): void;
}

interface Waiting {
  nodeId: string;
  resolve(stream: ScreenUpload): void;
  reject(reason: ScreenUnavailable): void;
}

export interface ScreenGateway {
  open(
    context: CommandContext,
    at: { nodeId: string } & ScreenViewPayload,
    signal?: AbortSignal,
  ): Promise<ScreenStream>;
  /**
   * A node's stream for a `screen.view` job it holds. Resolves when the stream
   * ends or the browser goes; false when nobody is waiting for it.
   */
  accept(nodeId: string, jobId: string, stream: ScreenUpload): Promise<boolean>;
  close(): void;
}

/** Whether the owner has let this PC be watched. Its own grant: sharing folders is not it. */
export function screenGranted(kernel: Kernel, nodeId: string): boolean {
  const now = kernel.clock.now();

  return listGrants(kernel.db, nodeId).some(
    (grant) =>
      grant.capability === "screen.view" &&
      grant.revokedAt === undefined &&
      (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now),
  );
}

export function createScreenGateway(deps: {
  kernel: Kernel;
  dispatcher: Dispatcher;
}): ScreenGateway {
  const { kernel, dispatcher } = deps;
  const waiting = new Map<string, Waiting>();

  function settle(jobId: string): Waiting | undefined {
    const entry = waiting.get(jobId);

    waiting.delete(jobId);

    return entry;
  }

  // A result before any stream is the PC saying it could not start: locked,
  // or no helper or ffmpeg to capture with.
  const unsubscribe = kernel.broker.subscribe((events: readonly OrchestrationEvent[]) => {
    for (const event of events) {
      if (event.type !== "node.job_result.v1" || !waiting.has(event.streamId)) {
        continue;
      }

      const payload = event.payload as { evidence?: unknown; failureReason?: string };
      const evidence = ScreenViewEvidenceSchema.safeParse(payload.evidence);

      settle(event.streamId)?.reject(
        evidence.success && evidence.data.endedBy === "locked"
          ? new ScreenUnavailable(423, "locked", "The PC is locked")
          : new ScreenUnavailable(
              503,
              "unavailable",
              payload.failureReason ?? "The PC stopped before sending a frame",
            ),
      );
    }
  });

  return {
    open(context, at, signal) {
      if (signal?.aborted === true) {
        return Promise.reject(new ScreenUnavailable(503, "unavailable", "The viewer left"));
      }

      const node = getNode(kernel.db, at.nodeId);

      if (node === undefined || node.status === "revoked") {
        return Promise.reject(new ScreenUnavailable(404, "not_found", "No such PC"));
      }

      if (!screenGranted(kernel, at.nodeId)) {
        return Promise.reject(
          new ScreenUnavailable(
            403,
            "not_granted",
            `${node.hostId} has not been allowed screen.view`,
          ),
        );
      }

      if (!dispatcher.isConnected(at.nodeId)) {
        return Promise.reject(
          new ScreenUnavailable(503, "unavailable", `${node.hostId} is offline`),
        );
      }

      const jobId = kernel.ids.nextId();
      const enqueued = runCommand<NodeJobRecord>(
        kernel,
        { scope: "node.job_enqueue", key: `screen:${jobId}`, resultId: jobId },
        (tx) =>
          enqueueJobInTransaction(tx, kernel, context, {
            id: jobId,
            capability: "screen.view",
            payload: { fps: at.fps, width: at.width },
            idempotencyKey: `screen:${jobId}`,
            pinnedNodeId: at.nodeId,
          }),
      );

      if (!enqueued.ok) {
        return Promise.reject(
          new ScreenUnavailable(
            503,
            "unavailable",
            `could not ask the PC (${enqueued.conflict.kind})`,
          ),
        );
      }

      return new Promise<ScreenStream>((resolve, reject) => {
        const stop = () => {
          const outcome = cancelJob(kernel, context, {
            jobId,
            idempotencyKey: `screen:${jobId}:cancel`,
          });

          if (outcome.ok && outcome.value.job.nodeId !== undefined) {
            dispatcher.sendCancel(outcome.value.job.nodeId, jobId);
          }
        };
        const cancel = (reason: ScreenUnavailable) => {
          const entry = settle(jobId);

          if (entry === undefined) return;

          stop();
          entry.reject(reason);
        };
        const abort = () => cancel(new ScreenUnavailable(503, "unavailable", "The viewer left"));
        const timer = setTimeout(
          () =>
            cancel(
              new ScreenUnavailable(504, "unavailable", `${node.hostId} did not start the mirror`),
            ),
          SCREEN_ANSWER_MS,
        );

        timer.unref();
        waiting.set(jobId, {
          nodeId: at.nodeId,
          resolve: (stream) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            resolve({ ...stream, stop });
          },
          reject: (reason) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(reason);
          },
        });
        signal?.addEventListener("abort", abort, { once: true });
        dispatcher.pass();
      });
    },
    accept(nodeId, jobId, stream) {
      const job = getJob(kernel.db, jobId)?.job;

      if (
        !screenGranted(kernel, nodeId) ||
        waiting.get(jobId)?.nodeId !== nodeId ||
        job?.nodeId !== nodeId ||
        (job.status !== "leased" && job.status !== "running") ||
        job.leaseExpiresAt === undefined ||
        Date.parse(job.leaseExpiresAt) <= kernel.clock.now()
      ) {
        return Promise.resolve(false);
      }

      settle(jobId)?.resolve(stream);

      return new Promise<boolean>((resolve) => {
        stream.body.once("end", () => resolve(true));
        stream.body.once("close", () => resolve(true));
      });
    },
    close() {
      unsubscribe();

      for (const jobId of [...waiting.keys()]) {
        settle(jobId)?.reject(
          new ScreenUnavailable(503, "unavailable", "the core is shutting down"),
        );
      }
    },
  };
}
