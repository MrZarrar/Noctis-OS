import { type ChildProcess, execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { win32 } from "node:path";

import type { AgentLogger } from "./agent.js";
import { inInteractiveSession } from "./screen/view.js";

export const SAMPLE_RATE = 16_000;
/** 10 ms. Every timing below is a count of these. */
const FRAME = SAMPLE_RATE / 100;
/** A clap is quiet again within 150 ms; a door, a voice or a song is not. */
const MAX_RING = 15;
const MIN_GAP = 15;
const MAX_GAP = 80;
/** After opening, three seconds in which nothing opens again. */
const COOLDOWN = 300;
/** How far above the recent level a clap must jump, so steady loud sound cannot pass for one. */
const ONSET_RATIO = 4;
const BACKGROUND_WEIGHT = 0.02;
const RETRY_MS = 30_000;
const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const SCREENS = String.raw`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | % { "$($_.Primary) $($_.Bounds.X) $($_.Bounds.Y)" }`;

/**
 * Hears a double clap in 16 kHz mono samples, fed in chunks of any size.
 *
 * `push` is true when a second clap lands 150 to 800 ms after the first.
 * `onClap` hears every single clap with its peak, which is what to look at when
 * tuning the threshold.
 */
export function createClapDetector(options: {
  threshold: number;
  onClap?: (peak: number) => void;
}): { push: (samples: Int16Array) => boolean } {
  const { threshold, onClap } = options;
  const frame = new Int16Array(FRAME);
  let filled = 0;
  let now = 0;
  let background = 0;
  let state: "idle" | "clap" | "long" = "idle";
  let onset = 0;
  let onsetPeak = 0;
  let lastClap = Number.NEGATIVE_INFINITY;
  let quietUntil = 0;

  const step = (peak: number): boolean => {
    let fired = false;

    if (state === "idle") {
      if (now >= quietUntil && peak >= threshold && peak >= background * ONSET_RATIO) {
        state = "clap";
        onset = now;
        onsetPeak = peak;
      }
    } else if (peak < threshold / 2) {
      if (state === "clap") {
        onClap?.(onsetPeak);
        const gap = onset - lastClap;
        if (gap >= MIN_GAP && gap <= MAX_GAP) {
          fired = true;
          lastClap = Number.NEGATIVE_INFINITY;
          quietUntil = now + COOLDOWN;
        } else {
          lastClap = onset;
        }
      }
      state = "idle";
    } else if (now - onset > MAX_RING) {
      state = "long";
    }

    background += (peak - background) * BACKGROUND_WEIGHT;
    now += 1;
    return fired;
  };

  return {
    push(samples) {
      let fired = false;
      for (const sample of samples) {
        frame[filled] = sample;
        filled += 1;
        if (filled === FRAME) {
          filled = 0;
          let peak = 0;
          for (const value of frame) peak = Math.max(peak, Math.abs(value));
          if (step(peak / 32_768)) fired = true;
        }
      }
      return fired;
    },
  };
}

/** The audio devices in `ffmpeg -list_devices true -f dshow` output. */
export function parseAudioDevices(listing: string): string[] {
  return [...listing.matchAll(/"([^"]+)" \(audio\)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

export interface Screen {
  primary: boolean;
  x: number;
  y: number;
}

/** Lines of "<Primary> <X> <Y>", as the PowerShell query prints them. */
export function parseScreens(text: string): Screen[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const [primary, x, y] = line.trim().split(/\s+/);
    return x === undefined || y === undefined
      ? []
      : [{ primary: primary === "True", x: Number(x), y: Number(y) }];
  });
}

/**
 * Chrome's arguments for the two windows: Presence on the primary monitor, the
 * Vault on the other. Each has a profile of its own because Chrome honours
 * `--window-position` only when the launch starts a new browser process; a
 * second window in a profile already open lands where the first one did.
 */
export function windowLaunches(
  pageUrl: string,
  screens: readonly Screen[],
  profiles: string,
): string[][] {
  const primary = screens.find((screen) => screen.primary) ?? screens[0] ?? { x: 0, y: 0 };
  const other = screens.find((screen) => !screen.primary) ?? primary;

  return (
    [
      ["Presence", primary],
      ["Vault", other],
    ] as const
  ).map(([page, screen]) => [
    `--user-data-dir=${win32.join(profiles, page.toLowerCase())}`,
    `--app=${new URL(`/?screen=${page}`, pageUrl).toString()}`,
    // ponytail: a point just inside the monitor, then maximised there. Mixed DPI
    // scaling can shift it; set NOCTIS_CLAP_BROWSER to Edge or move the
    // monitors' arrangement if a window lands on the wrong one.
    `--window-position=${String(screen.x + 40)},${String(screen.y + 40)}`,
    "--start-maximized",
    "--no-first-run",
    "--no-default-browser-check",
  ]);
}

function firstMic(ffmpeg: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    // ffmpeg exits non-zero here by design: "dummy" is not a device.
    execFile(
      ffmpeg,
      ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
      { windowsHide: true },
      (_error, _stdout, stderr) => {
        resolve(parseAudioDevices(stderr)[0]);
      },
    );
  });
}

function screens(): Promise<Screen[]> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCREENS],
      { windowsHide: true },
      (_error, stdout) => {
        resolve(parseScreens(stdout));
      },
    );
  });
}

/**
 * Off unless NOCTIS_CLAP=1. Listens on the microphone through ffmpeg and, on a
 * double clap, opens Presence on monitor 1 and the Vault on monitor 2.
 */
export async function startClapToOpen(
  pageUrl: string,
  log: AgentLogger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => void> {
  if (!(await inInteractiveSession())) {
    log("warn", "clap to open needs the desktop session, so it is not listening");
    return () => undefined;
  }

  const ffmpeg = env.NOCTIS_FFMPEG?.trim() || "ffmpeg";
  const mic = env.NOCTIS_CLAP_MIC?.trim() || (await firstMic(ffmpeg));
  if (mic === undefined) {
    log("warn", "clap to open found no microphone; set NOCTIS_CLAP_MIC");
    return () => undefined;
  }

  const threshold = Number(env.NOCTIS_CLAP_THRESHOLD) || 0.3;
  const browser = env.NOCTIS_CLAP_BROWSER?.trim() || CHROME;
  const profiles = win32.join(env.LOCALAPPDATA ?? homedir(), "Noctis", "clap");
  let stopped = false;
  let child: ChildProcess | undefined;
  let retry: NodeJS.Timeout | undefined;

  const open = async (): Promise<void> => {
    for (const args of windowLaunches(pageUrl, await screens(), profiles)) {
      spawn(browser, args, { detached: true, stdio: "ignore", windowsHide: false })
        .on("error", (error) => {
          log("warn", "clap to open could not start the browser", {
            browser,
            error: error.message,
          });
        })
        .unref();
    }
    log("info", "double clap: opened Noctis");
  };

  const listen = (): void => {
    const detector = createClapDetector({
      threshold,
      onClap: (peak) => {
        log("debug", "clap heard", { peak: Math.round(peak * 100) / 100 });
      },
    });
    let odd: Buffer = Buffer.alloc(0);
    const capture = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "dshow",
        "-audio_buffer_size",
        "50",
        "-i",
        `audio=${mic}`,
        "-ac",
        "1",
        "-ar",
        String(SAMPLE_RATE),
        "-f",
        "s16le",
        "-",
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    child = capture;

    capture.stdout.on("data", (chunk: Buffer) => {
      const bytes = odd.length === 0 ? chunk : Buffer.concat([odd, chunk]);
      const whole = bytes.length - (bytes.length % 2);
      odd = bytes.subarray(whole);
      // A copy, because an Int16Array needs an even byte offset and a chunk need not start on one.
      const samples = new Int16Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + whole),
      );
      if (detector.push(samples)) void open();
    });
    capture.on("error", () => undefined);
    capture.on("close", () => {
      if (stopped) return;
      log("warn", "clap to open lost the microphone; trying again shortly", { mic });
      retry = setTimeout(listen, RETRY_MS);
    });
  };

  listen();
  log("info", "clap to open is listening", { mic, threshold });

  return () => {
    stopped = true;
    clearTimeout(retry);
    child?.kill();
  };
}
