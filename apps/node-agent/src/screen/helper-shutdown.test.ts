import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, expect, it, vi } from "vitest";

import type { ScreenHelper } from "./helper.js";
import { SCREEN_TOKEN_HEADER, startHelper } from "./helper.js";

const children = vi.hoisted(() => ({ active: [] as Array<{ kill: ReturnType<typeof vi.fn> }> }));

vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn(() => {
        child.signalCode = "SIGTERM";
        child.stdout.destroy();
        child.stderr.destroy();
        child.emit("close", null);
        return true;
      }),
    });
    children.active.push(child);
    return child;
  },
}));

const helpers: ScreenHelper[] = [];
const scratches: string[] = [];

afterEach(async () => {
  for (const helper of helpers.splice(0)) await helper.close();
  for (const scratch of scratches.splice(0)) rmSync(scratch, { recursive: true, force: true });
  children.active.length = 0;
});

it.each(["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK", "exit"] as const)(
  "kills a stalled capture on helper %s and removes its shutdown listeners",
  async (signal) => {
    const before = process.listenerCount(signal);
    const scratch = mkdtempSync(join(tmpdir(), "noctis-helper-shutdown-"));
    scratches.push(scratch);
    const helper = await startHelper({ infoPath: join(scratch, "screen-helper.json") });
    helpers.push(helper);
    const request = get(
      `http://127.0.0.1:${String(helper.port)}/mirror?fps=15&width=1280`,
      {
        headers: { [SCREEN_TOKEN_HEADER]: helper.token },
      },
      (response) => response.resume(),
    );
    request.on("error", () => undefined);
    try {
      await vi.waitFor(() => expect(children.active).toHaveLength(1));
      if (signal === "exit") {
        process.listeners("exit")[before]?.(0);
      } else {
        process.listeners(signal)[before]?.(signal);
      }
      expect(children.active[0]?.kill).toHaveBeenCalledOnce();
      await helper.close();
      expect(process.listenerCount(signal)).toBe(before);
    } finally {
      request.destroy();
    }
  },
);
