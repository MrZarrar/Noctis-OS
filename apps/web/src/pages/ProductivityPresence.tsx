import { useEffect, useState } from "react";
import { z } from "zod";
import {
  ReminderSchema,
  ScheduledTaskSchema,
  TaskRunSchema,
  type Reminder,
  type TaskRun,
} from "@noctis/contracts";
import { material, semantic } from "@noctis/ui";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { buttonStyle } from "../layout/Page.js";
import { SnoozeChoices } from "./SnoozeChoices.js";
import { productivityCommand } from "./Productivity.js";
export function ProductivityPresence({
  transport,
  onOpenThread,
  onOpenReminders,
}: {
  transport: CoreTransport | undefined;
  onOpenThread?: (id: string) => void;
  onOpenReminders?: () => void;
}) {
  const [nodes, setNodes] = useState<{ id: string; hostId: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void transport
      ?.request("GET", "/nodes")
      .then((r) => {
        const parsed = z
          .object({ nodes: z.array(z.object({ id: z.string(), hostId: z.string() })) })
          .safeParse(r.body);
        if (!cancelled && parsed.success) setNodes(parsed.data.nodes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [transport]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [result, setResult] = useState<TaskRun>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!transport) return;
    let cancelled = false;
    async function read() {
      try {
        const [r, t] = await Promise.all([
          transport!.request("GET", "/reminders"),
          transport!.request("GET", "/tasks"),
        ]);
        const reminders = z.object({ reminders: z.array(ReminderSchema) }).parse(r.body).reminders;
        const tasks = z.object({ tasks: z.array(ScheduledTaskSchema) }).parse(t.body).tasks;
        const histories = await Promise.all(
          tasks.map(async (task) => {
            const response = await transport!.request("GET", `/tasks/${task.id}/runs`);
            return z.object({ runs: z.array(TaskRunSchema) }).parse(response.body).runs;
          }),
        );
        if (!cancelled) {
          setReminders(reminders.filter((r) => r.status === "due"));
          setResult(
            histories
              .flat()
              .filter((r) => r.status === "completed" || r.status === "needs_you")
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0],
          );
        }
      } catch {
        /* Presence stays usable if the productivity read is unavailable. */
      }
    }
    void read();
    const timer = setInterval(() => void read(), 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [transport, revision]);
  async function act(
    r: Reminder,
    snooze: false | { until: string } | { atPcNodeId: string } = false,
  ) {
    setBusy(true);
    setError("");
    try {
      await productivityCommand(transport, snooze ? "reminder.snooze" : "reminder.complete", {
        id: r.id,
        expectedRevision: r.revision,
        ...(snooze || {}),
      });
      setRevision((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!reminders.length && !result && !error) return null;
  return (
    <aside
      aria-label="Due reminders and task results"
      style={{ alignSelf: "stretch", display: "grid", gap: 8, marginTop: 12 }}
    >
      {reminders.slice(0, 3).map((r) => (
        <div
          key={r.id}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
            padding: 8,
            borderBottom: `1px solid ${material.border}`,
          }}
        >
          <span style={{ flex: "1 1 180px" }}>{r.text}</span>
          <button disabled={busy} style={buttonStyle} onClick={() => void act(r)}>
            Done
          </button>
          <button
            disabled={busy}
            style={buttonStyle}
            onClick={() => void act(r, { until: new Date(Date.now() + 3600000).toISOString() })}
          >
            Snooze 1 hour
          </button>
          <SnoozeChoices
            disabled={busy}
            nodes={nodes}
            onSnooze={(until) => void act(r, { until })}
            onPc={(atPcNodeId) => void act(r, { atPcNodeId })}
          />
        </div>
      ))}
      {reminders.length > 3 && (
        <button style={buttonStyle} onClick={onOpenReminders}>
          and {reminders.length - 3} more
        </button>
      )}
      {result && (
        <div>
          <strong>
            {result.status === "needs_you"
              ? "A scheduled task needs you"
              : "Scheduled task finished"}
          </strong>
          <p>{result.result ?? result.reason ?? "Open the thread to review what happened."}</p>
          {result.threadId && onOpenThread && (
            <button style={buttonStyle} onClick={() => onOpenThread(result.threadId!)}>
              Open task thread
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" style={{ color: semantic.error }}>
          {error}
        </p>
      )}
    </aside>
  );
}
