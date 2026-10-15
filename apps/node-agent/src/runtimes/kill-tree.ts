import { execFile } from "node:child_process";

export interface KillableChild {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null | undefined;
  on(event: "exit" | "close", listener: () => void): unknown;
  off?(event: "exit" | "close", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

const closing = new WeakMap<KillableChild, Promise<void>>();

/** Unix callers spawn detached so the child's process group includes its descendants. */
export function killProcessTree(child: KillableChild): Promise<void> {
  const pending = closing.get(child);
  if (pending !== undefined) return pending;
  if (child.exitCode !== null || child.signalCode != null) return Promise.resolve();

  const cleanup = new Promise<void>((resolve) => {
    let exited = false;
    let treeStopped = false;
    let escalation: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      console.warn("runtime process tree exit timed out", { pid: child.pid });
      finish();
    }, 6_000);

    function finish(): void {
      clearTimeout(timeout);
      clearTimeout(escalation);
      child.off?.("exit", onExit);
      child.off?.("close", onExit);
      resolve();
    }
    function signalTree(signal: NodeJS.Signals): void {
      try {
        if (child.pid !== undefined && process.platform !== "win32") {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          console.warn("runtime process tree signal failed", { pid: child.pid, signal, error });
        }
        try {
          child.kill(signal);
        } catch {
          /* Exit or the bounded timeout settles cleanup. */
        }
      }
    }
    function onExit(): void {
      if (exited) return;
      exited = true;
      if (process.platform !== "win32" && child.pid !== undefined) signalTree("SIGKILL");
      if (treeStopped) finish();
    }
    child.on("exit", onExit);
    child.on("close", onExit);

    // Install/cache cleanup before a synchronous fake or an SDK callback can report exit.
    queueMicrotask(() => {
      if (process.platform === "win32" && child.pid !== undefined) {
        execFile(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          {
            windowsHide: true,
            timeout: 5_000,
          },
          (error) => {
            if (error !== null) {
              console.warn("runtime taskkill failed", { pid: child.pid, error });
              signalTree("SIGKILL");
            }
            treeStopped = true;
            if (exited) finish();
          },
        );
      } else {
        treeStopped = true;
        escalation = setTimeout(() => signalTree("SIGKILL"), 1_000);
        signalTree("SIGTERM");
      }
    });
  });
  closing.set(child, cleanup);
  return cleanup;
}
