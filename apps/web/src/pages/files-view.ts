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

export function filesQuery(place: { nodeId: string; grantId: string }, path: string): string {
  return new URLSearchParams({ node: place.nodeId, root: place.grantId, path }).toString();
}
