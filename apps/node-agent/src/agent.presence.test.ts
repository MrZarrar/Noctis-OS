import { expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { NodeFrameSchema } from "@noctis/contracts";
import { startAgent } from "./agent.js";

async function waitFor(test: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 2000; !test();) {
    if (Date.now() > deadline) throw new Error("timed out waiting for owner presence frame");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("sends helper state only after welcome, only on edges and re-reads after reconnect", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP port required");
  const frames: Array<{ kind: string; present?: boolean }> = [];
  let socket: WebSocket | undefined;
  server.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (data: Buffer) =>
      frames.push(NodeFrameSchema.parse(JSON.parse(data.toString("utf8")))),
    );
  });
  let present = false;
  const nodeId = "0199a000-0000-7000-8000-0000000000e1";
  const welcome = () =>
    socket?.send(
      JSON.stringify({
        kind: "welcome",
        envelopeVersion: 1,
        nodeId,
        generation: 1,
        credential: "a".repeat(64),
        grants: [],
      }),
    );
  const agent = startAgent({
    credential: {
      coreUrl: `http://127.0.0.1:${address.port}`,
      nodeId,
      generation: 0,
      credential: "a".repeat(64),
    },
    saveCredential: () => undefined,
    probes: () => Promise.resolve([]),
    ownerPresence: () => Promise.resolve(present),
    presencePollMs: 10,
    initialBackoffMs: 10,
    maxBackoffMs: 10,
  });
  try {
    await waitFor(() => frames.some((frame) => frame.kind === "hello"));
    expect(frames.some((frame) => frame.kind === "owner_presence")).toBe(false);
    welcome();
    const presence = () => frames.filter((frame) => frame.kind === "owner_presence");
    await waitFor(() => presence().length === 1);
    expect(presence().map((frame) => frame.present)).toEqual([false]);
    present = true;
    await waitFor(() => presence().length === 2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(presence().map((frame) => frame.present)).toEqual([false, true]);
    const previous = socket;
    previous?.terminate();
    await waitFor(() => socket !== previous);
    welcome();
    await waitFor(() => presence().length === 3);
    expect(presence().map((frame) => frame.present)).toEqual([false, true, true]);
    present = false;
    await waitFor(() => presence().length === 4);
    expect(presence().at(-1)?.present).toBe(false);
  } finally {
    agent.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
