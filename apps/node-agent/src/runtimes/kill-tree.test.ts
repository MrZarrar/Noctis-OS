import { execFile, spawn } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

import { killProcessTree } from "./kill-tree.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

class Child extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["exit", "close"] as const)(
  "waits for %s, shares concurrent cleanup and removes its listeners",
  async (event) => {
    const child = new Child();
    let settled = false;
    const cleanup = killProcessTree(child);
    expect(killProcessTree(child)).toBe(cleanup);
    void cleanup.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalled();
    expect(settled).toBe(false);
    child.emit(event, null, "SIGTERM");
    await cleanup;
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  },
);

it("immediately accepts both numeric and signal exits", async () => {
  for (const exited of [
    { exitCode: 0, signalCode: null },
    { exitCode: null, signalCode: "SIGTERM" as const },
  ]) {
    const child = Object.assign(new Child(), exited);
    await killProcessTree(child);
    expect(child.kill).not.toHaveBeenCalled();
  }
});

it("escalates and logs a bounded timeout when exit never arrives", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("process", { ...process, platform: "linux" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const child = new Child();
  const cleanup = killProcessTree(child);
  await vi.advanceTimersByTimeAsync(10_000);
  await cleanup;
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"), expect.anything());
  expect(child.listenerCount("exit")).toBe(0);
});

it("uses Windows taskkill and waits for both tree cleanup and child exit", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  let taskkillDone = (): void => undefined;
  vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
    taskkillDone = () => (args[3] as (error: null) => void)(null);
    return {} as ReturnType<typeof execFile>;
  });
  const child = Object.assign(new Child(), { pid: 12345 });
  let settled = false;
  const cleanup = killProcessTree(child).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(execFile).toHaveBeenCalledWith(
    "taskkill",
    ["/PID", "12345", "/T", "/F"],
    expect.objectContaining({ windowsHide: true }),
    expect.any(Function),
  );
  child.emit("exit", 1, null);
  await Promise.resolve();
  expect(settled).toBe(false);
  taskkillDone();
  await cleanup;
});

it("signals the Unix process group and escalates while waiting for exit", async () => {
  vi.useFakeTimers();
  const signal = vi.fn();
  vi.stubGlobal("process", { ...process, platform: "linux", kill: signal });
  const child = Object.assign(new Child(), { pid: 12345 });
  const cleanup = killProcessTree(child);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(signal).toHaveBeenCalledWith(-12345, "SIGTERM");
  expect(signal).toHaveBeenCalledWith(-12345, "SIGKILL");
  expect(child.kill).not.toHaveBeenCalled();
  child.emit("exit", null, "SIGKILL");
  await cleanup;
});

it("logs taskkill failure, attempts a direct kill and still waits for exit", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
    (args[3] as (error: Error) => void)(new Error("taskkill unavailable"));
    return {} as ReturnType<typeof execFile>;
  });
  const child = Object.assign(new Child(), { pid: 12345 });
  let settled = false;
  const cleanup = killProcessTree(child).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(warn).toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(settled).toBe(false);
  child.emit("exit", 1, null);
  await cleanup;
});

it("kills a real child and its grandchild", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log(grandchild.pid);
    setInterval(() => {}, 1000);
  `,
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  );
  const [data] = (await once(child.stdout, "data")) as [Buffer];
  const pid = Number(data.toString().trim());
  try {
    await killProcessTree(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    // Only the two processes this test created can be touched by fallback cleanup.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already gone. */
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* Already gone. */
    }
  }
}, 10_000);
