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
/** How long a launched window has to appear before the placer gives up on it. */
const LAUNCH_WAIT_SECONDS = 20;

/**
 * Finds each profile's Chrome window, restores it, moves it to its monitor,
 * maximises it there and raises it, printing "placed <name>" for each one it
 * found. Reads its request from NOCTIS_CLAP_PLACE, so no value is ever spliced
 * into the script. Chrome's own `--start-maximized` is ignored beside a
 * position, and a launch never reuses an open window, which is why this exists.
 */
const PLACER = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NoctisClapWindows {
  delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint relation);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  // The browser's titled, unowned top-level window. Chrome keeps hidden helper windows of the same class.
  public static IntPtr Find(int[] pids) {
    var owned = new HashSet<uint>();
    foreach (var pid in pids) owned.Add((uint)pid);
    var found = IntPtr.Zero;
    EnumWindows((window, data) => {
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      if (!owned.Contains(pid) || !IsWindowVisible(window) || GetWindowTextLength(window) == 0 || GetWindow(window, 4) != IntPtr.Zero) return true;
      var name = new StringBuilder(64);
      GetClassName(window, name, 64);
      if (name.ToString() != "Chrome_WidgetWin_1") return true;
      found = window;
      return false;
    }, IntPtr.Zero);
    return found;
  }
  public static void Place(IntPtr window, int x, int y, int width, int height) {
    ShowWindow(window, 9);
    SetWindowPos(window, IntPtr.Zero, x, y, width, height, 0x0014);
    ShowWindow(window, 3);
    // Topmost and straight back raises it above everything without pinning it there.
    SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x0013);
    SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, 0x0013);
    SetForegroundWindow(window);
  }
}
'@
[NoctisClapWindows]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
$request = $env:NOCTIS_CLAP_PLACE | ConvertFrom-Json
$screens = [System.Windows.Forms.Screen]::AllScreens
$primary = $screens | Where-Object Primary | Select-Object -First 1
$other = $screens | Where-Object { -not $_.Primary } | Select-Object -First 1
if ($null -eq $other) { $other = $primary }
$deadline = (Get-Date).AddSeconds($request.wait)
$pending = @($request.windows)
while ($true) {
  $processes = @(Get-CimInstance Win32_Process | Where-Object Name -eq $request.exe)
  $left = @()
  foreach ($target in $pending) {
    $flag = "--user-data-dir=$($target.profile)"
    $pids = @($processes | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($flag) } | ForEach-Object { [int]$_.ProcessId })
    $window = if ($pids.Count -gt 0) { [NoctisClapWindows]::Find($pids) } else { [IntPtr]::Zero }
    if ($window -ne [IntPtr]::Zero) {
      $area = if ($target.monitor -eq 1) { $primary.WorkingArea } else { $other.WorkingArea }
      [NoctisClapWindows]::Place($window, $area.X, $area.Y, $area.Width, $area.Height)
      "placed $($target.name)"
    } else {
      $left += $target
    }
  }
  $pending = $left
  if ($pending.Count -eq 0 -or (Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 250
}
`;

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

export interface ClapWindow {
  name: string;
  /** 1 is the primary monitor, 2 the first other one (or the primary when there is none). */
  monitor: 1 | 2;
  profile: string;
  args: string[];
}

/**
 * Presence on monitor 1 and the Vault on monitor 2. Each has a Chrome profile
 * of its own, which is how the placer tells the two windows apart.
 */
export function windowLaunches(pageUrl: string, profiles: string): ClapWindow[] {
  return (
    [
      ["Presence", 1],
      ["Vault", 2],
    ] as const
  ).map(([page, monitor]) => {
    const profile = win32.join(profiles, page.toLowerCase());
    return {
      name: page.toLowerCase(),
      monitor,
      profile,
      args: [
        `--user-data-dir=${profile}`,
        `--app=${new URL(`/?screen=${page}`, pageUrl).toString()}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    };
  });
}

/** The windows the placer did not report placing, so a placer that failed outright launches them all. */
export function missingWindows(names: readonly string[], output: string): string[] {
  const placed = new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("placed "))
      .map((line) => line.slice("placed ".length)),
  );
  return names.filter((name) => !placed.has(name));
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

/** Places whichever of `windows` are open; resolves to the names it could not find. */
function place(exe: string, windows: readonly ClapWindow[], wait: number): Promise<string[]> {
  const request = {
    exe,
    wait,
    windows: windows.map(({ name, monitor, profile }) => ({ name, monitor, profile })),
  };
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(PLACER, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: (wait + 30) * 1000,
        env: { ...process.env, NOCTIS_CLAP_PLACE: JSON.stringify(request) },
      },
      (_error, stdout) => {
        resolve(
          missingWindows(
            windows.map((window) => window.name),
            stdout,
          ),
        );
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

  let opening = false;

  /** Brings back the windows already open, and launches only the ones that are not. */
  const open = async (): Promise<void> => {
    if (opening) return;
    opening = true;
    try {
      const windows = windowLaunches(pageUrl, profiles);
      const exe = win32.basename(browser);
      const missing = await place(exe, windows, 0);
      const launched = windows.filter((window) => missing.includes(window.name));
      for (const window of launched) {
        spawn(browser, window.args, { detached: true, stdio: "ignore", windowsHide: false })
          .on("error", (error) => {
            log("warn", "clap to open could not start the browser", {
              browser,
              error: error.message,
            });
          })
          .unref();
      }
      const unplaced = launched.length === 0 ? [] : await place(exe, launched, LAUNCH_WAIT_SECONDS);
      log("info", "double clap: opened Noctis", {
        launched: launched.map((window) => window.name),
        unplaced,
      });
    } finally {
      opening = false;
    }
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
