import type { Readable } from "node:stream";

import type {
  ExternalSession,
  FileListEvidence,
  NodeCapability,
  OrchestrationEvent,
  RuntimeProviderId,
  SessionExchange,
} from "@noctis/contracts";
import { CAPABILITY_CONTRACTS } from "@noctis/contracts";

import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import type { Dispatcher } from "../nodes/dispatch.js";
import type { NodeJobRecord } from "../nodes/jobs.js";
import { enqueueJobInTransaction, getJob } from "../nodes/jobs.js";
import { sharedFolder } from "../nodes/registry.js";

/**
 * The owner opening files on a PC (v1 S4).
 *
 * Every listing and every byte range is a job on the node that holds the
 * folder, so it runs through the same ledger, authority check and signed
 * assignment as any other work. The bytes do not go in the ledger: the node
 * streams them to `POST /node/files` for its job, and that stream is handed
 * straight to the browser that asked. Nothing is stored on the core, which is
 * what lets a film of any size play from a phone.
 */

/**
 * The one range a `Range` header asks for, or undefined for the whole file.
 * Only `bytes=a-` and `bytes=a-b`: what a video element sends. A suffix or a
 * multi-range is answered with the whole file and a 200, which HTTP allows.
 */
export function parseRange(
  header: string | undefined,
): { offset: number; length?: number } | undefined {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header ?? "");

  if (match === null) {
    return undefined;
  }

  const offset = Number(match[1]);

  if (match[2] === "") {
    return { offset };
  }

  const end = Number(match[2]);

  return end < offset ? undefined : { offset, length: end - offset + 1 };
}

/**
 * What a file is served as, by extension. Text the owner reads (scripts,
 * notes, code, even HTML) is `text/plain`, so nothing a node holds can run as
 * a page in the owner's browser; anything unnamed is a download.
 */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

const TEXT_EXTENSIONS = new Set(
  "txt log csv tsv json jsonl yaml yml toml ini srt vtt py js mjs ts tsx jsx css html htm xml svg sh ps1 bat".split(
    " ",
  ),
);

export function fileMediaType(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();

  return (
    MEDIA_TYPES[extension] ??
    (TEXT_EXTENSIONS.has(extension) ? "text/plain; charset=utf-8" : "application/octet-stream")
  );
}

/** Why a file could not be opened, with the HTTP status that says so. */
export class FileUnavailable extends Error {
  constructor(
    readonly status: 404 | 503 | 504,
    message: string,
  ) {
    super(message);
  }
}

/** How long a node gets to start answering. A stream in progress renews its own lease. */
export const FILE_ANSWER_MS = 20_000;

export interface FileLocation {
  nodeId: string;
  rootGrantId: string;
  relativePath: string;
}

/** One range of a file, flowing from the node. */
export interface OpenedFile {
  sizeBytes: number;
  offset: number;
  length: number;
  body: Readable;
}

interface Waiting {
  nodeId: string;
  capability: NodeCapability;
  resolve(value: unknown): void;
  reject(reason: FileUnavailable): void;
}

export interface FileGateway {
  list(context: CommandContext, at: FileLocation): Promise<FileListEvidence>;
  /** The agent sessions a shared folder has: what the owner can pick up and continue. */
  sessions(
    context: CommandContext,
    at: { nodeId: string; rootGrantId: string },
  ): Promise<{ sessions: ExternalSession[] }>;
  /** One of those sessions' last exchanges: what was said before Noctis picked it up. */
  history(
    context: CommandContext,
    at: { nodeId: string; rootGrantId: string; providerId: RuntimeProviderId; sessionRef: string },
  ): Promise<{ exchanges: SessionExchange[] }>;
  open(
    context: CommandContext,
    at: FileLocation & { offset: number; length?: number },
  ): Promise<OpenedFile>;
  /**
   * A node's stream for a `file.read` job it holds. Resolves when the browser
   * has taken all of it or gone away; false when nobody is waiting for it.
   */
  accept(nodeId: string, jobId: string, file: OpenedFile): Promise<boolean>;
  close(): void;
}

export function createFileGateway(deps: { kernel: Kernel; dispatcher: Dispatcher }): FileGateway {
  const { kernel, dispatcher } = deps;
  const waiting = new Map<string, Waiting>();

  function settle(jobId: string): Waiting | undefined {
    const entry = waiting.get(jobId);

    waiting.delete(jobId);

    return entry;
  }

  // A failed job is how a node says "no such file"; a listing's evidence is
  // its answer. A read's success arrives after its stream, so it is ignored.
  // ponytail: sessions ride the same gateway as files, since both are "ask the
  // node about a shared folder". Rename it the day a third kind of question does.
  function onEvents(events: readonly OrchestrationEvent[]): void {
    for (const event of events) {
      if (event.type !== "node.job_result.v1" || !waiting.has(event.streamId)) {
        continue;
      }

      const payload = event.payload as {
        outcome?: string;
        evidence?: unknown;
        failureReason?: string;
      };
      const entry = waiting.get(event.streamId);

      if (payload.outcome === "failed") {
        settle(event.streamId)?.reject(
          new FileUnavailable(404, payload.failureReason ?? "the PC could not open that"),
        );
      } else if (entry !== undefined && entry.capability !== "file.read") {
        settle(event.streamId)?.resolve(
          CAPABILITY_CONTRACTS[entry.capability].evidence.parse(payload.evidence),
        );
      }
    }
  }

  const unsubscribe = kernel.broker.subscribe(onEvents);

  function run<T>(
    context: CommandContext,
    capability: "file.list" | "file.read" | "session.list" | "session.history",
    at: { nodeId: string; rootGrantId: string },
    payload: Record<string, unknown>,
  ): Promise<T> {
    const node = sharedFolder(kernel.db, at.nodeId, at.rootGrantId, kernel.clock.now());

    if (node === undefined) {
      return Promise.reject(new FileUnavailable(404, "That PC shares no such folder"));
    }

    if (!dispatcher.isConnected(at.nodeId)) {
      return Promise.reject(new FileUnavailable(503, `${node.hostId} is offline`));
    }

    const jobId = kernel.ids.nextId();
    const enqueued = runCommand<NodeJobRecord>(
      kernel,
      { scope: "node.job_enqueue", key: `files:${jobId}`, resultId: jobId },
      (tx) =>
        enqueueJobInTransaction(tx, kernel, context, {
          id: jobId,
          capability,
          payload: { rootGrantId: at.rootGrantId, ...payload },
          idempotencyKey: `files:${jobId}`,
          pinnedNodeId: at.nodeId,
        }),
    );

    if (!enqueued.ok) {
      return Promise.reject(
        new FileUnavailable(503, `could not ask the PC (${enqueued.conflict.kind})`),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(jobId)?.reject(new FileUnavailable(504, `${node.hostId} did not answer`));
      }, FILE_ANSWER_MS);

      timer.unref();
      waiting.set(jobId, {
        nodeId: at.nodeId,
        capability,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      // Post-commit, as the conversation service does: the frame must never
      // describe a row a rollback erased.
      dispatcher.pass();
    });
  }

  return {
    list: (context, at) =>
      run<FileListEvidence>(context, "file.list", at, { relativePath: at.relativePath }),
    sessions: (context, at) => run(context, "session.list", at, {}),
    history: (context, at) =>
      run(context, "session.history", at, {
        providerId: at.providerId,
        sessionRef: at.sessionRef,
      }),
    open: (context, at) =>
      run<OpenedFile>(context, "file.read", at, {
        relativePath: at.relativePath,
        offset: at.offset,
        ...(at.length === undefined ? {} : { length: at.length }),
      }),
    accept(nodeId, jobId, file) {
      const entry = waiting.get(jobId);

      if (
        entry?.capability !== "file.read" ||
        entry.nodeId !== nodeId ||
        getJob(kernel.db, jobId)?.job.nodeId !== nodeId
      ) {
        return Promise.resolve(false);
      }

      settle(jobId)?.resolve(file);

      return new Promise<boolean>((resolve) => {
        file.body.once("end", () => resolve(true));
        file.body.once("close", () => resolve(true));
      });
    },
    close() {
      unsubscribe();

      for (const jobId of [...waiting.keys()]) {
        settle(jobId)?.reject(new FileUnavailable(503, "the core is shutting down"));
      }
    },
  };
}
