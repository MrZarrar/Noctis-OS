import { PassThrough } from "node:stream";
import { request as httpRequest } from "node:http";
import * as http from "node:http";

import type { NodeServerFrame } from "@noctis/contracts";
import { NodeJobAssignmentSchema } from "@noctis/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandContext } from "../kernel.js";
import { createLogger } from "../logging.js";
import { cancelJob, getJob, LEASE_MS } from "../nodes/jobs.js";
import { grantCapability, issuePairingCode, pairNode } from "../nodes/registry.js";
import type { RunningCore } from "../server.js";
import { startCore } from "../server.js";
import type { ScreenGateway } from "./gateway.js";
import { createScreenGateway, SCREEN_ANSWER_MS } from "./gateway.js";

vi.mock("node:http", { spy: true });

const context: CommandContext = {
  correlationId: "0199a000-0000-7000-8000-000000000001",
  actorType: "user",
  actorId: "local",
};
const cores: RunningCore[] = [];
const gateways: ScreenGateway[] = [];
const bodies: PassThrough[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(http.createServer).mockReset();
  for (const body of bodies.splice(0)) body.destroy();
  for (const gateway of gateways.splice(0)) gateway.close();
  for (const core of cores.splice(0)) await core.close();
});

async function waitingMirror(signal?: AbortSignal) {
  let now = Date.parse("2026-10-09T12:00:00Z");
  const core = await startCore({
    config: {
      bindAddress: "127.0.0.1",
      port: 0,
      token: "0123456789abcdef0123456789abcdef",
      databasePath: ":memory:",
      allowedOrigins: [],
      logLevel: "error",
      sessionTtlHours: 720,
    },
    clock: { now: () => now },
    dispatchIntervalMs: 3_600_000,
    logger: createLogger({ sink: () => undefined, level: "error" }),
    env: {},
  });
  cores.push(core);
  const issued = issuePairingCode(core.kernel, context, {
    hostId: "test-screen",
    idempotencyKey: "pair",
  });
  if (!issued.ok) throw new Error("could not issue pairing code");
  const paired = pairNode(
    core.kernel,
    context,
    {
      code: issued.value.code,
      hostId: "test-screen",
      fingerprint: "test-screen",
      agentVersion: "test",
    },
    "0123456789abcdef0123456789abcdef",
  );
  if (!paired.ok) throw new Error("could not pair test node");
  const nodeId = paired.value.nodeId;
  expect(
    grantCapability(core.kernel, context, {
      nodeId,
      capability: "screen.view",
      constraints: {},
      idempotencyKey: "grant",
    }).ok,
  ).toBe(true);
  const frames: NodeServerFrame[] = [];
  core.dispatcher.register({
    nodeId,
    connectionId: "test",
    credential: "test",
    send: (frame) => frames.push(frame),
    close: () => undefined,
    sendGrants: () => undefined,
  });
  const gateway = createScreenGateway({ kernel: core.kernel, dispatcher: core.dispatcher });
  gateways.push(gateway);
  const opened = gateway.open(context, { nodeId, fps: 15, width: 1280 }, signal);
  void opened.catch(() => undefined);
  const assignment = frames.find((frame) => frame.kind === "job");
  if (assignment?.kind !== "job") throw new Error("no screen job dispatched");
  const jobId = NodeJobAssignmentSchema.parse(JSON.parse(assignment.assignment)).jobId;
  const body = new PassThrough();
  bodies.push(body);
  return {
    core,
    gateway,
    nodeId,
    jobId,
    opened,
    body,
    frames,
    credential: paired.value.credential,
    advance: () => {
      now += LEASE_MS;
    },
  };
}

describe("screen upload leases", () => {
  it("refuses a cancelled job even though it retains its node", async () => {
    const test = await waitingMirror();
    expect(
      cancelJob(test.core.kernel, context, {
        jobId: test.jobId,
        idempotencyKey: "cancel",
      }).ok,
    ).toBe(true);
    expect(getJob(test.core.kernel.db, test.jobId)?.job.nodeId).toBe(test.nodeId);
    const accepted = test.gateway.accept(test.nodeId, test.jobId, {
      contentType: "multipart/x-mixed-replace;boundary=ffmpeg",
      body: test.body,
    });
    test.body.destroy();
    expect(await accepted).toBe(false);
  });

  it("refuses a lease at its expiry without waiting for a dispatch sweep", async () => {
    const test = await waitingMirror();
    test.advance();
    const accepted = test.gateway.accept(test.nodeId, test.jobId, {
      contentType: "multipart/x-mixed-replace;boundary=ffmpeg",
      body: test.body,
    });
    test.body.destroy();
    expect(await accepted).toBe(false);
  });
});

describe("screen HTTP relay", () => {
  it("keeps screen uploads alive past the request deadline while ordinary uploads time out", async () => {
    const { createServer } = await vi.importActual<typeof http>("node:http");
    vi.mocked(http.createServer).mockImplementation((options, listener) =>
      typeof options === "function"
        ? createServer(
            { requestTimeout: 1_000, headersTimeout: 1_000, connectionsCheckingInterval: 10 },
            options,
          )
        : createServer(
            {
              ...options,
              requestTimeout: 1_000,
              headersTimeout: 1_000,
              connectionsCheckingInterval: 10,
            },
            listener,
          ),
    );
    const test = await waitingMirror();
    expect(vi.mocked(http.createServer).mock.results.at(-1)?.value).toHaveProperty(
      "requestTimeout",
      1_000,
    );
    vi.mocked(http.createServer).mockReset();
    const viewer = new AbortController();
    const response = fetch(
      `http://127.0.0.1:${String(test.core.port)}/screen/live?node=${test.nodeId}`,
      {
        headers: { authorization: "Bearer 0123456789abcdef0123456789abcdef" },
        signal: viewer.signal,
      },
    );
    await vi.waitFor(() =>
      expect(test.frames.filter((frame) => frame.kind === "job")).toHaveLength(2),
    );
    const frame = test.frames.filter((frame) => frame.kind === "job")[1];
    if (frame?.kind !== "job") throw new Error("no viewer job");
    const jobId = NodeJobAssignmentSchema.parse(JSON.parse(frame.assignment)).jobId;
    const upload = httpRequest(`http://127.0.0.1:${String(test.core.port)}/node/files`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${test.nodeId}.${test.credential}`,
        "x-noctis-job": jobId,
        "content-type": "multipart/x-mixed-replace;boundary=ffmpeg",
      },
    });
    let uploadStatus: number | undefined;
    upload.on("response", (res) => {
      uploadStatus = res.statusCode;
      res.resume();
    });
    upload.on("error", () => undefined);
    const ordinary = httpRequest(
      `http://127.0.0.1:${String(test.core.port)}/commands/node.grant_capability`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer 0123456789abcdef0123456789abcdef",
          "content-type": "application/json",
        },
      },
    );
    let ordinaryStatus: number | undefined;
    ordinary.on("response", (res) => {
      ordinaryStatus = res.statusCode;
      res.resume();
    });
    ordinary.on("error", () => undefined);
    const pulse = setInterval(() => {
      upload.write("frame\r\n");
      ordinary.write(" ");
    }, 30);
    try {
      upload.write("--ffmpeg\r\nframe-before-deadline\r\n");
      ordinary.write("{");
      const reader = (await response).body?.getReader();
      await vi.waitFor(() => expect(ordinaryStatus).toBe(408), { timeout: 4_000 });
      clearInterval(pulse);
      upload.write("frame-after-deadline\r\n");
      let received = "";
      while (!received.includes("frame-after-deadline")) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) break;
        received += Buffer.from(chunk.value).toString();
      }
      expect(received).toContain("frame-after-deadline");
      expect(uploadStatus).toBeUndefined();
    } finally {
      clearInterval(pulse);
      upload.destroy();
      ordinary.destroy();
      viewer.abort();
      await response.catch(() => undefined);
    }
  });

  it("ends the viewer response when the node aborts its upload", async () => {
    const test = await waitingMirror();
    const viewer = new AbortController();
    const response = fetch(
      `http://127.0.0.1:${String(test.core.port)}/screen/live?node=${test.nodeId}`,
      {
        headers: { authorization: "Bearer 0123456789abcdef0123456789abcdef" },
        signal: viewer.signal,
      },
    );
    await vi.waitFor(() =>
      expect(test.frames.filter((frame) => frame.kind === "job")).toHaveLength(2),
    );
    const frame = test.frames.filter((frame) => frame.kind === "job")[1];
    if (frame?.kind !== "job") throw new Error("no viewer job");
    const jobId = NodeJobAssignmentSchema.parse(JSON.parse(frame.assignment)).jobId;
    const upload = httpRequest(`http://127.0.0.1:${String(test.core.port)}/node/files`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${test.nodeId}.${test.credential}`,
        "x-noctis-job": jobId,
        "content-type": "multipart/x-mixed-replace;boundary=ffmpeg",
      },
    });
    upload.on("error", () => undefined);
    try {
      upload.write("--ffmpeg\r\nframe-1\r\n");
      const reader = (await response).body?.getReader();
      expect((await reader?.read())?.done).toBe(false);
      upload.destroy();
      let ended = false;
      const read = reader?.read().then(
        () => {
          ended = true;
        },
        () => {
          ended = true;
        },
      );
      await vi.waitFor(() => expect(ended).toBe(true));
      await read;
    } finally {
      upload.destroy();
      viewer.abort();
      await response.catch(() => undefined);
    }
  });
});

describe("leaving before the first frame", () => {
  it("cancels the leased job and tells the node when opening is aborted", async () => {
    const controller = new AbortController();
    const test = await waitingMirror(controller.signal);
    controller.abort();
    expect(getJob(test.core.kernel.db, test.jobId)?.job.status).toBe("cancelled");
    expect(test.frames).toContainEqual(
      expect.objectContaining({ kind: "cancel", jobId: test.jobId }),
    );
    await expect(test.opened).rejects.toMatchObject({ status: 503 });
  });

  it("cancels capture when the startup deadline expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const test = await waitingMirror();
    await vi.advanceTimersByTimeAsync(SCREEN_ANSWER_MS);
    await expect(test.opened).rejects.toMatchObject({ status: 504 });
    expect(getJob(test.core.kernel.db, test.jobId)?.job.status).toBe("cancelled");
    expect(test.frames).toContainEqual(
      expect.objectContaining({ kind: "cancel", jobId: test.jobId }),
    );
    expect(
      await test.gateway.accept(test.nodeId, test.jobId, {
        contentType: "multipart/x-mixed-replace;boundary=ffmpeg",
        body: test.body,
      }),
    ).toBe(false);
  });

  it("cancels when the HTTP viewer closes while still connecting", async () => {
    const test = await waitingMirror();
    const controller = new AbortController();
    const response = fetch(
      `http://127.0.0.1:${String(test.core.port)}/screen/live?node=${test.nodeId}`,
      {
        headers: { authorization: "Bearer 0123456789abcdef0123456789abcdef" },
        signal: controller.signal,
      },
    ).catch(() => undefined);
    await vi.waitFor(() =>
      expect(test.frames.filter((frame) => frame.kind === "job")).toHaveLength(2),
    );
    const frame = test.frames.filter((frame) => frame.kind === "job")[1];
    if (frame?.kind !== "job") throw new Error("no viewer job");
    const jobId = NodeJobAssignmentSchema.parse(JSON.parse(frame.assignment)).jobId;
    controller.abort();
    await response;
    await vi.waitFor(() =>
      expect(getJob(test.core.kernel.db, jobId)?.job.status).toBe("cancelled"),
    );
    expect(test.frames).toContainEqual(expect.objectContaining({ kind: "cancel", jobId }));
  });
});
