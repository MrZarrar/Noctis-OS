import type { HealthReport } from "@noctis/contracts";
import { HealthReportSchema } from "@noctis/contracts";

import type { NoctisDatabase } from "../db/connection.js";

export interface StoredHealthReport {
  state: "ok" | "unreadable" | "missing";
  body?: string;
  reason?: string;
  jobId: string;
  receivedAt: string;
}

export function parseHealthReport(
  text: string,
): { state: "ok"; report: HealthReport } | { state: "unreadable"; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { state: "unreadable", reason: "report.json is not JSON" };
  }
  const parsed = HealthReportSchema.safeParse(json);
  if (parsed.success) return { state: "ok", report: parsed.data };
  // Error messages can contain readings; only expose the schema path and code.
  const issue = parsed.error.issues[0];
  return {
    state: "unreadable",
    reason: `${issue?.path.join(".") || "report"}: ${issue?.code ?? "invalid"}`,
  };
}

export function storeHealthReport(db: NoctisDatabase, row: StoredHealthReport): void {
  db.prepare(
    `INSERT INTO health_report (id, state, body, reason, job_id, received_at) VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET state = excluded.state, body = excluded.body, reason = excluded.reason,
       job_id = excluded.job_id, received_at = excluded.received_at`,
  ).run(row.state, row.body ?? null, row.reason ?? null, row.jobId, row.receivedAt);
}

export function readHealthReport(db: NoctisDatabase): StoredHealthReport | undefined {
  const row = db
    .prepare("SELECT state, body, reason, job_id, received_at FROM health_report WHERE id = 1")
    .get() as
    | {
        state: StoredHealthReport["state"];
        body: string | null;
        reason: string | null;
        job_id: string;
        received_at: string;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    state: row.state,
    ...(row.body === null ? {} : { body: row.body }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    jobId: row.job_id,
    receivedAt: row.received_at,
  };
}

export const proposedIds = (report: HealthReport): string[] =>
  report.suggestions.filter((s) => s.status === "proposed").map((s) => s.id);

export const suggestionIds = (report: HealthReport): Set<string> =>
  new Set(report.suggestions.map((s) => s.id));
