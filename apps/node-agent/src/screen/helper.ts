import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ScreenViewPayload } from "@noctis/contracts";
import { ScreenViewPayloadSchema } from "@noctis/contracts";
import { watchWindowsOwnerPresence } from "./presence.js";

/**
 * The screen helper: a small loopback server in the signed-in owner's session
 * that runs ffmpeg against the desktop for as long as someone is watching.
 *
 * It is a separate process from the node agent because the agent may live in
 * session 0, where there is no desktop to capture. The agent finds it through
 * the file it writes into the owner's profile, which only the owner can read,
 * and every request has to carry the token from that file.
 *
 * ponytail: MJPEG, one JPEG per frame, about 1-2 MB/s at 15 fps and 1280 wide.
 * Simple enough that an <img> on an iPhone plays it with no decoder. If it
 * hurts on mobile data, the upgrade is H.264 into Media Source Extensions.
 */

export const SCREEN_TOKEN_HEADER = "x-noctis-screen-token";

/** ffmpeg's mpjpeg muxer separates frames with `--ffmpeg` unless told otherwise. */
export const MIRROR_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=ffmpeg";

/**
 * gdigrab cannot read a locked desktop or the secure one a UAC prompt is on:
 * the capture fails with ERROR_ACCESS_DENIED. ponytail: matched on ffmpeg's
 * message, since a dying ffmpeg gives nothing better to go on.
 */
const LOCKED = /error 5\b|access is denied|failed to capture image/i;

export function helperInfoPath(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCALAPPDATA?.trim();

  return join(
    local === undefined || local === "" ? join(homedir(), "AppData", "Local") : local,
    "Noctis",
    "screen-helper.json",
  );
}

export function ffmpegArguments({ fps, width }: ScreenViewPayload): string[] {
  return [
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
  ];
}

export interface ScreenHelper {
  address: string;
  port: number;
  token: string;
  infoPath: string;
  close(): Promise<void>;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    return;
  }

  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function startHelper(
  options: {
    /** The command and any leading arguments. Tests put a fake here. */
    ffmpeg?: readonly string[];
    infoPath?: string;
    watchPresence?: (onPresence: (present: boolean) => void) => () => void;
  } = {},
): Promise<ScreenHelper> {
  const configured = process.env.NOCTIS_FFMPEG?.trim();
  const [command = "ffmpeg", ...prefix] = options.ffmpeg ?? [
    configured === undefined || configured === "" ? "ffmpeg" : configured,
  ];
  const infoPath = options.infoPath ?? helperInfoPath();
  const token = randomBytes(32).toString("hex");
  const expected = digest(token);
  const captures = new Set<ChildProcess>();
  let ownerPresent = false;
  const stopPresence = (
    options.watchPresence ??
    (process.env.NOCTIS_OWNER_PRESENCE === "1" ? watchWindowsOwnerPresence : () => () => undefined)
  )((present) => {
    ownerPresent = present;
  });
  let presenceStopped = false;
  const killCaptures = () => {
    if (!presenceStopped) {
      presenceStopped = true;
      stopPresence();
    }
    for (const capture of captures) {
      if (capture.exitCode === null && capture.signalCode === null) capture.kill();
    }
  };

  const server = createServer((req, res) => {
    const presented = req.headers[SCREEN_TOKEN_HEADER];

    if (typeof presented !== "string" || !timingSafeEqual(digest(presented), expected)) {
      json(res, 401, { error: "the helper's token is required" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/presence") {
      json(res, 200, { present: ownerPresent });
      return;
    }

    if (req.method !== "GET" || url.pathname !== "/mirror") {
      json(res, 404, { error: "no such path" });
      return;
    }

    const request = ScreenViewPayloadSchema.safeParse({
      fps: Number(url.searchParams.get("fps")),
      width: Number(url.searchParams.get("width")),
    });

    if (!request.success) {
      json(res, 400, { error: "fps must be 15 or 30, and width 960, 1280 or 1920" });
      return;
    }

    const ffmpeg = spawn(command, [...prefix, ...ffmpegArguments(request.data)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    captures.add(ffmpeg);
    ffmpeg.once("close", () => captures.delete(ffmpeg));
    let stderr = "";

    // Nobody watching means nothing capturing.
    res.once("close", () => {
      if (ffmpeg.exitCode === null && ffmpeg.signalCode === null) {
        ffmpeg.kill();
      }
    });

    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
    });

    ffmpeg.once("error", () => {
      json(res, 503, {
        error: `ffmpeg did not start (${command}). Install it, or set NOCTIS_FFMPEG to ffmpeg.exe`,
      });
    });

    // The status waits for the first frame, so a capture that fails at once
    // can still say why instead of sending an empty 200.
    ffmpeg.stdout.once("data", (first: Buffer) => {
      res.writeHead(200, { "content-type": MIRROR_CONTENT_TYPE, "cache-control": "no-store" });
      res.write(first);
      ffmpeg.stdout.pipe(res);
    });

    ffmpeg.once("close", (code) => {
      if (res.headersSent) {
        res.end();
      } else if (LOCKED.test(stderr)) {
        json(res, 423, { locked: true });
      } else {
        json(res, 500, { error: stderr.trim() || `ffmpeg exited with ${String(code)}` });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const bound = server.address();

  if (bound === null || typeof bound === "string") {
    throw new Error("the screen helper did not bind a TCP port");
  }

  mkdirSync(dirname(infoPath), { recursive: true });
  writeFileSync(
    infoPath,
    JSON.stringify({ port: bound.port, token, pid: process.pid }),
    // Sits in the owner's profile, which is what keeps the token the owner's.
    { mode: 0o600 },
  );

  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;

    killCaptures();
    process.removeListener("exit", killCaptures);
    for (const signal of signals) process.removeListener(signal, shutdown);
    rmSync(infoPath, { force: true });
    server.closeAllConnections();
    closing = new Promise<void>((resolve) => server.close(() => resolve()));

    return closing;
  };
  const shutdown = () => {
    void close();
  };

  process.on("exit", killCaptures);
  for (const signal of signals) process.on(signal, shutdown);

  return {
    address: bound.address,
    port: bound.port,
    token,
    infoPath,
    close,
  };
}

// Run directly, by the at-logon task or by a node in the owner's session.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const helper = await startHelper();

  process.stdout.write(`screen helper on 127.0.0.1:${String(helper.port)}\n`);
}
