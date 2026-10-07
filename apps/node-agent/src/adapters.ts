import { readdir, realpath, stat } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import type {
  CapabilityGrant,
  NodeCapability,
  RuntimeAnswer,
  RuntimeAsk,
  RuntimeDelegation,
  RuntimeDelegationResult,
  RuntimeItem,
  RuntimeProviderId,
} from "@noctis/contracts";
import {
  EnvironmentInspectPayloadSchema,
  FileSearchConstraintsSchema,
  FileSearchPayloadSchema,
  RuntimeTurnEvidenceSchema,
  RuntimeTurnPayloadSchema,
  VerificationNoopPayloadSchema,
} from "@noctis/contracts";

import type { Runtime, RuntimeSink, RuntimeUpload } from "./runtimes/Runtime.js";
import { AdapterRefused } from "./runtimes/Runtime.js";
import { promptWithAttachments, stageAttachments } from "./runtimes/attachments.js";
import { childEnvironment } from "./runtimes/env.js";
import { resolveRoots } from "./runtimes/roots.js";

export { AdapterRefused };

export interface AdapterContext {
  /** Only the grants the core sent in `welcome`. The node trusts nothing else. */
  grants: readonly CapabilityGrant[];
  signal: AbortSignal;
  progress(percent: number, note: string): void;
  /** Mid-turn frames to the core. Items are persisted there; deltas are not. */
  stream(item: RuntimeItem): void;
  delta(itemId: string, text: string): void;
  /** Resolves when the core answers. The runtime cannot proceed until it does. */
  ask(ask: Omit<RuntimeAsk, "askId">): Promise<RuntimeAnswer>;
  /** The agent's own environment. Stripped of billing keys before any child sees it. */
  env: NodeJS.ProcessEnv;
  runtimes: Partial<Record<RuntimeProviderId, Runtime>>;
  /**
   * One attachment's bytes from the core, over HTTP with the node credential.
   *
   * A closure rather than the credential itself: an adapter that held the
   * credential could sign its own job assignments, and the only thing any of
   * them actually needs is the ability to fetch a file the core already named.
   */
  fetchAttachment(id: string): Promise<Uint8Array>;
  /** Hands work to another agent through the core; resolves when the child turn ends. */
  delegate(delegation: Omit<RuntimeDelegation, "delegationId">): Promise<RuntimeDelegationResult>;
  /** A file the turn made, given to the core for this job. Resolves to its attachment id. */
  uploadOutput(output: RuntimeUpload): Promise<string>;
}

export type Adapter = (payload: unknown, context: AdapterContext) => Promise<unknown>;

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AdapterRefused("job was cancelled");
  }
}

/**
 * Resolves an opaque root grant id to a real directory on this machine.
 *
 * The requester never names a path — only a grant id — so this is the only place
 * a path enters, and it can only come from a grant the core issued.
 */
async function resolveGrantedRoot(
  grantId: string,
  grants: readonly CapabilityGrant[],
): Promise<string> {
  for (const grant of grants) {
    if (grant.capability !== "file.search" || grant.revokedAt !== undefined) {
      continue;
    }

    const parsed = FileSearchConstraintsSchema.safeParse(grant.constraints);

    if (!parsed.success) {
      continue;
    }

    const root = parsed.data.roots.find((candidate) => candidate.grantId === grantId);

    if (root !== undefined) {
      // Resolved through its own symlinks first, so the containment test below
      // compares two real paths rather than one real and one nominal.
      return realpath(resolve(root.path));
    }
  }

  throw new AdapterRefused(`no granted file root ${grantId}`);
}

/**
 * Whether `candidate` is the root or genuinely inside it. Exported because it is
 * the second of the two containment guards, and a guard without its own test is
 * a guard nobody knows works.
 */
export function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

const environmentInspect: Adapter = async (payload) => {
  EnvironmentInspectPayloadSchema.parse(payload);

  return Promise.resolve({
    platform: platform(),
    arch: arch(),
    nodeVersion: process.version,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
  });
};

/**
 * A walk this size is a search; anything larger is a different feature.
 * ponytail: fixed budgets, not a resumable cursor. Add paging when a real grant
 * root turns out to be bigger than this rather than in anticipation of one.
 */
const MAX_ENTRIES_SCANNED = 20_000;
const MAX_DEPTH = 12;
const PROGRESS_EVERY = 500;

/**
 * Searches one granted root by filename substring.
 *
 * Two independent guards, because on Windows the two signals disagree. A
 * junction reports `isDirectory() === false, isSymbolicLink() === true`, and yet
 * Node's `readdir(..., { recursive: true })` walks straight through it — a
 * junction pointing at its own ancestor loops forever. So this walks explicitly
 * and never descends a reparse point, and every hit is still resolved with
 * `realpath` and checked to be inside the root. A symlink in a granted folder
 * pointing at `C:\Users\...\.ssh` is otherwise an ordinary directory entry, and
 * returning it would turn a grant over one folder into a grant over the disk.
 */
const fileSearch: Adapter = async (payload, context) => {
  const request = FileSearchPayloadSchema.parse(payload);
  const root = await resolveGrantedRoot(request.rootGrantId, context.grants);
  const needle = request.nameContains.toLowerCase();
  const matches: Array<{ relativePath: string; sizeBytes: number }> = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];

  let truncated = false;
  let scanned = 0;

  while (queue.length > 0) {
    const next = queue.shift();

    if (next === undefined) {
      break;
    }

    // Sorted so the same tree always produces the same evidence.
    const entries = (await readdir(next.directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );

    for (const entry of entries) {
      assertNotCancelled(context.signal);
      scanned += 1;

      if (scanned > MAX_ENTRIES_SCANNED) {
        truncated = true;
        queue.length = 0;
        break;
      }

      if (scanned % PROGRESS_EVERY === 0) {
        context.progress(
          Math.min(99, Math.floor((scanned / MAX_ENTRIES_SCANNED) * 100)),
          `scanned ${String(scanned)} entries`,
        );
      }

      // Explicit rather than load-bearing: withFileTypes uses lstat, so a link
      // to a directory already reports isDirectory() false and is never queued,
      // and a sabotage that deletes this line changes no test. It stays because
      // the alternative is that the containment story rests on a Dirent detail
      // nobody restates, and a later switch to stat() would start following
      // links silently. isInside below is the guard that actually holds.
      if (entry.isSymbolicLink()) {
        continue;
      }

      const full = join(next.directory, entry.name);

      if (entry.isDirectory()) {
        if (next.depth < MAX_DEPTH) {
          queue.push({ directory: full, depth: next.depth + 1 });
        }

        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().includes(needle)) {
        continue;
      }

      if (matches.length >= request.maxResults) {
        truncated = true;
        queue.length = 0;
        break;
      }

      let real: string;

      try {
        real = await realpath(full);
      } catch {
        // Vanished or unreadable between the listing and now. Not a match.
        continue;
      }

      if (!isInside(root, real)) {
        continue;
      }

      const info = await stat(real);

      matches.push({ relativePath: relative(root, full), sizeBytes: info.size });
    }
  }

  return { matches, truncated };
};

const verificationNoop: Adapter = async (payload, context) => {
  VerificationNoopPayloadSchema.parse(payload);
  assertNotCancelled(context.signal);

  return Promise.resolve({ verified: true });
};

/**
 * The lease heartbeat. An ask can wait minutes for a human, and the core
 * renews the lease on every frame, so a turn that is silent is a turn the core
 * will reclaim from under a runtime that is still working.
 */
export const TURN_HEARTBEAT_MS = 10_000;

/**
 * One conversational turn on a spawned runtime.
 *
 * The adapter owns nothing the runtime could misuse: roots arrive real, the
 * environment arrives stripped, and every ask goes to the core and comes back
 * as the core's answer. The runtime proposes; the frames decide.
 */
const runtimeTurn: Adapter = async (payload, context) => {
  const request = RuntimeTurnPayloadSchema.parse(payload);
  const roots = await resolveRoots(context.grants, request.primaryRootGrantId);
  const runtime = context.runtimes[request.model.providerId];

  if (runtime === undefined) {
    throw new AdapterRefused(`no runtime for ${request.model.providerId}`);
  }

  assertNotCancelled(context.signal);

  const sink: RuntimeSink = {
    item: (item) => context.stream(item),
    delta: (itemId, text) => context.delta(itemId, text),
    ask: (ask) => context.ask(ask),
    delegate: (delegation) => context.delegate(delegation),
    upload: (output) => context.uploadOutput(output),
  };

  // Staged before the runtime starts, so a turn whose files could not be
  // fetched fails saying so rather than answering about a file nobody has.
  const staged = await stageAttachments(request.attachments ?? [], (id) =>
    context.fetchAttachment(id),
  );
  const heartbeat = setInterval(() => context.progress(0, "turn in progress"), TURN_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    return RuntimeTurnEvidenceSchema.parse(
      await runtime.turn(
        {
          payload: {
            ...request,
            prompt: promptWithAttachments(request.prompt, staged.files),
          },
          // The temp directory joins the readable roots rather than the
          // writable ones. That is what makes the sandbox let the runtime open
          // the files — and what stops it treating the staging area as
          // somewhere it may write, which would make `classifyAsk` read a write
          // outside every granted root as an ordinary local edit.
          roots:
            staged.files.length === 0
              ? roots
              : { ...roots, readable: [...roots.readable, staged.directory] },
          env: childEnvironment(context.env),
          signal: context.signal,
        },
        sink,
      ),
    );
  } finally {
    clearInterval(heartbeat);
    await staged.discard();
  }
};

/**
 * Every capability this agent can execute. A job naming anything else is refused
 * before it runs, so the set of things a node can do is this object, not whatever
 * the core happens to send.
 */
export const ADAPTERS: Readonly<Record<NodeCapability, Adapter>> = {
  "environment.inspect": environmentInspect,
  "file.search": fileSearch,
  "verification.noop": verificationNoop,
  "runtime.turn": runtimeTurn,
};
