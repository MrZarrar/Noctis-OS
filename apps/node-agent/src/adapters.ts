import { readdir, realpath, stat } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import type { CapabilityGrant, NodeCapability } from "@noctis/contracts";
import {
  EnvironmentInspectPayloadSchema,
  FileSearchConstraintsSchema,
  FileSearchPayloadSchema,
  VerificationNoopPayloadSchema,
} from "@noctis/contracts";

/** The node refused the job itself. Reported to the core as a failure, not a crash. */
export class AdapterRefused extends Error {}

export interface AdapterContext {
  /** Only the grants the core sent in `welcome`. The node trusts nothing else. */
  grants: readonly CapabilityGrant[];
  signal: AbortSignal;
  progress(percent: number, note: string): void;
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
 * Every capability this agent can execute. A job naming anything else is refused
 * before it runs, so the set of things a node can do is this object, not whatever
 * the core happens to send.
 */
export const ADAPTERS: Readonly<Record<NodeCapability, Adapter>> = {
  "environment.inspect": environmentInspect,
  "file.search": fileSearch,
  "verification.noop": verificationNoop,
};
