import { describe, expect, it } from "vitest";

import {
  IdempotencyKeySchema,
  RevisionSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./primitives.js";

describe("primitives", () => {
  it("accepts a UUIDv7", () => {
    expect(UuidSchema.safeParse("01941f29-7c00-7000-8000-000000000000").success).toBe(true);
  });

  it("rejects a UUIDv4, because Phase 1 locked UUIDv7", () => {
    expect(UuidSchema.safeParse("9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d").success).toBe(false);
  });

  it("accepts an offset-bearing UTC timestamp", () => {
    expect(UtcTimestampSchema.safeParse("2026-09-01T12:00:00.000Z").success).toBe(true);
  });

  it("rejects a timestamp with no offset", () => {
    expect(UtcTimestampSchema.safeParse("2026-09-01T12:00:00").success).toBe(false);
  });

  it("rejects a negative revision", () => {
    expect(RevisionSchema.safeParse(-1).success).toBe(false);
  });

  it("rejects a non-integer revision", () => {
    expect(RevisionSchema.safeParse(1.5).success).toBe(false);
  });

  it("rejects an empty idempotency key", () => {
    expect(IdempotencyKeySchema.safeParse("").success).toBe(false);
  });
});
