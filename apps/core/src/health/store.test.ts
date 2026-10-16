import { healthReportFixture } from "@noctis/contracts";
import { expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import {
  parseHealthReport,
  proposedIds,
  readHealthReport,
  storeHealthReport,
  suggestionIds,
} from "./store.js";

it("parses reports and exposes only schema paths and codes on invalid data", () => {
  const good = parseHealthReport(JSON.stringify(healthReportFixture()));
  expect(good.state).toBe("ok");
  if (good.state === "ok") {
    expect(proposedIds(good.report)).toEqual(["2026-W41-breakfast-carb_ratio"]);
    expect(suggestionIds(good.report)).toEqual(new Set(good.report.suggestions.map((s) => s.id)));
  }
  expect(parseHealthReport("{nope")).toEqual({
    state: "unreadable",
    reason: "report.json is not JSON",
  });
  expect(
    parseHealthReport(
      JSON.stringify({ ...healthReportFixture(), stats: { coverage: "12.3 mmol" } }),
    ),
  ).toEqual({ state: "unreadable", reason: "stats.coverage: invalid_type" });
});

it("keeps one latest report including a megabyte body and clears previous optional fields", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db, { directory: "apps/core/migrations", clock: { now: () => 0 } });
    expect(readHealthReport(db)).toBeUndefined();
    const big = JSON.stringify({ ...healthReportFixture(), padding: "x".repeat(1_000_000) });
    storeHealthReport(db, {
      state: "unreadable",
      reason: "report: invalid_type",
      jobId: "a",
      receivedAt: "2026-10-16T10:00:00.000Z",
    });
    storeHealthReport(db, {
      state: "ok",
      body: big,
      jobId: "b",
      receivedAt: "2026-10-16T11:00:00.000Z",
    });
    expect(readHealthReport(db)).toEqual({
      state: "ok",
      body: big,
      jobId: "b",
      receivedAt: "2026-10-16T11:00:00.000Z",
    });
    storeHealthReport(db, { state: "missing", jobId: "c", receivedAt: "2026-10-16T12:00:00.000Z" });
    expect(readHealthReport(db)).toEqual({
      state: "missing",
      jobId: "c",
      receivedAt: "2026-10-16T12:00:00.000Z",
    });
  } finally {
    db.close();
  }
});
