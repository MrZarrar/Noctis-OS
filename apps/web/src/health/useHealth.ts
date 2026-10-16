import type { HealthStatus } from "@noctis/contracts";
import { HealthStatusSchema } from "@noctis/contracts";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import type { CoreTransport } from "../transport/CoreTransport.js";

const HeadSchema = z.object({ latestSequence: z.number() }).loose();

/** The Health page's data: `GET /glucose`, re-read whenever a health job moves. */
export function useHealth(transport: CoreTransport | undefined) {
  const [status, setStatus] = useState<HealthStatus>();
  const [error, setError] = useState<string>();

  const read = useCallback(async () => {
    if (transport === undefined) return;
    const parsed = HealthStatusSchema.safeParse(
      (await transport.request("GET", "/glucose").catch(() => undefined))?.body,
    );
    if (parsed.success) setStatus(parsed.data);
  }, [transport]);

  useEffect(() => {
    if (transport === undefined) return;
    let live = true;
    let close: (() => void) | undefined;
    void (async () => {
      const head = HeadSchema.safeParse(
        (await transport.request("GET", "/events?after=0&limit=1").catch(() => undefined))?.body,
      );
      const opened = await transport
        .subscribe({
          afterSequence: head.success ? head.data.latestSequence : 0,
          onEvent: (event) => {
            const capability = (event.payload as { capability?: string } | undefined)?.capability;
            if (event.type.startsWith("node.job") && capability?.startsWith("health.")) void read();
          },
        })
        .catch(() => undefined);
      if (!live) return opened?.close();
      close = () => opened?.close();
      await read();
    })();
    return () => {
      live = false;
      close?.();
    };
  }, [transport, read]);

  const command = useCallback(
    async (name: string, body: Record<string, unknown> = {}) => {
      if (transport === undefined) return;
      setError(undefined);
      const response = await transport
        .request("POST", `/commands/${name}`, { idempotencyKey: crypto.randomUUID(), ...body })
        .catch(() => undefined);
      if (response?.status !== 200)
        setError(
          response === undefined ? "Noctis could not reach the core." : refusal(response.body),
        );
      await read();
    },
    [transport, read],
  );

  return {
    status,
    error,
    refresh: () => command("health.refresh"),
    runNow: () => command("health.run_now"),
    decide: (id: string, action: "mark-applied" | "dismiss" | "reset") =>
      command("health.decide", { id, action }),
  };
}

function refusal(body: unknown): string {
  const reason = (body as { error?: { details?: { reason?: string } } })?.error?.details?.reason;
  if (reason === "run_in_progress") return "glycolens is running; try again when it finishes.";
  if (reason === "pc_offline") return "The home PC is offline.";
  if (reason === "busy") return "glycolens is busy.";
  if (reason === "not_allowed") return "Health is not allowed on any PC yet.";
  return "The core refused.";
}
