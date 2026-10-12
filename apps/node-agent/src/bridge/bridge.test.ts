import { describe, expect, it } from "vitest";

import { childEnvironment } from "../runtimes/env.js";
import { bridgeEvent } from "./event.js";
import { BRIDGE_EVENTS, addBridgeHooks, removeBridgeHooks } from "./hooks-config.js";

const BASE = { session_id: "s-1", transcript_path: "C:\\t.jsonl", cwd: "C:\\work\\app" };

describe("bridgeEvent", () => {
  it("turns each hook the bridge listens to into what Noctis records", () => {
    expect(bridgeEvent("claude", { ...BASE, hook_event_name: "SessionStart" }, {})).toEqual({
      providerId: "claude",
      kind: "start",
      sessionRef: "s-1",
      cwd: "C:\\work\\app",
    });
    expect(
      bridgeEvent("codex", { ...BASE, hook_event_name: "UserPromptSubmit", prompt: "fix it" }, {}),
    ).toMatchObject({ providerId: "codex", kind: "prompt", text: "fix it" });
    expect(
      bridgeEvent(
        "claude",
        { ...BASE, hook_event_name: "Stop", last_assistant_message: "Done." },
        {},
      ),
    ).toMatchObject({ kind: "reply", text: "Done." });
    expect(bridgeEvent("claude", { ...BASE, hook_event_name: "SessionEnd" }, {})).toMatchObject({
      kind: "end",
    });
  });

  it("keeps a reply whose text the agent did not send, and clips a long one", () => {
    expect(bridgeEvent("codex", { ...BASE, hook_event_name: "Stop" }, {})).toEqual({
      providerId: "codex",
      kind: "reply",
      sessionRef: "s-1",
      cwd: "C:\\work\\app",
    });
    expect(
      bridgeEvent(
        "claude",
        { ...BASE, hook_event_name: "UserPromptSubmit", prompt: "x".repeat(30_000) },
        {},
      )?.text,
    ).toHaveLength(20_000);
  });

  it("says nothing for Noctis's own sessions, other hooks, or a payload it cannot read", () => {
    const own = childEnvironment({ PATH: "C:\\bin" });

    expect(bridgeEvent("claude", { ...BASE, hook_event_name: "SessionStart" }, own)).toBe(
      undefined,
    );
    expect(bridgeEvent("claude", { ...BASE, hook_event_name: "PreToolUse" }, {})).toBe(undefined);
    expect(bridgeEvent("claude", { hook_event_name: "Stop" }, {})).toBe(undefined);
    expect(bridgeEvent("claude", "not json", {})).toBe(undefined);
  });
});

describe("the bridge's hooks in an agent's settings", () => {
  const COMMAND = '"C:\\node.exe" "C:\\Noctis-OS\\apps\\node-agent\\dist\\bridge-hook.js" claude';

  it("adds one short-lived hook per event beside the owner's own, once however often it runs", () => {
    const mine = { type: "command", command: "bash mine.sh" };
    const settings = {
      model: "opus",
      hooks: { Stop: [{ hooks: [mine] }] },
    };

    const once = addBridgeHooks(settings, COMMAND);
    const twice = addBridgeHooks(once, COMMAND);

    expect(twice).toEqual(once);
    expect(once.model).toBe("opus");
    expect(Object.keys(once.hooks).sort()).toEqual([...BRIDGE_EVENTS].sort());
    expect(once.hooks.Stop).toEqual([
      { hooks: [mine] },
      { hooks: [{ type: "command", command: COMMAND, timeout: 5 }] },
    ]);
  });

  it("removes only its own hooks, and the settings it found are what is left", () => {
    const settings = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "bash mine.sh" }] }] },
    };

    expect(removeBridgeHooks(addBridgeHooks(settings, COMMAND))).toEqual(settings);
    expect(removeBridgeHooks(addBridgeHooks({}, COMMAND))).toEqual({});
  });
});
