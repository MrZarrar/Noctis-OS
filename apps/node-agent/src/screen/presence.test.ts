import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: child.spawn }));
import { watchWindowsOwnerPresence } from "./presence.js";

it.skipIf(process.platform !== "win32")(
  "reads fragmented owner-session state and fails closed when the watcher exits",
  () => {
    const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
    child.spawn.mockReturnValue(fake);
    const report = vi.fn();
    const stop = watchWindowsOwnerPresence(report);
    expect(report.mock.calls).toEqual([[false]]);
    fake.stdout.write("tr");
    expect(report.mock.calls).toEqual([[false]]);
    fake.stdout.write("ue\r\nfalse\n");
    expect(report.mock.calls).toEqual([[false], [true], [false]]);
    fake.stdout.write("true\n");
    fake.emit("close", 1);
    expect(report.mock.calls.at(-1)).toEqual([false]);
    stop();
    expect(fake.kill).toHaveBeenCalledOnce();
  },
);
