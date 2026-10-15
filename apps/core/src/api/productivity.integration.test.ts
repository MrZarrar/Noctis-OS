import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startCore, type RunningCore } from "../server.js";
import { createLogger } from "../logging.js";
const token = "0123456789abcdef0123456789abcdef";
let core: RunningCore | undefined;
let directory: string;
afterEach(async () => {
  await core?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
it("authenticates productivity reads and persists revision-checked capture commands", async () => {
  directory = mkdtempSync(join(tmpdir(), "noctis-productivity-"));
  core = await startCore({
    config: {
      bindAddress: "127.0.0.1",
      port: 0,
      token,
      databasePath: join(directory, "core.db"),
      allowedOrigins: [],
      logLevel: "error",
      sessionTtlHours: 720,
    },
    env: {},
    logger: createLogger({ sink: () => undefined }),
  });
  const base = `http://127.0.0.1:${core.port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  for (const path of ["reminders", "notes", "tasks"]) {
    expect((await fetch(`${base}/${path}`)).status).toBe(401);
    const response = await fetch(`${base}/${path}`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ [path]: [] });
  }
  const send = (name: string, body: unknown) =>
    fetch(`${base}/commands/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  const command = {
    idempotencyKey: "todo",
    identityId: "jester",
    text: "Call garage",
    trigger: null,
  };
  const added = await send("reminder.create", command);
  expect(added.status).toBe(200);
  const reminder = (await added.json()) as { id: string; revision: number };
  const replay = await send("reminder.create", command);
  expect(await replay.json()).toEqual(reminder);
  expect(
    (
      await send("reminder.complete", {
        idempotencyKey: "wrong-rev",
        reminderId: reminder.id,
        expectedRevision: 9,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await send("reminder.complete", {
        idempotencyKey: "done",
        reminderId: reminder.id,
        expectedRevision: 0,
      })
    ).status,
  ).toBe(200);
  expect((await fetch(`${base}/reminders?status=invalid`, { headers })).status).toBe(400);
  const note = await send("note.create", {
    idempotencyKey: "note",
    identityId: "vesper",
    title: "Idea",
    body: "Buy jasmine",
  });
  expect(note.status).toBe(200);
  expect(await (await fetch(`${base}/notes?query=JASMINE`, { headers })).json()).toMatchObject({
    notes: [{ title: "Idea" }],
  });
  expect(
    (
      await send("reminder.create", {
        ...command,
        idempotencyKey: "past",
        trigger: { kind: "at", at: "2020-01-01T00:00:00Z" },
      })
    ).status,
  ).toBe(400);
  const deletion = { idempotencyKey: "delete", reminderId: reminder.id, expectedRevision: 1 };
  const deleted = await send("reminder.delete", deletion);
  expect(deleted.status).toBe(200);
  expect(await (await send("reminder.delete", deletion)).json()).toEqual(await deleted.json());
  const code = (await (
    await send("node.issue_pairing_code", { idempotencyKey: "code", hostId: "fixture" })
  ).json()) as { code: string };
  const pair = await fetch(`${base}/node/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: code.code,
      hostId: "fixture",
      fingerprint: "fixture",
      agentVersion: "test",
    }),
  });
  const node = (await pair.json()) as { nodeId: string };
  expect(
    (
      await send("node.grant_capability", {
        idempotencyKey: "grant",
        nodeId: node.nodeId,
        capability: "runtime.turn",
        constraints: {
          providers: ["codex"],
          roots: [{ grantId: "repo", path: "C:/fixture", mode: "write", localOnly: false }],
        },
      })
    ).status,
  ).toBe(200);
  const taskCommand = {
    idempotencyKey: "task",
    identityId: "vesper",
    name: "Check repo",
    prompt: "List changes",
    model: { providerId: "codex", model: "fake" },
    nodeId: node.nodeId,
    rootGrantId: "repo",
    trigger: { kind: "repeat", rule: { kind: "interval", hours: 1 } },
  };
  const taskResponse = await send("task.create", taskCommand);
  expect(taskResponse.status).toBe(200);
  const task = (await taskResponse.json()) as { id: string; paused: boolean };
  expect(task.paused).toBe(true);
  expect(
    (await send("task.create", { ...taskCommand, idempotencyKey: "forged-on", paused: false }))
      .status,
  ).toBe(400);
  expect(await (await fetch(`${base}/tasks/${task.id}/runs`, { headers })).json()).toEqual({
    runs: [],
  });
  expect(
    (await send("task.resume", { idempotencyKey: "on", taskId: task.id, expectedRevision: 0 }))
      .status,
  ).toBe(200);
  expect(
    (await send("task.run_now", { idempotencyKey: "run", taskId: task.id, expectedRevision: 1 }))
      .status,
  ).toBe(503);
});
