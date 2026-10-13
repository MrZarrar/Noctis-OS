/**
 * What the Files page decides without a browser: how a file opens, and how a
 * place is named to the core. The core serves by the same extensions
 * (`apps/core/src/files/gateway.ts`); this only picks the element to show it in.
 */

export { viewerKind, MAX_TEXT_PREVIEW_BYTES, locateInRoots } from "@noctis/domain";
export type { ViewerKind, FileTarget } from "@noctis/domain";

export function childPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

export function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");

  return slash === -1 ? "" : path.slice(0, slash);
}

export function filesQuery(place: { nodeId: string; grantId: string }, path: string): string {
  return new URLSearchParams({ node: place.nodeId, root: place.grantId, path }).toString();
}
