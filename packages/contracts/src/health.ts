import { z } from "zod";

import { IdempotencyKeySchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

/**
 * glycolens's report.json (schema_version 1), as the Health panel reads it.
 *
 * Objects are loose on purpose: glycolens adds fields additively without
 * bumping schema_version (traces arrived that way), and a newer field must not
 * turn a good report into "report unreadable". What Noctis reads is checked.
 */
export const MAX_HEALTH_REPORT_BYTES = 4 * 1024 * 1024;

const LocalTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "naive local time");
const ClockTime = z.string().regex(/^\d{2}:\d{2}$/);
const Value = z.number().nullable();
const Point = z.tuple([z.number(), z.number()]);

export const HealthStatsSchema = z.looseObject({
  coverage: z.number(),
  mean: Value,
  tir: Value,
  tbr: Value,
  tbr_severe: Value,
  tar: Value,
  tar_severe: Value,
  gmi: Value,
  cv: Value,
  min: Value,
});

export const HealthTraceSchema = z.looseObject({
  t0: LocalTime,
  hit: z.boolean(),
  /** [minutes after t0, mmol/L], about every 5 min; a gap is missing CGM. */
  points: z.array(Point).max(5_000),
  carbs: z.number().optional(),
  units: z.number().optional(),
  expected_drop: z.number().optional(),
  ratio: z.number().nullable().optional(),
  /** [minute, hourly delivered ÷ programmed]; null when nothing was programmed. */
  basal: z
    .array(z.tuple([z.number(), z.number().nullable()]))
    .max(48)
    .optional(),
  minutes: z.number().optional(),
});

export const HealthFindingSchema = z.looseObject({
  rule: z.enum(["carb_ratio", "pre_bolus", "isf", "basal", "exercise_low"]),
  window: z.string(),
  /** "stronger" means more insulin. */
  direction: z.enum(["stronger", "weaker", ""]),
  events: z.int().nonnegative(),
  hits: z.int().nonnegative(),
  metric: z.number(),
  text: z.string(),
  evidence: z.array(z.string()),
  traces: z.array(HealthTraceSchema).max(500).default([]),
});

const Setting = z.enum(["carb_ratio", "isf", "basal"]);

export const HealthSuggestionSchema = z.looseObject({
  id: z.string(),
  window: z.string(),
  setting: Setting,
  direction: z.enum(["stronger", "weaker"]),
  current: z.number(),
  proposed: z.number(),
  step_pct: z.number(),
  text: z.string(),
  evidence: z.array(z.string()),
  status: z.enum(["proposed", "applied", "dismissed"]),
});

export const HealthChangeSchema = z.looseObject({
  id: z.string(),
  window: z.string(),
  setting: Setting,
  direction: z.enum(["stronger", "weaker"]),
  current: z.number(),
  proposed: z.number(),
  applied_at: LocalTime,
  outcome: z.enum(["pending", "helped", "no_change", "worse"]),
  outcome_final: z.boolean(),
  before: HealthStatsSchema.nullable(),
  after: HealthStatsSchema.nullable(),
});

export const HealthReportSchema = z.looseObject({
  schema_version: z.literal(1),
  generated_at: LocalTime,
  period: z.looseObject({ start: LocalTime, end: LocalTime, days: z.number() }),
  data_through: LocalTime,
  stale_since: LocalTime.nullable(),
  summary: z.string(),
  summary_source: z.enum(["template", "qwen"]),
  stats: HealthStatsSchema,
  windows: z.array(
    HealthStatsSchema.extend({ name: z.string(), start: ClockTime, end: ClockTime }),
  ),
  agp: z
    .array(
      z.looseObject({
        hour: z.int().min(0).max(23),
        p5: Value,
        p25: Value,
        p50: Value,
        p75: Value,
        p95: Value,
      }),
    )
    .length(24),
  findings: z.array(HealthFindingSchema),
  suggestions: z.array(HealthSuggestionSchema),
  watching: z.array(z.looseObject({ window: z.string(), rule: z.string(), reason: z.string() })),
  changes: z.array(HealthChangeSchema),
  /** Likely false CGM lows. glycolens still counts them as real lows. */
  possible_sensor_lows: z.array(LocalTime).default([]),
});

export type HealthReport = z.infer<typeof HealthReportSchema>;
export type HealthTrace = z.infer<typeof HealthTraceSchema>;
export type HealthFinding = z.infer<typeof HealthFindingSchema>;
export type HealthSuggestion = z.infer<typeof HealthSuggestionSchema>;
export type HealthChange = z.infer<typeof HealthChangeSchema>;
export type HealthStats = z.infer<typeof HealthStatsSchema>;

/* ---- the node capabilities ---- */

export const HEALTH_CAPABILITIES = ["health.report", "health.run", "health.decide"] as const;

/** Starts with a letter, digit or underscore, so argparse can never read it as an option. */
export const HealthSuggestionIdSchema = z.string().regex(/^\w[\w.-]{0,119}$/);
export const HealthDecideActionSchema = z.enum(["mark-applied", "dismiss", "reset"]);

export const HealthReportPayloadSchema = z.object({}).strict();
export const HealthRunPayloadSchema = z.object({}).strict();
export const HealthDecidePayloadSchema = z
  .object({ id: HealthSuggestionIdSchema, action: HealthDecideActionSchema })
  .strict();

/** What happened to report.json after the job: its bytes went up the stream, or why not. */
const ReportSent = z.enum(["sent", "missing", "too_large"]);

export const HealthReportEvidenceSchema = z.object({ report: ReportSent }).strict();
export const HealthRunEvidenceSchema = z
  .object({
    outcome: z.enum(["written", "stale", "no_data", "no_login"]),
    /** glycolens's own one-line stderr reason. Never readings. */
    reason: z.string().max(300).optional(),
    report: ReportSent,
  })
  .strict();
export const HealthDecideEvidenceSchema = z
  .object({ result: z.enum(["changed", "already", "unknown_id"]), report: ReportSent })
  .strict();

const AbsoluteFolder = z
  .string()
  .trim()
  .min(3)
  .max(260)
  .refine((path) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/"), "an absolute folder");

/** Chosen by the owner at grant time. A job never names a path. */
export const HealthGrantConstraintsSchema = z
  .object({
    /** The glycolens checkout; its .venv runs the CLI. */
    repo: AbsoluteFolder,
    /** Where report.json lives, when glycolens's config moved `home`. Default ~/.glycolens. */
    home: AbsoluteFolder.optional(),
  })
  .strict();

/* ---- the core API ---- */

export const HealthStatusSchema = z
  .object({
    granted: z.boolean(),
    nodeId: UuidSchema.nullable(),
    nodeOnline: z.boolean(),
    busy: z.enum(["run", "decide", "report"]).nullable(),
    lastRun: z
      .object({
        at: UtcTimestampSchema,
        outcome: z.enum(["written", "stale", "no_data", "no_login", "failed"]),
        reason: z.string().max(300).optional(),
      })
      .nullable(),
    /** The weekly run's Sunday time, "" when off. */
    weeklyAt: z.string(),
    report: z.discriminatedUnion("state", [
      z.object({ state: z.literal("none") }),
      z.object({ state: z.literal("missing"), receivedAt: UtcTimestampSchema }),
      z.object({
        state: z.literal("unreadable"),
        receivedAt: UtcTimestampSchema,
        reason: z.string(),
      }),
      /** Re-validated with HealthReportSchema by the page, which never trusts a wire. */
      z.object({ state: z.literal("ok"), receivedAt: UtcTimestampSchema, report: z.unknown() }),
    ]),
    proposed: z.int().nonnegative(),
  })
  .strict();
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const AllowHealthCommandSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    nodeId: UuidSchema,
    repo: AbsoluteFolder,
    home: AbsoluteFolder.optional(),
  })
  .strict();
export const DisallowHealthCommandSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema, nodeId: UuidSchema })
  .strict();
/** `health.refresh` and `health.run_now`: nothing to say but which attempt this is. */
export const HealthCommandSchema = z.object({ idempotencyKey: IdempotencyKeySchema }).strict();
export const HealthDecideCommandSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    id: HealthSuggestionIdSchema,
    action: HealthDecideActionSchema,
  })
  .strict();
export type AllowHealthCommand = z.infer<typeof AllowHealthCommandSchema>;
export type DisallowHealthCommand = z.infer<typeof DisallowHealthCommandSchema>;
export type HealthCommand = z.infer<typeof HealthCommandSchema>;
export type HealthDecideCommand = z.infer<typeof HealthDecideCommandSchema>;
