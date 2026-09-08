import { describe, expect, it } from "vitest";

import { nativeWindowBridgeFrom } from "./NativeWindowBridge.js";
import type { Invoke } from "./TauriTransport.js";

/** A shell that answers one command with one canned reply, and records the call. */
function shell(replies: Record<string, unknown>): {
  invoke: Invoke;
  calls: Array<{ command: string; args?: Record<string, unknown> }>;
} {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];

  return {
    calls,
    invoke: (command, args) => {
      calls.push(args === undefined ? { command } : { command, args });

      return Promise.resolve(replies[command]);
    },
  };
}

function bridgeWith(replies: Record<string, unknown>): ReturnType<typeof nativeWindowBridgeFrom> {
  return nativeWindowBridgeFrom({ __TAURI__: { core: { invoke: shell(replies).invoke } } });
}

const SURVEY = [
  {
    applicationId: "vscode",
    displayName: "Visual Studio Code",
    state: { kind: "discovered", windowTitle: "Noctis-OS - Visual Studio Code", handle: 67510 },
  },
  { applicationId: "emulator", displayName: "Android Emulator", state: { kind: "notRunning" } },
];

describe("the native window bridge", () => {
  /**
   * THE GATE: no desktop shell means no bridge, and that is an answer rather
   * than a failure. It is also why the E2E suite, which runs in a real browser,
   * does not have to pretend a shell is there.
   */
  it("does not exist without a desktop shell behind the page", () => {
    expect(nativeWindowBridgeFrom({})).toBeUndefined();
    expect(nativeWindowBridgeFrom(undefined)).toBeUndefined();
    expect(nativeWindowBridgeFrom(globalThis)).toBeUndefined();
  });

  it("reads a survey of the applications it may arrange", async () => {
    const bridge = bridgeWith({ window_survey: SURVEY });

    const surveyed = await bridge?.survey();

    expect(surveyed?.map((application) => application.applicationId)).toEqual([
      "vscode",
      "emulator",
    ]);
    expect(surveyed?.[0]?.state.kind).toBe("discovered");
  });

  /**
   * THE GATE: this is the drift the Rust side's `rename_all_fields` prevents.
   * Failing here is the whole point — a bridge that shrugged and returned it
   * would produce a Surface that renders a fallback for reasons nobody can find.
   */
  it("refuses a survey whose fields are spelled the Rust way", async () => {
    const bridge = bridgeWith({
      window_survey: [
        {
          application_id: "vscode",
          display_name: "Visual Studio Code",
          state: { kind: "notRunning" },
        },
      ],
    });

    await expect(bridge?.survey()).rejects.toThrow();
  });

  it("refuses a survey carrying a state the contract does not describe", async () => {
    const bridge = bridgeWith({
      window_survey: [
        { applicationId: "vscode", displayName: "Code", state: { kind: "probably_fine" } },
      ],
    });

    await expect(bridge?.survey()).rejects.toThrow();
  });

  /**
   * THE GATE: Section 11.2 — the shell takes semantic placement requests. The
   * intent this sends has nowhere to put a coordinate, and this test is what
   * keeps it that way.
   */
  it("sends a named region and a display role, never coordinates", async () => {
    const recorder = shell({ window_place: { kind: "notRunning" } });
    const bridge = nativeWindowBridgeFrom({ __TAURI__: { core: { invoke: recorder.invoke } } });

    await bridge?.place({
      applicationId: "vscode",
      monitor: "primary",
      region: "left_two_thirds",
      titleHint: "Noctis-OS",
    });

    const call = recorder.calls[0];

    expect(call?.command).toBe("window_place");
    expect(call?.args?.intent).toEqual({
      applicationId: "vscode",
      monitor: "primary",
      region: "left_two_thirds",
    });
    expect(call?.args?.titleHint).toBe("Noctis-OS");
    expect(JSON.stringify(call?.args)).not.toMatch(/"(x|y|width|height)"/);
  });

  it("sends null rather than nothing for an absent approval or hint", async () => {
    const recorder = shell({ window_place: { kind: "notRunning" } });
    const bridge = nativeWindowBridgeFrom({ __TAURI__: { core: { invoke: recorder.invoke } } });

    await bridge?.place({ applicationId: "vscode", monitor: "primary", region: "full" });

    expect(recorder.calls[0]?.args?.approvalId).toBeNull();
    expect(recorder.calls[0]?.args?.titleHint).toBeNull();
  });

  it("reads a placement that needs a person to decide", async () => {
    const bridge = bridgeWith({
      window_place: {
        kind: "needsApproval",
        requestId: "0199a000-0000-7000-8000-000000000001",
        outcome: "require_confirmation",
        consequenceSummary: "Move vscode to the left two thirds of the primary display",
      },
    });

    const state = await bridge?.place({
      applicationId: "vscode",
      monitor: "primary",
      region: "left_two_thirds",
    });

    expect(state?.kind).toBe("needsApproval");
  });

  /**
   * THE GATE: Rust serializes `Option::None` as `null`, and `.optional()` means
   * "absent or a string" — not null. The first draft of this suite omitted the
   * field instead of sending null, so it passed while the real shell's very
   * first `needsApproval` surfaced a raw zod error in the Surface.
   */
  it("reads an approval that needs no typed phrase, sent as null", async () => {
    const bridge = bridgeWith({
      window_place: {
        kind: "needsApproval",
        requestId: "0199a000-0000-7000-8000-000000000003",
        outcome: "require_confirmation",
        consequenceSummary: "Move vscode",
        confirmationPhrase: null,
      },
    });

    const state = await bridge?.place({
      applicationId: "vscode",
      monitor: "primary",
      region: "full",
    });

    expect(state?.kind).toBe("needsApproval");
  });

  /**
   * THE GATE: the core allows a reversible local edit without asking while an
   * Objective is active, and decides that by looking the Objective up. A
   * request that does not carry one is asked about — which made the whole
   * active-Objective path unreachable until this was sent.
   */
  it("names the objective the placement belongs to", async () => {
    const recorder = shell({ window_place: { kind: "notRunning" } });
    const bridge = nativeWindowBridgeFrom({ __TAURI__: { core: { invoke: recorder.invoke } } });

    await bridge?.place({
      applicationId: "vscode",
      monitor: "primary",
      region: "full",
      objectiveId: "0199a000-0000-7000-8000-0000000000ff",
    });

    expect(recorder.calls[0]?.args?.intent).toEqual({
      applicationId: "vscode",
      monitor: "primary",
      region: "full",
      objectiveId: "0199a000-0000-7000-8000-0000000000ff",
    });
  });

  it("reads a placement that happened, with the notes that explain it", async () => {
    const bridge = bridgeWith({
      window_place: {
        kind: "placed",
        placement: { x: 0, y: 0, width: 1706, height: 1440, maximized: false },
        previous: { x: 100, y: 100, width: 1200, height: 800, maximized: false },
        monitorId: "\\\\.\\DISPLAY1",
        notes: ["degraded_to_primary"],
        elapsedMs: 29,
        requestId: "0199a000-0000-7000-8000-000000000002",
      },
    });

    const state = await bridge?.place({
      applicationId: "vscode",
      monitor: "secondary",
      region: "full",
    });

    expect(state).toMatchObject({ kind: "placed", monitorId: "\\\\.\\DISPLAY1", elapsedMs: 29 });
  });

  it("reads a restore", async () => {
    const bridge = bridgeWith({
      window_restore: {
        kind: "restored",
        placement: { x: 15, y: 65, width: 491, height: 437, maximized: false },
        applicationId: "vscode",
      },
    });

    expect((await bridge?.restore("vscode"))?.kind).toBe("restored");
  });

  /**
   * The way out of "the user always wins". It returns nothing because it moves
   * nothing — it discards a preference, and the caller places again to see it.
   */
  it("clears a dragged position without reporting an outcome", async () => {
    const recorder = shell({ window_clear_override: null });
    const bridge = nativeWindowBridgeFrom({ __TAURI__: { core: { invoke: recorder.invoke } } });

    await expect(bridge?.clearOverride("vscode")).resolves.toBeUndefined();

    expect(recorder.calls[0]).toEqual({
      command: "window_clear_override",
      args: { applicationId: "vscode" },
    });
  });

  it("names the application it is restoring", async () => {
    const recorder = shell({ window_restore: { kind: "notRunning" } });
    const bridge = nativeWindowBridgeFrom({ __TAURI__: { core: { invoke: recorder.invoke } } });

    await bridge?.restore("emulator");

    expect(recorder.calls[0]).toEqual({
      command: "window_restore",
      args: { applicationId: "emulator" },
    });
  });
});
