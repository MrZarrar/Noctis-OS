import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Threads } from "../src/pages/Threads.js";
import "../src/index.css";

const model = { providerId: "codex", model: "gpt-6.1-sol" };
const transport = {
  request: async () => ({
    status: 200,
    body: {
      limits: [{ providerId: "codex", fiveHour: { usedPercent: 80 }, weekly: { usedPercent: 18 } }],
    },
  }),
};
const reply = [
  "The response should stay readable inside the phone screen. ".repeat(12),
  "```text\n" + "wide-code-".repeat(60) + "\n```",
  "| Item | Description |\n| --- | --- |\n| Result | " + "wide-table-".repeat(40) + " |",
].join("\n\n");

function Fixture() {
  const [running, setRunning] = useState(true);
  const [identityId, setIdentityId] = useState("vesper");
  const turn = {
    id: "turn",
    jobId: "job",
    threadId: "thread",
    identityId,
    userMessageId: "prompt",
    model,
    status: running ? "running" : "cancelled",
    startedAt: "2026-10-28T09:30:00Z",
    items: Array.from({ length: 36 }, (_, index) => ({
      itemId: `agent-${index}`,
      kind: "sub_agent",
      label: `Worker ${index}`,
      status: "completed",
    })),
  };
  const conversation = {
    panelsRevision: 0,
    presencePanelsRevision: 0,
    messages: [
      {
        id: "prompt",
        threadId: "thread",
        role: "user",
        body: "Review this layout",
        createdAt: "2026-10-28T09:29:00Z",
      },
      {
        id: "reply",
        threadId: "thread",
        role: "identity",
        body: reply,
        createdAt: "2026-10-28T09:30:00Z",
      },
    ],
    turns: [turn],
    streaming: new Map(running ? [["stream", reply]] : []),
    partialReplies: new Map(),
    pendingApprovals: [],
    models: [model, { providerId: "codex", model: "other-model", label: "Other" }],
    defaultModel: model,
    roots: [
      {
        grantId: "repo",
        nodeId: "work",
        path: "C:/Documents/Noctis-OS",
        hostId: "work",
        mode: "read_write",
        connected: true,
      },
    ],
    canAttach: true,
    children: [],
    send: async (text, options) => {
      window.__sent = { text, options };
    },
    cancel: async () => {
      setRunning(false);
    },
    startFresh: async () => {},
    startFreshIfIdle: async () => {},
    confirm: async () => {},
    decline: async () => {},
    retryElsewhere: async () => {},
  };
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", color: "#e7e6ee" }}>
      <header style={{ height: 56, flexShrink: 0, paddingInline: 16 }}>Noctis</header>
      <Threads
        identityId={identityId}
        conversation={conversation}
        connected
        transport={transport}
        onOpenThread={() => {}}
        freeThread
        onUseFreeThread={() => {}}
        onSwitchIdentity={setIdentityId}
      />
      <nav aria-label="Primary" style={{ height: 64, flexShrink: 0 }}>
        Threads
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);
