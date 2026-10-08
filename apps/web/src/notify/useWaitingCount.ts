import { useEffect, useState } from "react";

import { z } from "zod";

import { isWaiting } from "../pages/waiting.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

const ApprovalsSchema = z.object({
  approvals: z.array(
    z
      .object({
        outcome: z.string(),
        confirmedAt: z.string().optional(),
        executedAt: z.string().optional(),
        declinedAt: z.string().optional(),
        nodeJobId: z.string().optional(),
      })
      .loose(),
  ),
});
const HeadSchema = z.object({ latestSequence: z.int().nonnegative() }).loose();

/**
 * How many approvals wait on the owner, everywhere, for the Approvals tab.
 * Read once, then again whenever an authority event commits; the same rule
 * as the page itself (`isWaiting`), so the tab and the page never disagree.
 */
export function useWaitingCount(transport: CoreTransport | undefined): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let live = true;
    let close: (() => void) | undefined;

    const recount = async (): Promise<void> => {
      const parsed = ApprovalsSchema.safeParse(
        (await transport.request("GET", "/approvals").catch(() => undefined))?.body,
      );

      if (live && parsed.success) {
        setCount(parsed.data.approvals.filter(isWaiting).length);
      }
    };

    void (async () => {
      const head = HeadSchema.safeParse(
        (await transport.request("GET", "/events?after=0&limit=1").catch(() => undefined))?.body,
      );
      const opened = await transport
        .subscribe({
          afterSequence: head.success ? head.data.latestSequence : 0,
          onEvent: (event) => {
            if (event.type.startsWith("authority.")) {
              void recount();
            }
          },
        })
        .catch(() => undefined);

      if (!live) {
        opened?.close();
        return;
      }

      close = () => opened?.close();
      await recount();
    })();

    return () => {
      live = false;
      close?.();
    };
  }, [transport]);

  return count;
}
