import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import * as c from "@noctis/contracts";
import { Productivity } from "../src/pages/Productivity.js";
import { ProductivityPresence } from "../src/pages/ProductivityPresence.js";
const now = new Date().toISOString();
const nodeId = "00000000-0000-7000-8000-000000000001";
const records = {
  reminders: [],
  notes: [],
  tasks: [],
  permissions: [],
  nodes: [{ id: nodeId, hostId: "Home PC" }],
};
const schemas = {
  authority: {
    grant_permission: c.GrantStandingPermissionCommandSchema,
    revoke_permission: c.RevokeStandingPermissionCommandSchema,
  },
  reminder: {
    create: c.CreateReminderCommandSchema,
    update: c.UpdateReminderCommandSchema,
    complete: c.CompleteReminderCommandSchema,
    snooze: c.SnoozeReminderCommandSchema,
    delete: c.DeleteReminderCommandSchema,
  },
  note: {
    create: c.CreateNoteCommandSchema,
    update: c.UpdateNoteCommandSchema,
    delete: c.DeleteNoteCommandSchema,
  },
  task: {
    create: c.CreateTaskCommandSchema,
    update: c.UpdateTaskCommandSchema,
    pause: c.PauseTaskCommandSchema,
    resume: c.ResumeTaskCommandSchema,
    run_now: c.RunTaskNowCommandSchema,
    delete: c.DeleteTaskCommandSchema,
  },
};
const transport = {
  request: async (method, path, body) => {
    if (method === "GET") {
      if (path.endsWith("/runs")) return { status: 200, body: { runs: [] } };
      const key = path.slice(1);
      return { status: 200, body: { [key]: records[key] } };
    }
    const [entity, action] = path.split("/").at(-1).split(".");
    const parsed = schemas[entity][action].safeParse(body);
    if (!parsed.success) return { status: 400, body: { message: parsed.error.message } };
    if (entity === "authority") {
      if (action === "grant_permission") {
        const { idempotencyKey, ...permission } = body;
        records.permissions.push({
          ...permission,
          id: crypto.randomUUID().replace(/^(.{14})./, "$17"),
          grantedAt: now,
          grantedBy: "owner",
        });
      } else {
        const permission = records.permissions.find((p) => p.id === body.permissionId);
        if (permission) permission.revokedAt = now;
      }
      return { status: 200, body: {} };
    }
    const list =
      records[entity === "reminder" ? "reminders" : entity === "note" ? "notes" : "tasks"];
    const id = body[`${entity}Id`];
    const index = list.findIndex((r) => r.id === id);
    const { idempotencyKey, expectedRevision, reminderId, noteId, taskId, ...fields } = body;
    if (action === "create")
      list.push({
        ...fields,
        id: crypto.randomUUID().replace(/^(.{14})./, "$17"),
        revision: 1,
        createdAt: now,
        updatedAt: now,
        ...(entity === "reminder"
          ? { status: "pending" }
          : entity === "task"
            ? { paused: true, consecutiveFailures: 0 }
            : {}),
      });
    else if (action === "delete") list.splice(index, 1);
    else {
      if (index < 0 || list[index].revision !== expectedRevision)
        return { status: 409, body: { message: "Stale revision" } };
      list[index] = {
        ...list[index],
        ...(action === "update" ? fields : {}),
        revision: expectedRevision + 1,
        ...(action === "complete"
          ? { status: "done" }
          : action === "snooze"
            ? {
                status: "snoozed",
                ...(body.until ? { nextDueAt: body.until } : { snoozedUntilPcId: body.atPcNodeId }),
              }
            : action === "pause"
              ? { paused: true }
              : action === "resume"
                ? { paused: false }
                : {}),
      };
    }
    if (action === "update" && entity === "task") delete list[index].proposedUpdate;
    return { status: 200, body: { id: id ?? list.at(-1)?.id } };
  },
  subscribe: async () => ({ close() {} }),
};
function Fixture() {
  const [page, setPage] = useState("Reminders");
  const [panel, setPanel] = useState(false);
  return (
    <div
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        fontFamily: "sans-serif",
      }}
    >
      <nav>
        {["Presence", "Reminders", "To-dos", "Notes"].map((p) => (
          <button key={p} onClick={() => setPage(p)}>
            {p}
          </button>
        ))}
        <button onClick={() => setPanel(!panel)}>Toggle panel</button>
        <button
          onClick={() => {
            const t = records.tasks[0];
            if (t) {
              const {
                name,
                prompt,
                model,
                nodeId,
                rootGrantId,
                trigger,
                threadMode,
                maxRunMinutes,
              } = t;
              t.proposedUpdate = {
                name,
                prompt: "Suggested new work",
                model,
                nodeId,
                rootGrantId,
                trigger,
                threadMode,
                maxRunMinutes,
              };
            }
            setPanel(!panel);
          }}
        >
          Suggest task change
        </button>
        <button
          onClick={() => {
            for (let i = 0; i < 4; i++)
              records.reminders.push({
                id: crypto.randomUUID().replace(/^(.{14})./, "$17"),
                identityId: "vesper",
                text: "Due " + i,
                trigger: { kind: "at", at: now },
                status: "due",
                revision: 1,
                createdAt: now,
                updatedAt: now,
              });
            setPage("Presence");
          }}
        >
          Seed due reminders
        </button>
      </nav>
      <main style={{ display: "flex", flex: 1, minHeight: 0, maxWidth: panel ? 480 : undefined }}>
        {page === "Presence" ? (
          <ProductivityPresence
            transport={transport}
            onOpenThread={() => {}}
            onOpenReminders={() => setPage("Reminders")}
          />
        ) : (
          <Productivity
            key={`${page}:${panel}`}
            page={page}
            transport={transport}
            models={[{ providerId: "codex", model: "gpt-6-sol" }]}
            roots={[
              {
                nodeId,
                hostId: "Home PC",
                grantId: "test",
                path: "C:\\Sandbox",
                mode: "write",
                localOnly: false,
                connected: true,
              },
            ]}
          />
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
