import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "../logging.js";
import type { RunningCore } from "../server.js";
import { startCore } from "../server.js";

import { LOGIN_PATH } from "./http.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

interface TestCore {
  core: RunningCore;
  base: string;
}

const started: Array<{ core: RunningCore; directory: string }> = [];

async function startTestCore(videoEditorOrigin?: string): Promise<TestCore> {
  const directory = mkdtempSync(join(tmpdir(), "noctis-video-editor-"));
  const core = await startCore({
    config: {
      bindAddress: "127.0.0.1",
      port: 0,
      token: TOKEN,
      databasePath: join(directory, "core.db"),
      allowedOrigins: [],
      logLevel: "debug",
      sessionTtlHours: 720,
      ...(videoEditorOrigin === undefined ? {} : { videoEditorOrigin }),
    },
    env: {},
    logger: createLogger({ sink: () => undefined, level: "debug" }),
  });

  started.push({ core, directory });

  return { core, base: `http://127.0.0.1:${String(core.port)}` };
}

afterEach(async () => {
  while (started.length > 0) {
    const entry = started.pop();

    if (entry !== undefined) {
      await entry.core.close();
      rmSync(entry.directory, { recursive: true, force: true });
    }
  }
});

async function session(core: TestCore): Promise<Record<string, string>> {
  const response = await fetch(`${core.base}${LOGIN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
  const { csrf } = (await response.json()) as { csrf: string };

  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    "x-noctis-csrf": csrf,
  };
}

describe("GET /video-editor", () => {
  it("is off by default: no origin for the page to open", async () => {
    const core = await startTestCore();

    const response = await fetch(`${core.base}/video-editor`, { headers: await session(core) });

    expect(await response.json()).toEqual({ origin: null });
  });

  it("reports the configured origin", async () => {
    const core = await startTestCore("http://100.70.27.11:7700");

    const response = await fetch(`${core.base}/video-editor`, { headers: await session(core) });

    expect(await response.json()).toEqual({ origin: "http://100.70.27.11:7700" });
  });

  it("requires a session like every other read", async () => {
    const core = await startTestCore("http://100.70.27.11:7700");

    const response = await fetch(`${core.base}/video-editor`);

    expect(response.status).toBe(401);
  });
});
