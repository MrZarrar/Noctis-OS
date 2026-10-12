import type { LiveBriefPayload } from "@noctis/contracts";
import { typography } from "@noctis/ui";
import { useEffect, useState } from "react";

export function elapsedText(startedAt: string, now: Date): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - Date.parse(startedAt)) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${String(minutes)} min`;
  const rest = minutes % 60;
  return `${String(Math.floor(minutes / 60))} h${rest === 0 ? "" : ` ${String(rest)} min`}`;
}

export function LiveBriefSurface({
  runtime,
  activity,
  status,
  startedAt,
}: LiveBriefPayload): JSX.Element {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <p style={{ margin: 0, fontSize: typography.scale.md }}>{activity}</p>
      <p style={{ margin: 0, fontSize: typography.scale.sm, color: typography.color.muted }}>
        {runtime} · {status === "starting" ? "Starting" : "Running"} ·{" "}
        <time dateTime={startedAt}>{elapsedText(startedAt, now)}</time>
      </p>
    </div>
  );
}
