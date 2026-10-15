import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { ScreenHelper } from "./helper.js";
import { SCREEN_TOKEN_HEADER, helperInfoPath, startHelper } from "./helper.js";

const FAKE_FFMPEG = join(import.meta.dirname, "fake-ffmpeg.ts");

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

async function helperWithFake(
  ffmpeg?: readonly string[],
): Promise<{ helper: ScreenHelper; log: string }> {
  const scratch = mkdtempSync(join(tmpdir(), "noctis-screen-"));
  const log = join(scratch, "ffmpeg.json");

  scratches.push(scratch);

  const helper = await startHelper({
    ffmpeg: ffmpeg ?? [process.execPath, FAKE_FFMPEG, log],
    infoPath: join(scratch, "screen-helper.json"),
    watchPresence: () => () => undefined,
  });

  helpers.push(helper);

  return { helper, log };
}

function mirror(
  helper: ScreenHelper,
  query: string,
  token: string | null = helper.token,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(helper.port)}/mirror?${query}`, {
    headers: token === null ? {} : { [SCREEN_TOKEN_HEADER]: token },
    ...(signal === undefined ? {} : { signal }),
  });
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

describe("the screen helper", () => {
  it("reports only its owner's session state through the authenticated presence path without capturing", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "noctis-presence-helper-"));
    scratches.push(scratch);
    let report: (present: boolean) => void = () => undefined;
    const helper = await startHelper({
      infoPath: join(scratch, "screen-helper.json"),
      watchPresence: (onPresence) => {
        report = onPresence;
        return () => undefined;
      },
    });
    helpers.push(helper);
    const presence = () =>
      fetch(`http://127.0.0.1:${helper.port}/presence`, {
        headers: { [SCREEN_TOKEN_HEADER]: helper.token },
      });
    expect((await fetch(`http://127.0.0.1:${helper.port}/presence`)).status).toBe(401);
    expect(await (await presence()).json()).toEqual({ present: false });
    report(true);
    expect(await (await presence()).json()).toEqual({ present: true });
    report(false);
    expect(await (await presence()).json()).toEqual({ present: false });
  });
  it("kills fake ffmpeg when its helper process shuts down before any frame", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "noctis-helper-process-"));
    scratches.push(scratch);
    const infoPath = join(scratch, "screen-helper.json");
    const log = join(scratch, "ffmpeg.json");
    const stop = join(scratch, "stop");
    writeFileSync(`${log}.stalled`, "");
    const script = `
      import { existsSync } from 'node:fs';
      import { startHelper } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../../dist/screen/helper.js")).href)};
      await startHelper({ ffmpeg: ${JSON.stringify([process.execPath, FAKE_FFMPEG, log])}, infoPath: ${JSON.stringify(infoPath)}, watchPresence: () => () => undefined });
      const timer = setInterval(() => {
        if (existsSync(${JSON.stringify(stop)})) {
          clearInterval(timer);
          process.emit('SIGTERM');
        }
      }, 20);
    `;
    const helper = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: "inherit",
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => helper.once("exit", () => resolve()));
    let request: ReturnType<typeof get> | undefined;
    let ffmpegPid: number | undefined;
    try {
      await waitFor(() => existsSync(infoPath), "the helper process to listen");
      const info = JSON.parse(readFileSync(infoPath, "utf8")) as { port: number; token: string };
      request = get(
        `http://127.0.0.1:${String(info.port)}/mirror?fps=15&width=1280`,
        {
          headers: { [SCREEN_TOKEN_HEADER]: info.token },
        },
        (response) => response.resume(),
      );
      request.on("error", () => undefined);
      await waitFor(() => existsSync(log), "fake ffmpeg to start");
      ffmpegPid = (JSON.parse(readFileSync(log, "utf8")) as { pid: number }).pid;
      expect(alive(ffmpegPid)).toBe(true);
      writeFileSync(stop, "");
      await waitFor(
        () => helper.exitCode !== null || helper.signalCode !== null,
        "the helper to exit",
      );
      await waitFor(
        () => ffmpegPid !== undefined && !alive(ffmpegPid),
        "the orphan capture to exit",
      );
    } finally {
      request?.destroy();
      if (helper.exitCode === null && helper.signalCode === null) helper.kill();
      if (ffmpegPid !== undefined && alive(ffmpegPid)) process.kill(ffmpegPid);
      await exited;
    }
  });

  it("listens on loopback only and says where in the owner's profile", async () => {
    const { helper } = await helperWithFake();
    const info = JSON.parse(readFileSync(helper.infoPath, "utf8")) as Record<string, unknown>;

    expect(helper.address).toBe("127.0.0.1");
    expect(info).toEqual({ port: helper.port, token: helper.token, pid: process.pid });
    expect(helper.token).toMatch(/^[0-9a-f]{64}$/);
    expect(helperInfoPath({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" })).toBe(
      join("C:\\Users\\me\\AppData\\Local", "Noctis", "screen-helper.json"),
    );
  });

  it("refuses a request without its token", async () => {
    const { helper } = await helperWithFake();

    const none = await mirror(helper, "fps=15&width=1280", null);
    const wrong = await mirror(helper, "fps=15&width=1280", "0".repeat(64));

    expect(none.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it("refuses a size or rate outside the fixed steps", async () => {
    const { helper } = await helperWithFake();

    expect((await mirror(helper, "fps=60&width=1280")).status).toBe(400);
    expect((await mirror(helper, "fps=15&width=4000")).status).toBe(400);
  });

  it("runs ffmpeg with exactly the capture arguments, for each rate and size", async () => {
    const { helper, log } = await helperWithFake();

    for (const fps of [15, 30]) {
      for (const width of [960, 1280, 1920]) {
        const controller = new AbortController();
        const response = await mirror(
          helper,
          `fps=${String(fps)}&width=${String(width)}`,
          helper.token,
          controller.signal,
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "multipart/x-mixed-replace;boundary=ffmpeg",
        );

        const ran = JSON.parse(readFileSync(log, "utf8")) as { args: string[] };

        expect(ran.args).toEqual([
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "gdigrab",
          "-framerate",
          String(fps),
          "-i",
          "desktop",
          "-vf",
          `scale=${String(width)}:-2`,
          "-q:v",
          "7",
          "-f",
          "mpjpeg",
          "-",
        ]);
        controller.abort();
      }
    }
  });

  it("streams ffmpeg's frames and kills it within two seconds of the viewer leaving", async () => {
    const { helper, log } = await helperWithFake();
    const controller = new AbortController();
    const response = await mirror(helper, "fps=15&width=1280", helper.token, controller.signal);
    const reader = response.body?.getReader();
    let received = "";

    while (!received.includes("frame-3")) {
      const chunk = await reader?.read();

      if (chunk === undefined || chunk.done) {
        throw new Error("the stream ended before three frames");
      }

      received += Buffer.from(chunk.value).toString("latin1");
    }

    expect(received.startsWith("--ffmpeg\r\nContent-type: image/jpeg\r\n")).toBe(true);

    const { pid } = JSON.parse(readFileSync(log, "utf8")) as { pid: number };

    expect(alive(pid)).toBe(true);
    controller.abort();
    await waitFor(() => !alive(pid), "ffmpeg to be killed");
  });

  it("answers 423 when the desktop is locked", async () => {
    const { helper, log } = await helperWithFake();

    writeFileSync(`${log}.locked`, "");

    const response = await mirror(helper, "fps=15&width=1280");

    expect(response.status).toBe(423);
    expect(await response.json()).toEqual({ locked: true });
  });

  it("says so when ffmpeg is not installed", async () => {
    const { helper } = await helperWithFake([join(tmpdir(), "no-such-ffmpeg-here.exe")]);

    const response = await mirror(helper, "fps=15&width=1280");

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain("ffmpeg");
  });
});
