import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { lightsLockAddress, withLightsLock } from "./lock.js";

const homes: string[] = [];
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});
function config() {
  const home = mkdtempSync(join(tmpdir(), "noctis-lights-lock-"));
  homes.push(home);
  const path = join(home, "lights.json");
  writeFileSync(path, "{}");
  return path;
}

it("waits for another OS lock owner and proceeds when it releases", async () => {
  const path = config();
  const holder = createServer();
  await new Promise<void>((resolve, reject) =>
    holder.once("error", reject).listen(lightsLockAddress(path), resolve),
  );
  let ran = false;
  const waiting = withLightsLock(path, () => {
    ran = true;
    return Promise.resolve("done");
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ran).toBe(false);
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
  expect(await waiting).toBe("done");
});

it("releases ownership after a failed job and refuses a cancelled waiter", async () => {
  const path = config();
  await expect(
    withLightsLock(path, () => Promise.reject(new Error("device failed"))),
  ).rejects.toThrow("device failed");
  expect(await withLightsLock(path, () => Promise.resolve(42))).toBe(42);
  await expect(withLightsLock(path, () => Promise.resolve(1), AbortSignal.abort())).rejects.toThrow(
    "cancelled",
  );
});
