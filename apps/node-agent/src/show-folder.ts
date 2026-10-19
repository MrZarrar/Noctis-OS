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
/** Screenshots an options panel shows: served from the show folder, never opened as panels of their own. */
export const SHOTS_FOLDER = ".shots";

/** A file is reported once its writes have stopped for this long. */
const QUIET_MS = 300;
/** ponytail: a fixed cap per turn; a smarter limit if a real turn ever needs more. */
const MAX_SHOWN = 100;

/**
 * Watches `cwd` for files saved under the show folder, including a show folder
 * created after the watch starts. Returns the stop. A folder that cannot be
 * watched is not an error: the turn runs without it.
 */
export function watchShowFolder(
  cwd: string,
  onFile: (path: string) => void,
  onRemoved: (path: string) => void = () => undefined,
): () => void {
  const pending = new Map<string, NodeJS.Timeout>();
  const shownPaths = new Set<string>();
  let shown = 0;
  let watcher: ReturnType<typeof watch>;

  try {
    watcher = watch(cwd, { recursive: true }, (_event, name) => {
      if (name === null || !`${name}`.startsWith(`${SHOW_FOLDER}${sep}`)) return;
      if (
        `${name}`
          .split(sep)
          .slice(1, -1)
          .some((part) => part.startsWith("."))
      )
        return;

      const path = join(cwd, `${name}`);
      clearTimeout(pending.get(path));
      pending.set(
        path,
        setTimeout(() => {
          pending.delete(path);
          let isFile: boolean;
          try {
            isFile = statSync(path).isFile();
          } catch {
            // Gone: a panel showing it would be empty, so it closes.
            if (shownPaths.delete(path)) onRemoved(path);
            return;
          }
          if (!isFile || panelKind(path) === undefined) return;
          if (!shownPaths.has(path)) {
            if (shown >= MAX_SHOWN) return;
            shown += 1;
            shownPaths.add(path);
          }
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

/**
 * The panel a file in the show folder opens as, or undefined for anything that
 * is not meant to be looked at. Code is how a figure was made, so a build
 * script saved beside its page stays out of the way.
 */
function panelKind(path: string): "visual" | "document" | "media" | undefined {
  const name = basename(path);
  if (/\.(?:html?|svg)$/i.test(name)) return "visual";
  if (/\.(?:md|txt)$/i.test(name)) return "document";
  const viewer = viewerKind(name, 0);
  return viewer === "image" || viewer === "video" || viewer === "audio" ? "media" : undefined;
}

function surfaceItem(path: string, index: number, withdrawn: boolean): RuntimeItem | undefined {
  const surfaceKind = panelKind(path);

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
      payload: { title: basename(path).slice(0, 200), path },
      ...(withdrawn ? { withdrawn: true as const } : {}),
    },
  };
}

/** The panel a shown file opens as, proposed by its path like any other. */
export function showItem(path: string, index: number): RuntimeItem | undefined {
  return surfaceItem(path, index, false);
}

/** Closes the panel a deleted file had. */
export function withdrawItem(path: string, index: number): RuntimeItem | undefined {
  return surfaceItem(path, index, true);
}
