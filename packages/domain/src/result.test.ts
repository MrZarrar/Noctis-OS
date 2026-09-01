import { describe, expect, it } from "vitest";

import { conflict, ok } from "./result.js";

describe("Result", () => {
  it("wraps a success value", () => {
    const result = ok(42);

    expect(result.ok).toBe(true);
    expect(result.ok ? result.value : undefined).toBe(42);
  });

  it("wraps a forbidden transition conflict", () => {
    const result = conflict<number>({
      kind: "forbidden_transition",
      machine: "objective",
      from: "completed",
      to: "active",
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.conflict.kind).toBe("forbidden_transition");
  });

  it("wraps a revision conflict", () => {
    const result = conflict<number>({ kind: "revision_conflict", expected: 3, actual: 5 });

    expect(result.ok ? undefined : result.conflict).toEqual({
      kind: "revision_conflict",
      expected: 3,
      actual: 5,
    });
  });

  it("wraps an idempotent replay", () => {
    const result = conflict<number>({
      kind: "idempotent_replay",
      key: "abc",
      existingId: "01941f29-7c00-7000-8000-000000000000",
    });

    expect(result.ok ? undefined : result.conflict.kind).toBe("idempotent_replay");
  });
});
