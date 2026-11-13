import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { createLogger } from "../logging.js";
import { startCore, type RunningCore } from "../server.js";

const token = "0123456789abcdef0123456789abcdef";
let core: RunningCore | undefined;
let directory: string;

afterEach(async () => {
  await core?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it("serves the lights behind the gate and refuses a change until a PC is allowed", async () => {
  directory = mkdtempSync(join(tmpdir(), "noctis-lights-"));
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
  const owner = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  expect((await fetch(`${base}/lights`)).status).toBe(401);
  const status = await fetch(`${base}/lights`, { headers: owner });
  expect(await status.json()).toEqual({ granted: false, nodeId: null, nodeOnline: false });

  const set = (body: unknown) =>
    fetch(`${base}/lights/set`, { method: "POST", headers: owner, body: JSON.stringify(body) });
  expect((await set({ idempotencyKey: "k" })).status).toBe(400);
  const refused = await set({ idempotencyKey: "k", scene: "cinema" });
  expect(refused.status).toBe(409);
});
