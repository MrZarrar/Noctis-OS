import { healthReportFixture } from "@noctis/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HealthReportView } from "./HealthReportView.js";

const status = (report: unknown, extra = {}) => ({
  granted: true,
  nodeId: null,
  nodeOnline: true,
  busy: null,
  lastRun: null,
  weeklyAt: "20:00",
  proposed: 1,
  report: { state: "ok" as const, receivedAt: "2026-10-11T19:04:00.000Z", report },
  ...extra,
});
const render = (props: Partial<Parameters<typeof HealthReportView>[0]>) =>
  renderToStaticMarkup(
    createElement(HealthReportView, {
      status: undefined,
      now: new Date("2026-10-12T09:00:00"),
      onRunNow: () => undefined,
      onDecide: () => undefined,
      ...props,
    }),
  );

describe("HealthReportView", () => {
  it("shows every section of a report and the not-medical-advice line", () => {
    const html = render({ status: status(healthReportFixture()) });
    for (const text of [
      "71.4",
      "Breakfast: 2 of 3 meals ended high",
      "from 10 to 9 g/U",
      "Applied",
      "Dismiss",
      "provisional",
      "2 of 5 meals so far",
      "possible sensor low",
      "Not medical advice",
    ])
      expect(html).toContain(text);
  });

  it("shows the stale banner, the unreadable state and the allow hint", () => {
    expect(
      render({ status: status(healthReportFixture()), now: new Date("2026-10-25T09:00:00") }),
    ).toContain("Data stale since");
    expect(render({ status: status({ nope: true }) })).toContain("Report unreadable");
    expect(
      render({ status: { ...status(null), granted: false, report: { state: "none" } } }),
    ).toContain("Allow health on the Nodes page");
  });

  it("disables decisions and Run now while glycolens is running", () => {
    const html = render({ status: status(healthReportFixture(), { busy: "run" }) });
    expect(html).toContain("glycolens is running");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Applied/);
  });
});
