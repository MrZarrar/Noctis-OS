/** The folders a PC shares with its agents, kept out of the page so it can be tested without one. */

import type { RuntimeGrantConstraints, RuntimeProviderId, RuntimeRoot } from "@noctis/contracts";
import { RUNTIME_PROVIDERS, RuntimeRootSchema } from "@noctis/contracts";

export interface GrantView {
  capability: string;
  constraints?: unknown;
  revokedAt?: string | undefined;
  expiresAt?: string | undefined;
}

export type SharedFolder = Pick<RuntimeRoot, "grantId" | "path" | "mode">;

/** Each live folder once, in the order it was granted. */
export function sharedFolders(grants: readonly GrantView[], now: number): SharedFolder[] {
  const folders = new Map<string, SharedFolder>();

  for (const grant of grants) {
    if (
      grant.capability !== "runtime.turn" ||
      grant.revokedAt !== undefined ||
      (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now)
    ) {
      continue;
    }

    const roots = (grant.constraints as { roots?: unknown } | undefined)?.roots;

    for (const raw of Array.isArray(roots) ? roots : []) {
      const root = RuntimeRootSchema.safeParse(raw);

      if (root.success && !folders.has(root.data.grantId)) {
        folders.set(root.data.grantId, {
          grantId: root.data.grantId,
          path: root.data.path,
          mode: root.data.mode,
        });
      }
    }
  }

  return [...folders.values()];
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/;

/**
 * One folder as a new `runtime.turn` grant, or undefined for a path that is
 * not absolute. The id is the folder's own name, so the composer's picker
 * reads as the folder; the PC checks the path exists when a turn uses it.
 */
export function folderGrant(input: {
  path: string;
  mode: RuntimeRoot["mode"];
  providers: readonly RuntimeProviderId[];
  taken: readonly string[];
}): RuntimeGrantConstraints | undefined {
  // Explorer's "Copy as path" wraps the path in quotes.
  let path = input.path
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();

  if (!ABSOLUTE.test(path)) {
    return undefined;
  }

  // A drive's root keeps its separator; anything else loses a trailing one.
  if (!/^[A-Za-z]:[\\/]$/.test(path) && path !== "/") {
    path = path.replace(/[\\/]+$/, "");
  }

  const name =
    (path.split(/[\\/]/).at(-1) ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "folder";
  let grantId = name;

  for (let n = 2; input.taken.includes(grantId); n += 1) {
    grantId = `${name}-${String(n)}`;
  }

  return {
    providers: input.providers.length === 0 ? [...RUNTIME_PROVIDERS] : [...input.providers],
    roots: [{ grantId, path, mode: input.mode, localOnly: false }],
  };
}
