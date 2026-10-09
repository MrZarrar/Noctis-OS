import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScreenViewEvidenceSchema } from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { AdapterContext } from "../adapters.js";
import { AdapterRefused } from "../adapters.js";
import type { ScreenHelper } from "./helper.js";
import { startHelper } from "./helper.js";
import { createScreenView } from "./view.js";

const FAKE_FFMPEG = join(import.meta.dirname, "fake-ffmpeg.ts");
const PAYLOAD = { fps: 15, width: 1280 };

const helpers: ScreenHelper[] = [];
const scratches: string[] = [];

afterEach(async () => {
  while (helpers.length > 0) {
    await helpers.pop()?.close();
  }

  while (scratches.length > 0) {
    rmSync(scratches.pop() ?? "", { recursive: true, force: true });
  }
});

function scratch(): { infoPath: string; log: string } {
  const directory = mkdtempSync(join(tmpdir(), "noctis-view-"));

  scratches.push(directory);

  return { infoPath: join(directory, "screen-helper.json"), log: join(directory, "ffmpeg.json") };
}

async function fakeHelper(at: { infoPath: string; log: string }): Promise<ScreenHelper> {
  const helper = await startHelper({
    ffmpeg: [process.execPath, FAKE_FFMPEG, at.log],
    infoPath: at.infoPath,
  });

  helpers.push(helper);

  return helper;
}

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    grants: [],
    signal: new AbortController().signal,
    progress: () => undefined,
    stream: () => undefined,
    delta: () => undefined,
    ask: () => Promise.reject(new Error("no ask expected")),
    env: {},
    runtimes: {},
    fetchAttachment: () => Promise.reject(new Error("no attachment expected")),
    delegate: () => Promise.reject(new Error("no delegation expected")),
    uploadOutput: () => Promise.reject(new Error("no output expected")),
    streamFile: () => Promise.reject(new Error("no file expected")),
    streamScreen: () => Promise.reject(new Error("no screen expected")),
    ...overrides,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("screen.view on the node", () => {
  it("streams the helper's frames to the core, and a core that hangs up is the viewer leaving", async () => {
    const at = scratch();

    await fakeHelper(at);

    let contentType = "";
    let received = "";

    const evidence = ScreenViewEvidenceSchema.parse(
      await createScreenView({ infoPath: at.infoPath, interactive: () => Promise.resolve(false) })(
        PAYLOAD,
        context({
          async streamScreen(screen) {
            contentType = screen.contentType;

            const reader = screen.body.getReader();

            while (!received.includes("frame-3")) {
              const chunk = await reader.read();

              if (chunk.done) {
                return;
              }

              received += Buffer.from(chunk.value).toString("latin1");
            }

            await reader.cancel();
            throw new Error("other side closed");
          },
        }),
      ),
    );

    expect(contentType).toBe("multipart/x-mixed-replace;boundary=ffmpeg");
    expect(received.indexOf("frame-1")).toBeLessThan(received.indexOf("frame-2"));
    expect(evidence.endedBy).toBe("client");
    expect(evidence.frames).toBeGreaterThanOrEqual(3);

    const { pid } = JSON.parse(readFileSync(at.log, "utf8")) as { pid: number };

    await waitFor(() => !alive(pid), "ffmpeg to stop once nobody watches");
  });

  it("reports a locked desktop as how it ended, not as a failure", async () => {
    const at = scratch();

    await fakeHelper(at);
    writeFileSync(`${at.log}.locked`, "");

    expect(
      await createScreenView({ infoPath: at.infoPath, interactive: () => Promise.resolve(false) })(
        PAYLOAD,
        context(),
      ),
    ).toEqual({ frames: 0, endedBy: "locked" });
  });

  it("refuses with the setup step when no helper runs and this node has no desktop", async () => {
    const at = scratch();
    let started = 0;

    await expect(
      createScreenView({
        infoPath: at.infoPath,
        interactive: () => Promise.resolve(false),
        startHelper: () => {
          started += 1;
        },
      })(PAYLOAD, context()),
    ).rejects.toThrow(/HOME-SETUP/);
    expect(started).toBe(0);
  });

  it("treats a helper file left by a process that has gone as no helper", async () => {
    const at = scratch();
    const gone = spawnSync(process.execPath, ["-e", "process.pid"]).pid;

    writeFileSync(at.infoPath, JSON.stringify({ port: 1, token: "a".repeat(64), pid: gone }));

    await expect(
      createScreenView({ infoPath: at.infoPath, interactive: () => Promise.resolve(false) })(
        PAYLOAD,
        context(),
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("starts the helper itself in the owner's session, and waits for it", async () => {
    const at = scratch();
    let started = 0;

    writeFileSync(`${at.log}.locked`, "");

    const evidence = await createScreenView({
      infoPath: at.infoPath,
      interactive: () => Promise.resolve(true),
      startHelper: () => {
        started += 1;
        // Late on purpose: the node has to wait for the file, not find it.
        setTimeout(() => void fakeHelper(at), 300);
      },
    })(PAYLOAD, context());

    expect(started).toBe(1);
    expect(evidence).toEqual({ frames: 0, endedBy: "locked" });
  });
});
