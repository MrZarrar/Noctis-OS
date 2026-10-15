import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";

/**
 * Runtime processes this agent started, kept on disk so the next start can
 * stop any a crash left behind. Awaited cleanup (kill-tree) covers every exit
 * the agent lives through; this covers the one it does not.
 */
interface Tracked {
  pid: number;
  image: string;
}

/** Set by the agent's start-up reap; until then (as in tests) nothing is recorded. */
let recordFile: string | undefined;

function read(file: string): Tracked[] {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Tracked[];
  } catch {
    return [];
  }
}

function write(file: string, tracked: Tracked[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(tracked));
}

/** The process name taskkill matches, so a reused pid on another program is never stopped. */
function imageOf(command: string): string {
  const name = basename(command);
  return process.platform === "win32" && extname(name) === "" ? `${name}.exe` : name;
}

export function trackChild(
  child: { readonly pid?: number | undefined; on(event: "exit", listener: () => void): unknown },
  command: string,
  file = recordFile,
): void {
  const { pid } = child;
  if (pid === undefined || file === undefined) return;
  write(file, [...read(file).filter((t) => t.pid !== pid), { pid, image: imageOf(command) }]);
  child.on("exit", () => {
    write(
      file,
      read(file).filter((t) => t.pid !== pid),
    );
  });
}

/** Stops every recorded process tree still running, then forgets them. Returns how many were recorded. */
export async function reapOrphans(file: string): Promise<number> {
  recordFile = file;
  const tracked = read(file);
  // Cleared before stopping, so a runtime started meanwhile keeps its record.
  if (tracked.length > 0) write(file, []);
  await Promise.all(tracked.map(stop));
  return tracked.length;
}

function stop({ pid, image }: Tracked): Promise<void> {
  if (process.platform !== "win32") {
    // ponytail: no image check off Windows; a reused pid there would be signalled. Compare /proc/<pid>/comm if Noctis nodes ever run on Linux.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(
      "taskkill",
      ["/F", "/T", "/FI", `PID eq ${String(pid)}`, "/FI", `IMAGENAME eq ${image}`],
      { windowsHide: true, timeout: 5_000 },
      () => resolve(),
    );
  });
}
