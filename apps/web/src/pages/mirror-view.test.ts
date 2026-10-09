import { describe, expect, it } from "vitest";

import type { CoreResponse } from "../transport/CoreTransport.js";
import type { MirrorState } from "./mirror-view.js";
import {
  createMirrorDiagnostics,
  mirrorAllowed,
  mirrorPath,
  mirrorRefusal,
} from "./mirror-view.js";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");

function pendingProbe() {
  let resolve!: (response: CoreResponse) => void;
  let reject!: (error: Error) => void;
  let signal!: AbortSignal;
  const response = new Promise<CoreResponse>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return {
    request: (abort: AbortSignal) => {
      signal = abort;
      return response;
    },
    resolve,
    reject,
    signal: () => signal,
  };
}

describe("mirror diagnostics", () => {
  it("aborts on Stop and ignores a pending locked response, leaving the mirror idle", async () => {
    const diagnostics = createMirrorDiagnostics();
    const probe = pendingProbe();
    let state: MirrorState = { phase: "idle" };
    const pending = diagnostics.check(probe.request).then((next) => {
      if (next !== undefined) state = next;
    });

    diagnostics.cancel();
    probe.resolve({ status: 423, body: {} });
    await pending;

    expect(state).toEqual({ phase: "idle" });
    expect(probe.signal().aborted).toBe(true);
  });

  it("ignores an old PC's response after the new mirror has started", async () => {
    const diagnostics = createMirrorDiagnostics();
    const oldPc = pendingProbe();
    const pending = diagnostics.check(oldPc.request);

    diagnostics.cancel();
    const newPc = diagnostics.check(() => Promise.resolve({ status: 423, body: {} }));
    expect(await newPc).toEqual({ phase: "locked" });
    oldPc.resolve({ status: 403, body: {} });

    expect(await pending).toBeUndefined();
    expect(oldPc.signal().aborted).toBe(true);
  });

  it("aborts and supersedes an earlier diagnostic request", async () => {
    const diagnostics = createMirrorDiagnostics();
    const first = pendingProbe();
    const pending = diagnostics.check(first.request);
    const latest = diagnostics.check(() => Promise.resolve({ status: 503, body: {} }));

    first.resolve({ status: 423, body: {} });
    expect(await pending).toBeUndefined();
    expect(first.signal().aborted).toBe(true);
    expect(await latest).toMatchObject({ phase: "unavailable" });
  });

  it("ignores a late rejection after cancellation", async () => {
    const diagnostics = createMirrorDiagnostics();
    const probe = pendingProbe();
    const pending = diagnostics.check(probe.request);

    diagnostics.cancel();
    probe.reject(new Error("offline"));

    expect(await pending).toBeUndefined();
  });

  it("reports a current network failure and a stopped stream", async () => {
    const diagnostics = createMirrorDiagnostics();

    expect(await diagnostics.check(() => Promise.reject(new Error("offline")))).toEqual({
      phase: "unavailable",
      message: "Noctis could not reach the core.",
    });
    expect(await diagnostics.check(() => Promise.resolve({ status: 200, body: {} }))).toEqual({
      phase: "unavailable",
      message: "The stream stopped. Watch again to restart it.",
    });
  });
});

describe("mirrorPath", () => {
  it("asks the core for one PC at a rate and a size, or only whether it would start", () => {
    expect(mirrorPath("n1", 15, 1280)).toBe("/screen/live?node=n1&fps=15&width=1280");
    expect(mirrorPath("n1", 30, 1920, true)).toBe("/screen/live?node=n1&fps=30&width=1920&probe=1");
  });
});

describe("mirrorAllowed", () => {
  it("needs a live screen.view grant of its own", () => {
    expect(mirrorAllowed([{ capability: "screen.view" }], NOW)).toBe(true);
    expect(mirrorAllowed([{ capability: "runtime.turn" }], NOW)).toBe(false);
    expect(
      mirrorAllowed([{ capability: "screen.view", revokedAt: "2026-10-01T00:00:00.000Z" }], NOW),
    ).toBe(false);
    expect(
      mirrorAllowed([{ capability: "screen.view", expiresAt: "2026-10-09T11:59:59.000Z" }], NOW),
    ).toBe(false);
  });
});

describe("mirrorRefusal", () => {
  it("tells a locked PC from one with nothing to capture with", () => {
    expect(mirrorRefusal(423, {})).toEqual({ phase: "locked" });
    expect(mirrorRefusal(403, {})).toEqual({ phase: "not_granted" });
    expect(
      mirrorRefusal(503, {
        error: { message: "No screen helper is running (see HOME-SETUP.md, Screen mirror)" },
      }),
    ).toEqual({
      phase: "unavailable",
      message: "No screen helper is running (see HOME-SETUP.md, Screen mirror)",
    });
    expect(mirrorRefusal(500, "nonsense")).toEqual({
      phase: "unavailable",
      message: "The core could not start the mirror (HTTP 500).",
    });
  });
});
