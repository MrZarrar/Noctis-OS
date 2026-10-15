import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { NodeFrameSchema, type NodeFrame } from "@noctis/contracts";
import { expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { startAgent } from "./agent.js";
import { killProcessTree } from "./runtimes/kill-tree.js";

async function waitFor(test: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 2_000; !test();) {
    if (Date.now() > deadline) throw new Error("timed out waiting for scheduled job");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("waits for scheduled process exit, skips a cancelled queued job and leaves chats concurrent", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP port required");
  const nodeId = "0199a000-0000-7000-8000-0000000000e1";
  const taskId = "0199a000-0000-7000-8000-0000000000e2";
  const session = "a".repeat(64);
  const frames: NodeFrame[] = [];
  let socket: WebSocket | undefined;
  server.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (data: Buffer) => {
      const frame = NodeFrameSchema.parse(JSON.parse(data.toString("utf8")));
      frames.push(frame);
      if (frame.kind === "hello")
        ws.send(
          JSON.stringify({
            kind: "welcome",
            envelopeVersion: 1,
            nodeId,
            generation: 1,
            credential: session,
            grants: [
              {
                id: taskId,
                nodeId,
                capability: "runtime.turn",
                operationClass: "local_reversible_edit",
                constraintsVersion: 1,
                constraints: {
                  providers: ["codex"],
                  roots: [{ grantId: "repo", path: "C:/repo", mode: "write", localOnly: false }],
                },
                grantedAt: new Date().toISOString(),
              },
            ],
          }),
        );
    });
  });
  const started: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: () => true,
  });
  const releaseCleanup = (): void => {
    child.exitCode = 1;
    child.emit("exit", 1, null);
  };
  let firstAborted = false;
  const agent = startAgent({
    credential: {
      coreUrl: `http://127.0.0.1:${address.port}`,
      nodeId,
      generation: 0,
      credential: session,
    },
    saveCredential: () => undefined,
    probes: () => Promise.resolve([]),
    reconnect: false,
    adapters: {
      "runtime.turn": async (payload, context) => {
        const { prompt } = payload as { prompt: string };
        started.push(prompt);
        if (prompt === "first") {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener(
              "abort",
              () => {
                firstAborted = true;
                resolve();
              },
              { once: true },
            ),
          );
          await killProcessTree(child);
        }
        return { prompt };
      },
    },
  });
  const job = (number: number, prompt: string, scheduled = true): string => {
    const jobId = `0199a000-0000-7000-8000-${String(number).padStart(12, "0")}`;
    const assignment = JSON.stringify({
      jobId,
      nodeId,
      capability: "runtime.turn",
      idempotencyKey: `test-${number}`,
      payloadVersion: 1,
      payload: {
        threadId: taskId,
        identityId: "vesper",
        model: { providerId: "codex", model: "fake" },
        userMessageId: taskId,
        prompt,
        primaryRootGrantId: "repo",
        objectiveActive: false,
        ...(scheduled ? { scheduledTaskId: taskId } : {}),
      },
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      attempt: 1,
    });
    socket?.send(
      JSON.stringify({
        kind: "job",
        envelopeVersion: 1,
        assignment,
        signature: createHmac("sha256", session)
          .update(`noctis.node.assignment.v1:${assignment}`)
          .digest("hex"),
      }),
    );
    return jobId;
  };
  const cancel = (jobId: string) =>
    socket?.send(JSON.stringify({ kind: "cancel", envelopeVersion: 1, jobId }));
  try {
    await waitFor(() => agent.connected());
    const first = job(1, "first");
    await waitFor(() => started.includes("first"));
    cancel(first);
    await waitFor(() => firstAborted);
    const second = job(2, "second");
    const ordinary = job(3, "ordinary", false);
    await waitFor(() =>
      frames.some((frame) => frame.kind === "result" && frame.jobId === ordinary),
    );
    expect(started).toEqual(["first", "ordinary"]);
    cancel(second);
    job(4, "fourth");
    const barrier = job(5, "barrier", false);
    await waitFor(() => frames.some((frame) => frame.kind === "result" && frame.jobId === barrier));
    releaseCleanup();
    await waitFor(() => started.includes("fourth"));
    expect(started).toEqual(["first", "ordinary", "barrier", "fourth"]);
    await waitFor(() =>
      frames.some(
        (frame) => frame.kind === "result" && frame.jobId === second && frame.outcome === "failed",
      ),
    );
  } finally {
    releaseCleanup();
    agent.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
