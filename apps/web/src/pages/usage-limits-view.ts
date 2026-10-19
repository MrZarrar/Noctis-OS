import { RuntimeProviderIdSchema, UsageWindowSchema } from "@noctis/contracts";
import { z } from "zod";

/** `GET /limits`: each provider's windows, or why it could not be asked. */
export const UsageLimitsSchema = z.object({
  limits: z.array(
    z.object({
      providerId: RuntimeProviderIdSchema,
      hostId: z.string().optional(),
      fiveHour: UsageWindowSchema.optional(),
      weekly: UsageWindowSchema.optional(),
      problem: z.string().optional(),
    }),
  ),
});

export type UsageLimitsView = z.infer<typeof UsageLimitsSchema>;

const DAY_MS = 86_400_000;

const LATER = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** A countdown while the reset is under a day away; past that, when it is. */
export function resetText(resetsAt: string | undefined, now: Date): string {
  if (resetsAt === undefined) {
    return "—";
  }

  const remaining = Date.parse(resetsAt) - now.getTime();

  if (remaining <= 0) {
    return "now";
  }

  if (remaining >= DAY_MS) {
    return LATER.format(new Date(resetsAt)).replace(",", "");
  }

  const minutes = Math.ceil(remaining / 60_000);

  return minutes < 60
    ? `${String(minutes)}m`
    : `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

export function windowSeverity(usedPercent: number): "normal" | "warning" | "error" {
  return usedPercent >= 95 ? "error" : usedPercent >= 80 ? "warning" : "normal";
}
