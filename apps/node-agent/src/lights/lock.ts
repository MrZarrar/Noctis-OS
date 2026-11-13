import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { AdapterRefused } from "../runtimes/Runtime.js";

export function lightsLockAddress(configPath: string): string {
  const path = realpathSync(configPath);
  const key = createHash("sha256")
    .update(process.platform === "win32" ? path.toLowerCase() : path)
    .digest("hex")
    .slice(0, 32);
  const name = `noctis-lights-${key}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\${name}`;
  if (process.platform === "linux") return `\0${name}`;
  return join(tmpdir(), `${name}.sock`);
}

// A Windows named pipe is exclusive across MCP processes and releases when its owner exits.
export async function withLightsLock<T>(
  configPath: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const address = lightsLockAddress(configPath);
  const deadline = Date.now() + 120_000;
  while (true) {
    if (signal?.aborted) throw new AdapterRefused("job was cancelled");
    const lock = createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        lock.once("error", reject);
        lock.listen(address, resolve);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE")
        throw new AdapterRefused("could not lock lights on this PC");
      if (Date.now() >= deadline) throw new AdapterRefused("lights are busy on this PC");
      await delay(25);
      continue;
    }
    try {
      if (signal?.aborted) throw new AdapterRefused("job was cancelled");
      return await work();
    } finally {
      await new Promise<void>((resolve) => lock.close(() => resolve()));
    }
  }
}
