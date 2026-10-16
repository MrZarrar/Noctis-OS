import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { healthReportFixture } from "@noctis/contracts";
import "../src/index.css";
import { HealthReportView } from "../src/health/HealthReportView.js";

// ?stale shows the banner, ?busy=run the running state, ?state=none|missing|unreadable|not_allowed the empty ones.
const query = new URLSearchParams(location.search);
const state = query.get("state");
const report = healthReportFixture();

function Preview() {
  const [suggestions, setSuggestions] = useState(report.suggestions);
  const decided = [];
  const status = {
    granted: state !== "not_allowed",
    nodeId: "00000000-0000-7000-8000-000000000001",
    nodeOnline: true,
    busy: query.get("busy"),
    lastRun: { at: "2026-10-11T19:04:00.000Z", outcome: "written" },
    weeklyAt: "20:00",
    proposed: suggestions.filter((s) => s.status === "proposed").length,
    report:
      state === "none" || state === "not_allowed"
        ? { state: "none" }
        : state === "missing"
          ? { state: "missing", receivedAt: "2026-10-11T19:04:00.000Z" }
          : state === "unreadable"
            ? {
                state: "unreadable",
                receivedAt: "2026-10-11T19:04:00.000Z",
                reason: "stats.coverage: invalid_type",
              }
            : {
                state: "ok",
                receivedAt: "2026-10-11T19:04:00.000Z",
                report: { ...report, suggestions },
              },
  };
  return (
    <HealthReportView
      status={status}
      now={new Date(query.has("stale") ? "2026-10-25T09:00:00" : "2026-10-12T09:00:00")}
      onRunNow={() => undefined}
      onDecide={(id, action) => {
        decided.push([id, action]);
        window.__decided = [...(window.__decided ?? []), [id, action]];
        setSuggestions((all) =>
          all.map((s) =>
            s.id === id
              ? {
                  ...s,
                  status:
                    action === "reset"
                      ? "proposed"
                      : action === "dismiss"
                        ? "dismissed"
                        : "applied",
                }
              : s,
          ),
        );
      }}
    />
  );
}

createRoot(document.getElementById("root")).render(<Preview />);
