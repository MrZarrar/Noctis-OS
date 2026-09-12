import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { CapabilityGrant, RuntimeRoot } from "@noctis/contracts";
import { RuntimeGrantConstraintsSchema } from "@noctis/contracts";

import type { ResolvedRoots } from "./Runtime.js";
import { AdapterRefused } from "./Runtime.js";

/**
 * The roots a turn may touch, as real paths.
 *
 * Only a live `runtime.turn` grant contributes a root, and every root goes
 * through `realpath` before it is handed to a runtime: a junction under a
 * granted folder points wherever it likes, and a sandbox told to trust the
 * nominal path would trust the target too (the Phase 3 lesson in adapters.ts).
 */
export async function resolveRoots(
  grants: readonly CapabilityGrant[],
  primaryRootGrantId: string,
): Promise<ResolvedRoots> {
  const granted: RuntimeRoot[] = [];

  for (const grant of grants) {
    if (grant.capability !== "runtime.turn" || grant.revokedAt !== undefined) {
      continue;
    }

    const parsed = RuntimeGrantConstraintsSchema.safeParse(grant.constraints);

    if (parsed.success) {
      granted.push(...parsed.data.roots);
    }
  }

  if (!granted.some((root) => root.grantId === primaryRootGrantId)) {
    throw new AdapterRefused(`no granted runtime root ${primaryRootGrantId}`);
  }

  const roots: Array<{ root: RuntimeRoot; real: string }> = [];

  for (const root of granted) {
    try {
      roots.push({ root, real: await realpath(resolve(root.path)) });
    } catch {
      throw new AdapterRefused(`granted root ${root.grantId} does not exist on this node`);
    }
  }

  const primary = roots.find(({ root }) => root.grantId === primaryRootGrantId);

  if (primary === undefined) {
    throw new AdapterRefused(`no granted runtime root ${primaryRootGrantId}`);
  }

  return {
    cwd: primary.real,
    writable: roots.filter(({ root }) => root.mode === "write").map(({ real }) => real),
    readable: roots.filter(({ root }) => root.mode === "read").map(({ real }) => real),
    localOnly: granted.some((root) => root.localOnly),
  };
}
