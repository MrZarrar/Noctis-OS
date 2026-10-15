import { describe, expect, it } from "vitest";

import { createWakeGuard } from "./wake.js";

describe("waking while the owner types", () => {
  it("wakes once per sleep, however much is typed", () => {
    const guard = createWakeGuard();
    const wakes = ["h", "he", "hel", "hell", "hello"].filter(() =>
      guard.typed({ asleep: true, enabled: true }),
    );

    expect(wakes).toHaveLength(1);
  });

  it("wakes again once the agent has fallen asleep again", () => {
    const guard = createWakeGuard();

    expect(guard.typed({ asleep: true, enabled: true })).toBe(true);
    expect(guard.typed({ asleep: false, enabled: true })).toBe(false);
    expect(guard.typed({ asleep: true, enabled: true })).toBe(true);
  });

  it("does nothing when the setting is off", () => {
    const guard = createWakeGuard();

    expect(guard.typed({ asleep: true, enabled: false })).toBe(false);
  });
});
