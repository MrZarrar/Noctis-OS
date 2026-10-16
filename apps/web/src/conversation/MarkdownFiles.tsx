import { createContext } from "react";
import { locateInRoots } from "@noctis/domain";
import type { FileTarget } from "@noctis/domain";

import type { CoreTransport } from "../transport/CoreTransport.js";
import { filesQuery } from "../pages/files-view.js";

export type MarkdownImageUrl = (path: string) => string | undefined;

export const MarkdownFiles = createContext<MarkdownImageUrl | undefined>(undefined);

export function markdownImageUrl(
  path: string,
  roots: readonly FileTarget["root"][],
  transport: Pick<CoreTransport, "contentUrl"> | undefined,
): string | undefined {
  if (!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path)) return undefined;

  for (const nodeId of new Set(roots.map((root) => root.nodeId))) {
    const target = locateInRoots(path, nodeId, roots);
    if (target === undefined) continue;
    if (target.relativePath.includes("..")) return undefined;

    return transport?.contentUrl?.(
      `/files/content?${filesQuery(target.root, target.relativePath)}`,
    );
  }

  return undefined;
}
