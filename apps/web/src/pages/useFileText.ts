import { useEffect, useState } from "react";
import { z } from "zod";
import { MAX_TEXT_PREVIEW_BYTES } from "@noctis/domain";
import type { CoreTransport } from "../transport/CoreTransport.js";

const PreviewSchema = z
  .object({ text: z.string().max(MAX_TEXT_PREVIEW_BYTES), truncated: z.boolean() })
  .strict();
export async function readFileText(
  transport: CoreTransport,
  path: string,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const response = await transport.request("GET", `${path}&preview=1`, undefined, { signal });
  signal.throwIfAborted();
  if (response.status !== 200) {
    const body = response.body as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Could not open this file (${response.status})`);
  }
  const parsed = PreviewSchema.safeParse(response.body);
  if (!parsed.success) throw new Error("The core returned an invalid text preview");
  return parsed.data;
}

interface FileTextState {
  transport: CoreTransport;
  key: string;
  revision: string;
  text?: string;
  truncated?: boolean;
  error?: string | undefined;
  loading: boolean;
}
export type FileTextCache = Map<string, FileTextState>;

/** Keep last good text for this owner/file, while refusing late responses from another one. */
export function useFileText(
  transport: CoreTransport | undefined,
  path: string | undefined,
  revision = "",
  owner = "",
  retained?: { cache: FileTextCache; surfaceId: string },
) {
  const cache = retained?.cache;
  const cacheId = retained?.surfaceId;
  const key = JSON.stringify([owner, path, cacheId]);
  const cached = cacheId === undefined ? undefined : cache?.get(cacheId);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<FileTextState | undefined>(() =>
    cached?.key === key && cached.transport === transport ? cached : undefined,
  );
  useEffect(() => {
    if (transport === undefined || path === undefined) return;
    const saved = cacheId === undefined ? undefined : cache?.get(cacheId);
    if (
      attempt === 0 &&
      saved?.key === key &&
      saved.transport === transport &&
      saved.revision === revision
    ) {
      setState(saved);
      return;
    }
    const controller = new AbortController();
    setState((old) => ({
      ...(old?.key === key && old.transport === transport ? old : {}),
      transport,
      key,
      revision,
      loading: true,
      error: undefined,
    }));
    void readFileText(transport, path, controller.signal)
      .then((preview) => {
        if (!controller.signal.aborted) {
          const next = { transport, key, revision, ...preview, loading: false };
          if (cacheId !== undefined) cache?.set(cacheId, next);
          setState(next);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState((old) => {
            const next = {
              ...(old?.key === key && old.transport === transport ? old : {}),
              transport,
              key,
              revision,
              loading: false,
              error: error instanceof Error ? error.message : "The core did not answer",
            };
            if (!controller.signal.aborted && cacheId !== undefined) cache?.set(cacheId, next);
            return next;
          });
      });
    // Native proxy cannot abort Rust IPC; the signal still discards its late response.
    return () => controller.abort();
  }, [transport, path, key, revision, attempt, cache, cacheId]);
  const current =
    state?.key === key && state.transport === transport
      ? state
      : cached?.key === key && cached.transport === transport
        ? cached
        : undefined;
  return {
    text: current?.text,
    truncated: current?.truncated ?? false,
    error: current?.error,
    loading: current?.loading ?? path !== undefined,
    retry: () => setAttempt((value) => value + 1),
  };
}
