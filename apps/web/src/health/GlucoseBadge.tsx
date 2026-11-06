import type { GlucoseLive } from "@noctis/contracts";
import { semantic, typography } from "@noctis/ui";
import { useEffect, useState } from "react";

import type { CoreTransport } from "../transport/CoreTransport.js";
import { GlucoseLiveSchema, band, trendGlyph } from "./glucose-live-view.js";

/** The G7 itself only updates every 5 minutes; this just catches up sooner after a save. */
const REFRESH_MS = 60_000;

const BAND_COLOR = {
  low: semantic.error,
  high: semantic.warning,
  normal: typography.color.primary,
} as const;

export function GlucoseBadge({
  transport,
  compact = false,
}: {
  transport: CoreTransport | undefined;
  /** Beside the clock in Presence and ThreadStatus, vs. the full tile on the Health page. */
  compact?: boolean;
}): JSX.Element | null {
  const [live, setLive] = useState<GlucoseLive>();

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let current = true;
    const read = () => {
      void transport
        .request("GET", "/glucose/live")
        .then((response) => {
          const parsed = GlucoseLiveSchema.safeParse(response.body);
          if (current && parsed.success) {
            setLive(parsed.data);
          }
        })
        .catch(() => {
          /* Stays as it was; the next read tries again. */
        });
    };

    read();
    const timer = window.setInterval(read, REFRESH_MS);

    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [transport]);

  if (live === undefined || live.state === "not_configured" || live.state === "error") {
    return null;
  }

  const color = BAND_COLOR[band(live.mmol)];

  return (
    <span
      aria-label={`Glucose ${String(live.mmol)} millimoles per litre${
        live.state === "stale" ? ", reading may be out of date" : ""
      }`}
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 4,
        fontFamily: typography.monoFamily,
        fontVariantNumeric: "tabular-nums",
        fontSize: compact ? 13 : 28,
        fontWeight: compact ? 400 : 300,
        color: live.state === "stale" ? typography.color.muted : color,
        opacity: live.state === "stale" ? 0.7 : 1,
      }}
    >
      {live.mmol.toFixed(1)}
      <span aria-hidden="true">{trendGlyph(live.trend)}</span>
    </span>
  );
}
