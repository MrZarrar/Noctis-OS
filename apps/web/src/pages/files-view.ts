/**
 * What the Files page decides without a browser: how a file opens, and how a
 * place is named to the core. The core serves by the same extensions
 * (`apps/core/src/files/gateway.ts`); this only picks the element to show it in.
 */

export type ViewerKind = "image" | "video" | "audio" | "text" | "download";

/** Past this a text file is a download: the page would hold all of it. */
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

const KINDS: Readonly<Record<string, ViewerKind>> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  mp4: "video",
  m4v: "video",
  webm: "video",
  mov: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
};

const TEXT = new Set(
  "md txt log csv tsv json jsonl yaml yml toml ini srt vtt py js mjs ts tsx jsx css html htm xml svg sh ps1 bat".split(
    " ",
  ),
);

export function viewerKind(name: string, sizeBytes: number): ViewerKind {
  const dot = name.lastIndexOf(".");
  const extension = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();

  if (TEXT.has(extension)) {
    return sizeBytes <= MAX_TEXT_PREVIEW_BYTES ? "text" : "download";
  }

  return KINDS[extension] ?? "download";
}

export function childPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

export function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");

  return slash === -1 ? "" : path.slice(0, slash);
}

/** A file to open in Files: which shared folder, and where in it. */
export interface FileTarget<Root = { nodeId: string; grantId: string; path: string }> {
  root: Root;
  relativePath: string;
}

/**
 * The shared folder a path an agent reported is in, on the PC that reported
 * it, and the path inside it — or undefined, so a file outside every shared
 * folder is never offered as something Files can open. Windows paths compare
 * without case and with either slash, as Windows itself does.
 */
export function locateInRoots<Root extends { nodeId: string; grantId: string; path: string }>(
  path: string,
  nodeId: string,
  roots: readonly Root[],
): FileTarget<Root> | undefined {
  const slashed = path.replaceAll("\\", "/");

  for (const root of roots) {
    if (root.nodeId !== nodeId) {
      continue;
    }

    const windows = /^[A-Za-z]:\//.test(root.path.replaceAll("\\", "/"));
    const prefix = `${root.path.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
    const fold = (value: string): string => (windows ? value.toLowerCase() : value);

    if (slashed.length > prefix.length && fold(slashed).startsWith(fold(prefix))) {
      return { root, relativePath: slashed.slice(prefix.length) };
    }
  }

  return undefined;
}

export function filesQuery(place: { nodeId: string; grantId: string }, path: string): string {
  return new URLSearchParams({ node: place.nodeId, root: place.grantId, path }).toString();
}
