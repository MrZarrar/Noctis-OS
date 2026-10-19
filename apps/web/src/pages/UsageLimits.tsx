import type { UsageWindow } from "@noctis/contracts";
import { material, semantic, typography } from "@noctis/ui";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

import type { CoreTransport } from "../transport/CoreTransport.js";
import type { UsageLimitsView } from "./usage-limits-view.js";
import { UsageLimitsSchema, resetText, windowSeverity } from "./usage-limits-view.js";

/** Each read is a job on the PC, so not often; the countdowns tick on Presence's clock. */
const REFRESH_MS = 5 * 60_000;

const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

const FILL = {
  normal: "#8B7CF6",
  warning: semantic.warning,
  error: semantic.error,
} as const;

function Meter({
  provider,
  label,
  long,
  window,
  now,
}: {
  provider: string;
  label: string;
  long: string;
  window: UsageWindow;
  now: Date;
}): JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const percent = Math.round(window.usedPercent);
  const reset = resetText(window.resetsAt, now);
  const severity = windowSeverity(window.usedPercent);

  return (
    <>
      <span>{label}</span>
      <span
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(percent, 100)}
        aria-label={`${provider} ${long} limit, ${String(percent)}% used, resets ${
          /\d[hm]$/.test(reset) ? `in ${reset}` : reset
        }`}
        style={{
          position: "relative",
          height: 3,
          borderRadius: 2,
          background: material.border,
          overflow: "hidden",
        }}
      >
        <motion.span
          initial={reduced ? false : { scaleX: 0 }}
          animate={{ scaleX: Math.min(window.usedPercent, 100) / 100 }}
          transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 22 }}
          style={{
            position: "absolute",
            inset: 0,
            transformOrigin: "left",
            borderRadius: 2,
            background: FILL[severity],
            boxShadow: severity === "normal" ? "none" : `0 0 6px ${FILL[severity]}`,
          }}
        />
      </span>
      <span
        style={{
          textAlign: "right",
          color: severity === "normal" ? typography.color.primary : FILL[severity],
        }}
      >
        {percent}%
      </span>
      <span>{reset}</span>
    </>
  );
}

/**
 * The owner's Claude and Codex allowances, exactly as each provider reports
 * them. Nothing here estimates: a provider that cannot be asked says so.
 */
export function UsageLimits({
  transport,
  now,
  mobile,
}: {
  transport: CoreTransport | undefined;
  now: Date;
  mobile: boolean;
}): JSX.Element | null {
  const [limits, setLimits] = useState<UsageLimitsView["limits"]>();

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let live = true;
    const read = () => {
      void transport
        .request("GET", "/limits")
        .then((response) => {
          const parsed = UsageLimitsSchema.safeParse(response.body);

          if (live && parsed.success) {
            setLimits(parsed.data.limits);
          }
        })
        .catch(() => {
          /* Presence stays as it was; the next read tries again. */
        });
    };

    read();
    const timer = window.setInterval(read, REFRESH_MS);

    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [transport]);

  if (limits === undefined || limits.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Usage limits"
      data-usage-limits
      style={{
        display: "grid",
        gap: 10,
        alignSelf: mobile ? "center" : "flex-start",
        marginTop: mobile ? 8 : 0,
        width: mobile ? "100%" : 248,
        maxWidth: 320,
        fontFamily: typography.monoFamily,
        fontSize: 11,
        color: typography.color.muted,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {limits.map((limit) => {
        const name = NAMES[limit.providerId] ?? limit.providerId;

        return (
          <div key={limit.providerId} style={{ display: "grid", gap: 4 }}>
            <span
              style={{
                fontSize: 10,
                letterSpacing: "0.14em",
                color: typography.color.primary,
                opacity: 0.85,
              }}
            >
              {name.toUpperCase()}
            </span>
            {limit.problem !== undefined ||
            (limit.fiveHour === undefined && limit.weekly === undefined) ? (
              <span
                title={limit.problem}
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {limit.problem ?? "No limits reported"}
              </span>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "20px minmax(60px, 1fr) 34px 68px",
                  alignItems: "center",
                  columnGap: 8,
                  rowGap: 4,
                }}
              >
                {limit.fiveHour !== undefined && (
                  <Meter
                    provider={name}
                    label="5H"
                    long="5-hour"
                    window={limit.fiveHour}
                    now={now}
                  />
                )}
                {limit.weekly !== undefined && (
                  <Meter provider={name} label="WK" long="weekly" window={limit.weekly} now={now} />
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
