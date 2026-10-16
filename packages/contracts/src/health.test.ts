import { describe, expect, it } from "vitest";

import {
  CORE_PATH_PATTERN,
  HealthDecidePayloadSchema,
  HealthGrantConstraintsSchema,
  HealthReportSchema,
  HealthStatusSchema,
  PagePanelPayloadSchema,
  SETTING_VALUE_SCHEMAS,
  healthReportFixture,
} from "./index.js";

describe("HealthReportSchema", () => {
  it("accepts the glycolens contract with traces", () => {
    const parsed = HealthReportSchema.parse(healthReportFixture());
    expect(parsed.findings[0]!.traces[0]!.points[0]).toEqual([0, 7.2]);
    expect(parsed.findings[2]!.traces[0]!.basal?.[2]).toEqual([120, null]);
  });

  it("defaults traces to [] for a report written before glycolens fdbd7d6", () => {
    const report = healthReportFixture();
    for (const finding of report.findings) delete (finding as { traces?: unknown }).traces;
    expect(HealthReportSchema.parse(report).findings[0]!.traces).toEqual([]);
  });

  it("keeps a report with fields a newer glycolens added", () => {
    const report = {
      ...healthReportFixture(),
      new_section: [1],
      stats: { ...healthReportFixture().stats, iqr: 2 },
    };
    expect(HealthReportSchema.safeParse(report).success).toBe(true);
  });

  it("accepts the nulls glycolens writes when there is no data", () => {
    const report = healthReportFixture();
    report.agp[3] = { hour: 3, p5: null, p25: null, p50: null, p75: null, p95: null };
    report.stats = {
      coverage: 0,
      mean: null,
      tir: null,
      tbr: null,
      tbr_severe: null,
      tar: null,
      tar_severe: null,
      gmi: null,
      cv: null,
      min: null,
    };
    report.changes[0]!.after = null;
    expect(HealthReportSchema.safeParse(report).success).toBe(true);
  });

  it("rejects a newer schema version and an unknown rule", () => {
    expect(
      HealthReportSchema.safeParse({ ...healthReportFixture(), schema_version: 2 }).success,
    ).toBe(false);
    const report = healthReportFixture();
    (report.findings[0] as { rule: string }).rule = "site_age";
    expect(HealthReportSchema.safeParse(report).success).toBe(false);
  });
});

describe("health payloads", () => {
  it("never lets a suggestion id become a CLI option", () => {
    expect(
      HealthDecidePayloadSchema.safeParse({
        id: "2026-W41-breakfast-carb_ratio",
        action: "mark-applied",
      }).success,
    ).toBe(true);
    expect(HealthDecidePayloadSchema.safeParse({ id: "--help", action: "dismiss" }).success).toBe(
      false,
    );
    expect(HealthDecidePayloadSchema.safeParse({ id: "a b", action: "dismiss" }).success).toBe(
      false,
    );
    expect(HealthDecidePayloadSchema.safeParse({ id: "x", action: "login" }).success).toBe(false);
  });

  it("takes only absolute folders in a grant", () => {
    expect(
      HealthGrantConstraintsSchema.safeParse({ repo: "C:\\Users\\me\\Documents\\glycolens" })
        .success,
    ).toBe(true);
    expect(HealthGrantConstraintsSchema.safeParse({ repo: "glycolens" }).success).toBe(false);
  });

  it("describes the panel's status, the setting, the route and the page", () => {
    expect(
      HealthStatusSchema.safeParse({
        granted: false,
        nodeId: null,
        nodeOnline: false,
        busy: null,
        lastRun: null,
        weeklyAt: "",
        report: { state: "none" },
        proposed: 0,
      }).success,
    ).toBe(true);
    expect(SETTING_VALUE_SCHEMAS.healthRunAt.safeParse("20:00").success).toBe(true);
    expect(CORE_PATH_PATTERN.test("/glucose")).toBe(true);
    expect(PagePanelPayloadSchema.safeParse({ page: "Health" }).success).toBe(true);
  });
});
