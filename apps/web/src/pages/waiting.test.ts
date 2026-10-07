import { describe, expect, it } from "vitest";

import { isWaiting } from "./waiting.js";

const asked = {
  outcome: "require_confirmation",
  confirmedAt: undefined,
  executedAt: undefined,
  declinedAt: undefined,
  nodeJobId: undefined,
} as const;

describe("isWaiting: what the Approvals page puts in front of the owner", () => {
  it("shows a step that needs a confirmation, typed or not", () => {
    expect(isWaiting(asked)).toBe(true);
    expect(isWaiting({ ...asked, outcome: "require_typed_confirmation" })).toBe(true);
  });

  it("drops a step that was declined or already executed", () => {
    expect(isWaiting({ ...asked, declinedAt: "2026-10-07T10:00:00Z" })).toBe(false);
    expect(isWaiting({ ...asked, executedAt: "2026-10-07T10:00:00Z" })).toBe(false);
  });

  it("drops what policy decided on its own", () => {
    expect(isWaiting({ ...asked, outcome: "allow" })).toBe(false);
    expect(isWaiting({ ...asked, outcome: "deny" })).toBe(false);
  });

  it("drops an agent's ask once confirmed, because the turn carries on by itself", () => {
    expect(isWaiting({ ...asked, nodeJobId: "job-1", confirmedAt: "2026-10-07T10:00:00Z" })).toBe(
      false,
    );
  });

  it("keeps a confirmed external step, because executing it is still the owner's move", () => {
    expect(isWaiting({ ...asked, confirmedAt: "2026-10-07T10:00:00Z" })).toBe(true);
  });
});
