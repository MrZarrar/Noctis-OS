import { typography } from "@noctis/ui";
import { useEffect, useState } from "react";

import type { CoreTransport } from "../transport/CoreTransport.js";
import { UsageLimits } from "./UsageLimits.js";
import { clockText, msToNextMinute } from "./clock.js";

/**
 * Beside Threads' composer: the time, and how much of the chosen agent's
 * allowance is left. Claude and Codex report limits; a local agent has none.
 */
export function ThreadStatus({
  transport,
  mobile,
  providerId,
}: {
  transport: CoreTransport | undefined;
  mobile: boolean;
  providerId: string | undefined;
}): JSX.Element {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer = window.setTimeout(function tick() {
      setNow(new Date());
      timer = window.setTimeout(tick, msToNextMinute(new Date()));
    }, msToNextMinute(new Date()));

    return () => window.clearTimeout(timer);
  }, []);

  const clock = clockText(now);
  const limited = providerId === "claude" || providerId === "codex";

  return (
    <div data-thread-status style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <time
        dateTime={now.toISOString()}
        aria-label={`${clock.time}, ${clock.day}`}
        style={{ display: "flex", alignItems: "baseline", gap: 8, whiteSpace: "nowrap" }}
      >
        <span
          style={{
            font: `200 22px/1 ${typography.family}`,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "0.02em",
            color: typography.color.primary,
          }}
        >
          {clock.time}
        </span>
        <span
          style={{
            fontSize: typography.scale.xs,
            color: typography.color.muted,
            letterSpacing: "0.06em",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {clock.day}
        </span>
      </time>
      {limited && (
        <UsageLimits
          transport={transport}
          now={now}
          mobile={mobile}
          providers={[providerId]}
          compact
        />
      )}
    </div>
  );
}
