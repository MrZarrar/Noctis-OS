import { useEffect, useState } from "react";
import type { MediaPayload, SurfaceSize } from "@noctis/contracts";
import { MediaSurface } from "@noctis/ui";

import { Skeleton } from "../layout/Page.js";

/**
 * Accepted bytes of a file-backed image, kept per panel. The core serves files
 * `no-store` and keeps no old versions, so a remounted `<img>` (pop-out, Return,
 * region move) would otherwise fetch a rewritten file's new bytes while its
 * "Use new version" offer is still pending.
 */
export type FileImageCache = Map<string, { key: string; url: string }>;
// ponytail: images only, and bounded; video and audio keep streaming from the live URL.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function releaseFileImage(cache: FileImageCache, id: string): void {
  const entry = cache.get(id);
  if (entry !== undefined) URL.revokeObjectURL(entry.url);
  cache.delete(id);
}

export function clearFileImages(cache: FileImageCache): void {
  for (const id of [...cache.keys()]) releaseFileImage(cache, id);
}

export function FileMedia({
  payload,
  url,
  size,
  retained,
}: {
  payload: MediaPayload;
  url: string | undefined;
  size: SurfaceSize;
  retained: { cache: FileImageCache; surfaceId: string };
}): JSX.Element {
  const { cache, surfaceId } = retained;
  const key = JSON.stringify([url, surfaceId]);
  const [, refresh] = useState(0);
  const [failed, setFailed] = useState<string>();
  const saved = cache.get(surfaceId);
  const current = saved?.key === key ? saved.url : undefined;
  useEffect(() => {
    if (url === undefined || current !== undefined) return;
    const controller = new AbortController();
    setFailed(undefined);
    void fetch(url, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (!response.ok || declared > MAX_IMAGE_BYTES)
          throw new Error("This image cannot be kept for the panel");
        const blob = await response.blob();
        if (blob.size > MAX_IMAGE_BYTES || !blob.type.startsWith("image/"))
          throw new Error("This image cannot be kept for the panel");
        if (controller.signal.aborted) return;
        releaseFileImage(cache, surfaceId);
        cache.set(surfaceId, { key, url: URL.createObjectURL(blob) });
        refresh((count) => count + 1);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFailed(error instanceof Error ? error.message : "Could not open this image");
      });
    return () => controller.abort();
  }, [cache, surfaceId, url, key, current]);
  if (failed !== undefined && current === undefined)
    // Degrades to the live file rather than hiding it; acceptance is then not enforced.
    return (
      <MediaSurface title={payload.title} mediaType={payload.mediaType} url={url} size={size} />
    );
  if (current === undefined) return <Skeleton label="Opening…" lines={1} lineHeight={180} />;
  return (
    <MediaSurface title={payload.title} mediaType={payload.mediaType} url={current} size={size} />
  );
}
