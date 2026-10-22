import {
  AllowHealthCommandSchema,
  DisallowHealthCommandSchema,
  HealthCommandSchema,
  HealthDecideCommandSchema,
  HealthReportSchema,
  HealthStatusSchema,
} from "@noctis/contracts";

import type { CoreResponse } from "../transport/CoreTransport.js";
import type { LarpArea } from "./area.js";
import { ok, parsePath, rebase } from "./area.js";
import fixture from "./fixtures/health.json?raw";

const state = HealthStatusSchema.parse(rebase(JSON.parse(fixture) as unknown));

// The fixture uses UTC for rebase; glycolens's report schema uses naive local clocks.
function reportClocks(value: unknown): unknown {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value))
    return value.slice(0, 19);
  if (Array.isArray(value)) return value.map(reportClocks);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, reportClocks(item)]),
    );
  return value;
}

if (state.report.state !== "ok") throw new Error("Expected the fictional health report");
const report = HealthReportSchema.parse(reportClocks(state.report.report));
state.report.report = report;
const replies = new Map<string, CoreResponse>();
let jobNumber = 0;

const commands = {
  "health.allow": AllowHealthCommandSchema,
  "health.disallow": DisallowHealthCommandSchema,
  "health.refresh": HealthCommandSchema,
  "health.run_now": HealthCommandSchema,
  "health.decide": HealthDecideCommandSchema,
};

export const healthArea: LarpArea = {
  request(method, path, body) {
    const { segments } = parsePath(path);
    if (method === "GET" && segments.length === 1 && segments[0] === "glucose") {
      state.proposed = report.suggestions.filter(
        (suggestion) => suggestion.status === "proposed",
      ).length;
      return ok(structuredClone(state));
    }
    const name = segments[1];
    if (
      method !== "POST" ||
      segments.length !== 2 ||
      segments[0] !== "commands" ||
      name === undefined ||
      !Object.hasOwn(commands, name)
    )
      return undefined;

    const parsed = commands[name as keyof typeof commands].safeParse(body);
    if (!parsed.success)
      return {
        status: 400,
        body: {
          error: {
            code: "invalid_request",
            message: "The command did not match its schema",
            details: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              code: issue.code,
            })),
          },
        },
      };
    const command = parsed.data;
    const key = `${name}:${command.idempotencyKey}`;
    const previous = replies.get(key);
    if (previous !== undefined) return structuredClone(previous);
    const at = new Date().toISOString();
    let response: CoreResponse;

    if (name === "health.allow") {
      const grant = AllowHealthCommandSchema.parse(body);
      state.nodeId = grant.nodeId;
      state.granted = true;
      state.nodeOnline = true;
      response = ok({ id: grant.nodeId });
    } else if (name === "health.disallow") {
      const grant = DisallowHealthCommandSchema.parse(body);
      if (state.nodeId === grant.nodeId) {
        state.nodeId = null;
        state.granted = false;
        state.nodeOnline = false;
      }
      response = ok({ id: grant.nodeId });
    } else {
      if (!state.granted)
        return {
          status: 503,
          body: {
            error: {
              code: "unavailable",
              message: "health is unavailable",
              details: { reason: "not_allowed" },
            },
          },
        };

      const decision = name === "health.decide" ? HealthDecideCommandSchema.parse(body) : undefined;
      if (decision !== undefined) {
        const suggestion = report.suggestions.find((item) => item.id === decision.id);
        if (suggestion !== undefined) {
          suggestion.status =
            decision.action === "mark-applied"
              ? "applied"
              : decision.action === "dismiss"
                ? "dismissed"
                : "proposed";
          const changeIndex = report.changes.findIndex((change) => change.id === suggestion.id);
          if (decision.action === "mark-applied" && changeIndex === -1)
            report.changes.push({
              id: suggestion.id,
              window: suggestion.window,
              setting: suggestion.setting,
              direction: suggestion.direction,
              current: suggestion.current,
              proposed: suggestion.proposed,
              applied_at: at.slice(0, 19),
              outcome: "pending",
              outcome_final: false,
              before: structuredClone(
                report.windows.find((window) => window.name === suggestion.window) ?? report.stats,
              ),
              after: null,
            });
          if (decision.action === "reset" && changeIndex !== -1)
            report.changes.splice(changeIndex, 1);
        }
      }
      if (name === "health.run_now") {
        state.lastRun = { at, outcome: "written" };
        report.generated_at = at.slice(0, 19);
      }
      if (state.report.state === "ok") state.report.receivedAt = at;

      // Jobs finish in memory before the next read; the command still returns its queued record.
      const id = `01a05c32-8000-7000-8000-${(++jobNumber).toString(16).padStart(12, "0")}`;
      response = ok({
        job: {
          id,
          pinnedNodeId: state.nodeId,
          capability:
            name === "health.refresh"
              ? "health.report"
              : name === "health.run_now"
                ? "health.run"
                : "health.decide",
          status: "queued",
          idempotencyKey: `health:${id}`,
          attempts: 0,
          payloadVersion: 1,
          payload: decision === undefined ? {} : { id: decision.id, action: decision.action },
          revision: 0,
          createdAt: at,
          updatedAt: at,
        },
      });
    }
    replies.set(key, structuredClone(response));
    return response;
  },
};
