import { useState } from "react";
import { ReminderSchema, ScheduledTaskSchema, type RuntimeItem } from "@noctis/contracts";
import { z } from "zod";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { buttonStyle, glass } from "../layout/Page.js";
import { productivityCommand, type ProductivityPage } from "./Productivity.js";
import { triggerLabel } from "./productivity-view.js";
export type OpenProductivity = (page: ProductivityPage, id: string, task?: boolean) => void;
export function ProductivityReceipt({
  item,
  transport,
  onOpen,
}: {
  item: Extract<RuntimeItem, { kind: "proposal" }>;
  transport: CoreTransport | undefined;
  onOpen: OpenProductivity | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const proposal = item.proposal;
  const id = item.appliedRecordId;
  if (proposal.kind === "task_action") {
    return (
      <div style={{ ...glass, padding: 12, display: "grid", gap: 8 }}>
        <strong>{proposal.action === "run_now" ? "Run now" : "Pause"}: scheduled task</strong>
        <span>
          {id
            ? proposal.action === "pause"
              ? "Task paused."
              : "Run requested. Open the task to check its result."
            : "Proposed only. Action not applied."}
        </span>
        {onOpen && (
          <button style={buttonStyle} onClick={() => onOpen("Reminders", proposal.taskId, true)}>
            Open
          </button>
        )}
      </div>
    );
  }
  const suggestedUpdate = proposal.kind === "task" && proposal.taskId !== undefined;
  if (proposal.kind !== "reminder" && proposal.kind !== "task" && proposal.kind !== "note")
    return null;
  const page =
    proposal.kind === "note"
      ? "Notes"
      : proposal.kind === "reminder" && proposal.trigger === null
        ? "To-dos"
        : "Reminders";
  async function act() {
    if (!transport || !id || busy) return;
    setBusy(true);
    setError("");
    try {
      if (proposal.kind === "reminder") {
        const r = await transport.request("GET", "/reminders");
        const record = z
          .object({ reminders: z.array(ReminderSchema) })
          .parse(r.body)
          .reminders.find((r) => r.id === id);
        if (!record) throw new Error("This reminder has already been removed.");
        await productivityCommand(transport, "reminder.delete", {
          id,
          expectedRevision: record.revision,
        });
        setMessage("Reminder removed");
      } else if (proposal.kind === "task") {
        const r = await transport.request("GET", "/tasks");
        const record = z
          .object({ tasks: z.array(ScheduledTaskSchema) })
          .parse(r.body)
          .tasks.find((r) => r.id === id);
        if (!record) throw new Error("This task has been removed.");
        await productivityCommand(transport, "task.resume", {
          id,
          expectedRevision: record.revision,
        });
        setMessage("Task turned on");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this change.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ ...glass, padding: 12, display: "grid", gap: 8 }}>
      <strong>
        {proposal.kind === "reminder"
          ? proposal.text
          : proposal.kind === "task"
            ? proposal.name
            : proposal.title}
      </strong>
      {proposal.kind !== "note" && <span>{triggerLabel(proposal.trigger)}</span>}
      {proposal.kind === "task" && (
        <>
          <p style={{ margin: 0 }}>{proposal.prompt}</p>
          <small>
            {proposal.model.model} on {proposal.nodeId}, folder {proposal.rootGrantId}.{" "}
            {proposal.maxRunMinutes} minute limit.
          </small>
        </>
      )}
      <span>
        {message ||
          (id
            ? proposal.kind === "task"
              ? suggestedUpdate
                ? "Suggested changes are waiting for your review."
                : "Created paused. Turn on to allow scheduled runs."
              : "Saved in Noctis"
            : "Not recorded")}
      </span>
      {id && !message && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {proposal.kind !== "note" && !suggestedUpdate && (
            <button disabled={busy} aria-busy={busy} style={buttonStyle} onClick={() => void act()}>
              {busy ? "Saving..." : proposal.kind === "reminder" ? "Undo" : "Turn on"}
            </button>
          )}
          {onOpen && (
            <button style={buttonStyle} onClick={() => onOpen(page, id, proposal.kind === "task")}>
              {suggestedUpdate ? "Review changes" : proposal.kind === "task" ? "Edit" : "Open"}
            </button>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
