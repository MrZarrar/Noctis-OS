import { describe, expect, it } from "vitest";

import { checkRevision } from "./revision.js";

describe("checkRevision", () => {
  it("returns the next revision when the expected value matches", () => {
    expect(checkRevision(3, 3)).toEqual({ ok: true, value: 4 });
  });

  it("returns a revision_conflict when the record moved on", () => {
    expect(checkRevision(3, 5)).toEqual({
      ok: false,
      conflict: { kind: "revision_conflict", expected: 3, actual: 5 },
    });
  });

  it("returns a revision_conflict when the caller is ahead", () => {
    expect(checkRevision(7, 5).ok).toBe(false);
  });
});
