import { describe, expect, it } from "vitest";
import { groupByStatus } from "./verification.js";

describe("verification grouping", () => {
  it("orders statuses, omits empty groups and preserves items and reasons", () => {
    const blocked = { id: "b", claim: "Deploy", status: "blocked" as const, reason: "Offline" };
    const verified = { id: "v", claim: "Build", status: "verified" as const };
    const partial = { id: "p", claim: "Phone", status: "partial" as const };
    expect(groupByStatus([blocked, partial, verified])).toEqual([
      { status: "verified", label: "Verified", items: [verified] },
      { status: "partial", label: "Partially verified", items: [partial] },
      { status: "blocked", label: "Blocked", items: [blocked] },
    ]);
    expect(groupByStatus([])).toEqual([]);
  });
});
