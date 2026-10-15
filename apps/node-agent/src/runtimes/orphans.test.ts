import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { reapOrphans, trackChild } from "./orphans.js";

describe("runtime processes a crash left behind", () => {
  it("are stopped on the next start, and a clean exit forgets them", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "noctis-orphans-")), "runtime-pids.json");
    const survivor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    const quick = spawn(process.execPath, ["-e", ""]);
    trackChild(survivor, process.execPath, file);
    trackChild(quick, process.execPath, file);
    await new Promise((resolve) => quick.once("exit", resolve));

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([
      { pid: survivor.pid, image: expect.any(String) as unknown },
    ]);

    // As if the agent had crashed: the record is all the next start has.
    const exited = new Promise((resolve) => survivor.once("exit", resolve));
    await reapOrphans(file);
    await exited;

    expect(survivor.exitCode !== null || survivor.signalCode !== null).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("a missing record is nothing to do", async () => {
    await expect(reapOrphans(join(tmpdir(), "noctis-no-such-dir", "x.json"))).resolves.toBe(0);
  });
});
