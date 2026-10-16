import { statSync, watch } from "node:fs";
import { basename, join, sep } from "node:path";

import type { RuntimeItem } from "@noctis/contracts";
import { viewerKind } from "@noctis/domain";

/**
 * A folder in the working folder where anything saved, by any means, opens as
 * a panel. Claude's own file tools already open what they write; a page built
 * by a script (an Anatomy figure) or a screenshot saved by a browser tool
 * reached Noctis only if the agent remembered to show it.
 */
export const SHOW_FOLDER = "noctis-show";

/** A file is reported once its writes have stopped for this long. */
const QUIET_MS = 300;
/** ponytail: a fixed cap per turn; a smarter limit if a real turn ever needs more. */
const MAX_SHOWN = 100;

/**
 * Watches `cwd` for files saved under the show folder, including a show folder
 * created after the watch starts. Returns the stop. A folder that cannot be
 * watched is not an error: the turn runs without it.
 */
export function watchShowFolder(cwd: string, onFile: (path: string) => void): () => void {
  const pending = new Map<string, NodeJS.Timeout>();
  let shown = 0;
  let watcher: ReturnType<typeof watch>;

  try {
    watcher = watch(cwd, { recursive: true }, (_event, name) => {
      if (name === null || !`${name}`.startsWith(`${SHOW_FOLDER}${sep}`)) return;

      const path = join(cwd, `${name}`);
      clearTimeout(pending.get(path));
      pending.set(
        path,
        setTimeout(() => {
          pending.delete(path);
          try {
            if (!statSync(path).isFile() || shown >= MAX_SHOWN) return;
          } catch {
            return;
          }
          shown += 1;
          onFile(path);
        }, QUIET_MS),
      );
    });
    watcher.on("error", () => watcher.close());
  } catch {
    return () => undefined;
  }

  return () => {
    watcher.close();
    pending.forEach(clearTimeout);
    pending.clear();
  };
}

/** The panel a shown file opens as, proposed by its path like any other. */
export function showItem(path: string, index: number): RuntimeItem | undefined {
  const title = basename(path).slice(0, 200);
  const viewer = viewerKind(title, 0);
  const surfaceKind = /\.(?:html?|svg)$/i.test(title)
    ? "visual"
    : viewer === "text"
      ? "document"
      : viewer === "image" || viewer === "video" || viewer === "audio"
        ? "media"
        : undefined;

  if (surfaceKind === undefined) {
    return undefined;
  }

  return {
    itemId: `show-${String(index)}`,
    kind: "proposal",
    status: "completed",
    proposal: {
      kind: "surface",
      surfaceKind,
      role: "primary",
      persistence: "restorable",
      priority: 30,
      payloadVersion: 1,
      payload: { title, path },
    },
  };
}
