import {
  HealthReportSchema,
  HealthStatusSchema,
  NodeJobSchema,
  UuidSchema,
} from "@noctis/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { tirSegments, viewState } from "../health/health-view.js";
import { LARP_IDS } from "./ids.js";
import type { healthArea as HealthArea } from "./health.js";

let area: typeof HealthArea;
let attempt = 0;
const now = new Date("2026-11-05T12:00:00.000Z");
const JobRecordSchema = z.object({ job: NodeJobSchema });
const GrantResultSchema = z.object({ id: UuidSchema }).strict();
const DaySchema = z.object({
  readings: z.array(z.object({ at: z.string(), mmolL: z.number() })).length(288),
});

function status() {
  const response = area.request!("GET", "/glucose?fresh=1", undefined);
  expect(response?.status).toBe(200);
  return HealthStatusSchema.parse(response?.body);
}

function report() {
  const current = status();
  expect(current.report.state).toBe("ok");
  if (current.report.state !== "ok") throw new Error("Expected a health report");
  return HealthReportSchema.parse(current.report.report);
}

function command(name: string, body: Record<string, unknown> = {}) {
  return area.request!("POST", `/commands/health.${name}?source=health`, {
    idempotencyKey: `health-test-${++attempt}`,
    ...body,
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.resetModules();
  area = (await import("./health.js")).healthArea;
});

afterEach(() => vi.useRealTimers());

describe("health LARP area", () => {
  it("serves a current, schema-valid report and Nodes health status on Home PC", () => {
    const current = status();
    expect(current).toMatchObject({
      granted: true,
      nodeId: LARP_IDS.homeNode,
      nodeOnline: true,
      busy: null,
      proposed: 3,
      lastRun: { outcome: "written" },
    });
    expect(viewState(current, now)).toMatchObject({ kind: "ok", staleSince: null });
    const data = report();
    expect(data.generated_at).toMatch(/^2026-11-05T/);
    expect(data.period.days).toBe(14);
    expect(data.agp).toHaveLength(24);
    expect(tirSegments(data.stats)!.reduce((sum, segment) => sum + segment.pct, 0)).toBeCloseTo(
      100,
    );
    expect(data.findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(["carb_ratio", "pre_bolus", "isf", "basal"]),
    );
    expect(data.suggestions.map((suggestion) => suggestion.setting)).toEqual(
      expect.arrayContaining(["carb_ratio", "isf", "basal"]),
    );
    expect(data.changes.some((change) => change.outcome === "helped")).toBe(true);
    for (const finding of data.findings) {
      expect(finding.traces.length).toBeGreaterThanOrEqual(2);
      for (const trace of finding.traces) {
        expect(trace.t0 >= data.period.start && trace.t0 <= data.period.end).toBe(true);
        expect(trace.points.length).toBeGreaterThan(20);
      }
    }
  });

  it("includes an invented full day of readings at five-minute intervals", () => {
    const day = DaySchema.parse(report().glucose_day);
    expect(day.readings[0]!.at).toBe("2026-11-04T00:00:00");
    expect(day.readings.at(-1)!.at).toBe("2026-11-04T23:55:00");
    for (const [index, reading] of day.readings.entries()) {
      expect(reading.mmolL).toBeGreaterThan(2);
      expect(reading.mmolL).toBeLessThan(20);
      if (index > 0)
        expect(Date.parse(reading.at) - Date.parse(day.readings[index - 1]!.at)).toBe(300_000);
    }
  });

  it.each(["refresh", "run_now"])("answers health.%s with the real node job shape", (name) => {
    vi.setSystemTime(new Date("2026-11-05T12:30:00.000Z"));
    const response = command(name);
    expect(response?.status).toBe(200);
    const record = JobRecordSchema.parse(response?.body);
    expect(record.job).toMatchObject({
      capability: name === "refresh" ? "health.report" : "health.run",
      pinnedNodeId: LARP_IDS.homeNode,
      payload: {},
    });
    expect(status().busy).toBeNull();
    expect(status().report).toMatchObject({ receivedAt: "2026-11-05T12:30:00.000Z" });
    if (name === "run_now") {
      expect(status().lastRun).toEqual({ at: "2026-11-05T12:30:00.000Z", outcome: "written" });
      expect(report().generated_at).toBe("2026-11-05T12:30:00");
    }
  });

  it.each([
    ["mark-applied", "applied"],
    ["dismiss", "dismissed"],
  ])("keeps %s and undo decisions in memory", (action, expectedStatus) => {
    const suggestion = report().suggestions[0]!;
    const response = command("decide", { id: suggestion.id, action });
    expect(response?.status).toBe(200);
    expect(JobRecordSchema.parse(response?.body).job).toMatchObject({
      capability: "health.decide",
      payload: { id: suggestion.id, action },
    });
    expect(report().suggestions[0]!.status).toBe(expectedStatus);
    expect(status().proposed).toBe(2);
    if (action === "mark-applied")
      expect(report().changes.find((change) => change.id === suggestion.id)).toMatchObject({
        outcome: "pending",
        applied_at: "2026-11-05T12:00:00",
      });

    expect(command("decide", { id: suggestion.id, action: "reset" })?.status).toBe(200);
    expect(report().suggestions[0]!.status).toBe("proposed");
    expect(status().proposed).toBe(3);
    expect(report().changes.some((change) => change.id === suggestion.id)).toBe(false);
    expect(report().changes.some((change) => change.outcome === "helped")).toBe(true);
  });

  it("handles an unknown suggestion as a completed no-op job", () => {
    const before = report();
    const response = command("decide", { id: "unknown-suggestion", action: "dismiss" });
    expect(response?.status).toBe(200);
    JobRecordSchema.parse(response?.body);
    expect(report()).toEqual(before);
  });

  it("allows and disallows Health as the Nodes page does", () => {
    const stopped = command("disallow", { nodeId: LARP_IDS.homeNode });
    expect(stopped?.status).toBe(200);
    expect(GrantResultSchema.parse(stopped?.body)).toEqual({ id: LARP_IDS.homeNode });
    expect(status()).toMatchObject({ granted: false, nodeId: null, nodeOnline: false });
    expect(viewState(status(), now).kind).toBe("not_allowed");
    expect(command("run_now")).toMatchObject({
      status: 503,
      body: { error: { details: { reason: "not_allowed" } } },
    });

    const allowed = command("allow", { nodeId: LARP_IDS.workNode, repo: "C:/Fiction/glycolens" });
    expect(allowed?.status).toBe(200);
    expect(GrantResultSchema.parse(allowed?.body)).toEqual({ id: LARP_IDS.workNode });
    expect(status()).toMatchObject({ granted: true, nodeId: LARP_IDS.workNode, nodeOnline: true });
    expect(JobRecordSchema.parse(command("refresh")?.body).job.pinnedNodeId).toBe(
      LARP_IDS.workNode,
    );
  });

  it("replays a command without applying it a second time", () => {
    const suggestion = report().suggestions[0]!;
    const body = { idempotencyKey: "same-attempt", id: suggestion.id, action: "mark-applied" };
    const first = area.request!("POST", "/commands/health.decide", body);
    command("decide", { id: suggestion.id, action: "reset" });
    expect(area.request!("POST", "/commands/health.decide", body)).toEqual(first);
    expect(report().suggestions[0]!.status).toBe("proposed");
  });

  it.each([
    ["decide", { id: "bad id", action: "dismiss" }],
    ["decide", { id: "breakfast", action: "approve" }],
    ["allow", { nodeId: LARP_IDS.homeNode, repo: "relative/path" }],
    ["disallow", { nodeId: "unknown" }],
    ["refresh", { extra: true }],
  ])("validates health.%s without changing the report", (name, body) => {
    const before = status();
    expect(command(name, body)?.status).toBe(400);
    expect(status()).toEqual(before);
  });

  it("does not expose mutable report state in a response", () => {
    const response = status();
    if (response.report.state !== "ok") throw new Error("Expected report");
    (response.report.report as { suggestions: unknown[] }).suggestions.length = 0;
    expect(report().suggestions).toHaveLength(3);
  });

  it("leaves unrelated routes, event subscription and future commands to their owners", () => {
    for (const path of ["/events?after=0&limit=1", "/nodes", "/glucose/extra", "/health"])
      expect(area.request!("GET", path, undefined)).toBeUndefined();
    expect(area.request!("POST", "/glucose", {})).toBeUndefined();
    expect(area.request!("GET", "/commands/health.run_now", undefined)).toBeUndefined();
    expect(command("future_command")).toBeUndefined();
    expect(area.request!("POST", "/commands/health.run_now/extra", {})).toBeUndefined();
  });
});
