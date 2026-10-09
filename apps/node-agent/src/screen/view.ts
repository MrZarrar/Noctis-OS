import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ScreenViewEvidence } from "@noctis/contracts";
import { ScreenViewPayloadSchema } from "@noctis/contracts";
import { z } from "zod";

import type { Adapter } from "../adapters.js";
import { TURN_HEARTBEAT_MS } from "../adapters.js";
import { AdapterRefused } from "../runtimes/Runtime.js";
import { SCREEN_TOKEN_HEADER, helperInfoPath } from "./helper.js";

const SETUP = "see HOME-SETUP.md, step 2: the screen mirror";

/** How long a helper this node started gets to write its file. */
const HELPER_START_MS = 10_000;

const HelperInfoSchema = z.object({
  port: z.int().min(1).max(65_535),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  pid: z.int().positive(),
});

/** The helper the file names, if its process is still there to answer. */
function runningHelper(infoPath: string): z.infer<typeof HelperInfoSchema> | undefined {
  try {
    const info = HelperInfoSchema.parse(JSON.parse(readFileSync(infoPath, "utf8")));

    process.kill(info.pid, 0);
    return info;
  } catch {
    return undefined;
  }
}

/**
 * Whether this process sits in a session with a desktop. Services and S4U
 * tasks run in session 0, which has none, so the question is just the session
 * number. Asked of `tasklist` rather than read from `SESSIONNAME`, which is
 * only an environment variable and travels with whatever started the process.
 */
export async function inInteractiveSession(): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }

  try {
    const { stdout } = await promisify(execFile)(
      "tasklist",
      ["/FI", `PID eq ${String(process.pid)}`, "/FO", "CSV", "/NH"],
      { windowsHide: true },
    );
    const session = /^"[^"]*","\d+","[^"]*","(\d+)"/m.exec(stdout)?.[1];

    return session !== undefined && session !== "0";
  } catch {
    return false;
  }
}

/** The built helper beside this file, outliving the node so a restart finds it again. */
function startHelperProcess(): void {
  spawn(process.execPath, [join(import.meta.dirname, "helper.js")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

/**
 * Counts frames as they pass by their part headers. A header can straddle two
 * chunks, so the tail of one is kept to search with the next.
 */
function frameCounter(boundary: string): {
  stream: TransformStream<Uint8Array, Uint8Array>;
  frames: () => number;
} {
  const marker = Buffer.from(`--${boundary}\r\nContent-`);
  let tail = Buffer.alloc(0);
  let frames = 0;

  return {
    frames: () => frames,
    stream: new TransformStream({
      transform(chunk, controller) {
        const joined = Buffer.concat([tail, chunk]);

        for (let at = joined.indexOf(marker); at !== -1; at = joined.indexOf(marker, at + 1)) {
          frames += 1;
        }

        tail = joined.subarray(Math.max(0, joined.length - marker.length + 1));
        controller.enqueue(chunk);
      },
    }),
  };
}

/** Why the helper said no, in its own words when it gave some. */
async function refusal(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };

    return typeof body.error === "string" ? body.error : `HTTP ${String(response.status)}`;
  } catch {
    return `HTTP ${String(response.status)}`;
  }
}

/**
 * The node's half of the screen mirror: find the helper in the owner's
 * session, open its stream, and hand that to the core for this job until the
 * core hangs up. Closing the helper request is what stops ffmpeg, so every way
 * out of here closes it.
 */
export function createScreenView(
  options: {
    infoPath?: string;
    interactive?: () => Promise<boolean>;
    startHelper?: () => void;
  } = {},
): Adapter {
  return async (payload, context) => {
    const request = ScreenViewPayloadSchema.parse(payload);
    const infoPath = options.infoPath ?? helperInfoPath(context.env);
    let helper = runningHelper(infoPath);

    if (helper === undefined) {
      if (!(await (options.interactive ?? inInteractiveSession)())) {
        throw new AdapterRefused(
          `No screen helper is running in the owner's session on this PC (${SETUP})`,
        );
      }

      (options.startHelper ?? startHelperProcess)();

      for (const deadline = Date.now() + HELPER_START_MS; helper === undefined;) {
        if (Date.now() > deadline || context.signal.aborted) {
          throw new AdapterRefused(`The screen helper did not start (${SETUP})`);
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
        helper = runningHelper(infoPath);
      }
    }

    const toHelper = new AbortController();
    const stop = (): void => toHelper.abort();
    const heartbeat = setInterval(() => context.progress(0, "mirroring"), TURN_HEARTBEAT_MS);

    heartbeat.unref();
    context.signal.addEventListener("abort", stop);

    try {
      // A cancel that landed while the helper was coming up has already fired
      // its event, so the listener above would never hear it.
      if (context.signal.aborted) {
        return { frames: 0, endedBy: "client" } satisfies ScreenViewEvidence;
      }

      let response: Response;

      try {
        response = await fetch(
          `http://127.0.0.1:${String(helper.port)}/mirror?fps=${String(request.fps)}&width=${String(request.width)}`,
          { headers: { [SCREEN_TOKEN_HEADER]: helper.token }, signal: toHelper.signal },
        );
      } catch {
        throw new AdapterRefused(`The screen helper is not answering (${SETUP})`);
      }

      if (response.status === 423) {
        await response.body?.cancel();
        return { frames: 0, endedBy: "locked" } satisfies ScreenViewEvidence;
      }

      if (!response.ok || response.body === null) {
        throw new AdapterRefused(
          `The screen helper could not capture: ${await refusal(response)} (${SETUP})`,
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      const counter = frameCounter(/boundary=([^;\s]+)/.exec(contentType)?.[1] ?? "ffmpeg");

      try {
        await context.streamScreen({
          contentType,
          body: response.body.pipeThrough(counter.stream),
        });
      } catch {
        // The core hung up: the browser watching went away, or the job was cancelled.
        return { frames: counter.frames(), endedBy: "client" } satisfies ScreenViewEvidence;
      }

      // The capture ended on its own, which only ffmpeg dying does.
      return { frames: counter.frames(), endedBy: "error" } satisfies ScreenViewEvidence;
    } finally {
      clearInterval(heartbeat);
      context.signal.removeEventListener("abort", stop);
      toHelper.abort();
    }
  };
}
