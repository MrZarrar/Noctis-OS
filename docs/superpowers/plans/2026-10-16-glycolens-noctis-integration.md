# glycolens Plan 2: Noctis integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Noctis runs glycolens on the home PC every Sunday (and on demand), stores the latest validated
`report.json`, and shows it in a Health panel that looks like a premium instrument, with Applied / Dismiss
going back to glycolens.

**Architecture:** Three home-node capabilities (`health.report`, `health.run`, `health.decide`) spawn the
glycolens CLI and stream `report.json` to the core over the existing `POST /node/files` path (reports with
traces are larger than the 64 KB node frame). The core validates and stores the latest report, sweeps a
weekly timer, and serves `GET /glucose`. The web gets a Health rail page and page panel: Claude wires the
data and a plain, complete page; Astra (Codex) then builds the visuals on a pure view model.

**Tech Stack:** TypeScript, Zod 4, Node 22.23.2, better-sqlite3 migrations, React 18, Vitest. Visual
libraries are chosen by Astra in Task 7 (any are allowed).

**Spec:** the owner's two briefs of 2026-10-16 (Plan 2 brief and the "graphable evidence" add-on), plus
glycolens `docs/design.md` ("report.json", "Noctis integration", "Scheduling", "Sensor artefacts") and
`src/glycolens/report.py` `build()` at commit `fdbd7d6`. Decisions settled in brainstorming are below.

### Decisions (brainstorming, 2026-10-16)

| Question | Decision |
| --- | --- |
| Health data on the work-PC core | Owner: passing **and storing** it on the core is fine. Still: no readings in logs, telemetry or commits; no cloud sync; never exposed to agent tools or hosted models. |
| Where `health.run`'s schedule lives | **Core weekly timer.** Setting "Weekly health run (Sundays)" (HH:MM, empty = off). The core's 1 s sweep finds the latest passed Sunday occurrence; if no run finished for it and the home node is online and idle, it queues one job keyed to that occurrence. PC off for days: one run when it is next online (only the latest missed week, no 24 h expiry). Lost/expired jobs retry; a finished run (any outcome) closes the week. |
| Panel placement and signal | **Health rail tab + page panel**, badge = number of `proposed` suggestions, and one push after a run that adds new suggestions ("2 new health suggestions", no readings). |
| On-demand run | **Yes:** "Run now" on the panel queues the same `health.run` job. |
| Authority | Default for an unanswered question: **standing permissions.** "Allow health on this PC" (Nodes page) grants the three capabilities plus standing permissions, so Run now, Applied, Dismiss and the Sunday run need no second confirm. "Stop" revokes all of it. |
| Visuals | Astra owns them, last. **Any libraries are allowed** (owner: "idc about dependencies"; looking great matters). |
| Rail visibility (plan-time simplification) | The Health tab is always in the rail; ungranted, the page says how to allow it. Hiding it would need a new Rail/TabBar prop for one page. |

## Global Constraints

- Node.js 22.23.2 and the exact package lock; new packages are installed with `--save-exact`.
- Noctis never imports glycolens code. It only runs `<repo>\.venv\Scripts\python.exe -m glycolens.cli <cmd>` with `<repo>` as the working directory; never `glycolens.exe`; never `login`; never handles the Tandem password.
- `run` timeout is 15 min (spec: 10 min or more). Decisions time out after 60 s.
- Never run `mark-applied` / `dismiss` / `reset` while `run` is in progress: one lock on the node for every health job, and the core refuses a decide while a run is queued or running.
- Read `report.json` whole and close it at once (`fs.readFile`), never hold a handle.
- Decode glycolens stdout/stderr as UTF-8.
- `report.json` times are naive local ISO `YYYY-MM-DDTHH:MM:SS`; glucose mmol/L; insulin U.
- Window names come from the report (`windows[]`), never hardcoded.
- A malformed report shows "report unreadable", never a crash.
- Stale banner when `stale_since` is set **or** `generated_at` is more than 8 days old.
- Every number shown comes from `report.json`; no client-side medical inference or advice; a "not medical advice" line is always visible. Display geometry (segment sizes, a median curve, chart ranges) is allowed.
- "Applied" means the owner already changed the pump. Noctis never changes pump settings and never auto-applies.
- Health data never leaves the owner's machines: no readings in logs, events, telemetry, push bodies or commits; test fixtures are synthetic; nothing goes to remote services or models; charts render locally.
- Capabilities are default-off until the owner grants them. No Windows Task Scheduler registration.
- Never meaning by red/green alone; honour `prefers-reduced-motion`; readable on the phone.
- Commit and push to `origin/main` after each task passes its tests and review. No AI co-author trailers.
- Deploy order on release: work-PC core first, then the home node (a node advertising capabilities the core lacks is rejected at hello).

## Review Focus

1. A real report with traces is hundreds of KB (indent=2 JSON): it must arrive whole through the stream, never through a 64 KB frame. Pinned by Task 3's 1 MB accept test.
2. The owner taps Applied while the Sunday run is going: the decide must wait or be refused, never interleave with the rewrite of `report.json`. Pinned by Task 2's lock test and Task 4's `run_in_progress` test.
3. The home PC was off for three Sundays, or the run ends `no_login`: exactly one catch-up run, and no retry loop every second. Pinned by Task 4's catch-up tests.
4. A report from older glycolens (no `traces`) or newer glycolens (extra fields): still renders. Pinned by Task 1's schema tests.
5. `stale_since` is null but the report is 9 days old (glycolens did not run): the banner still shows. Pinned by Task 5's view-model test.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/health.ts` (create) | `HealthReportSchema`, payload/evidence/constraint schemas, `HealthStatusSchema`, health command schemas, `MAX_HEALTH_REPORT_BYTES` |
| `packages/contracts/src/health-fixture.ts` (create) | `healthReportFixture()`: a synthetic report for tests and the visual preview |
| `packages/contracts/src/node.ts` (modify) | Register the three capabilities, their classes and contracts |
| `packages/contracts/src/settings.ts`, `api.ts`, `surface-payloads.ts`, `index.ts` (modify) | `healthRunAt` setting, `glucose` API segment, `"Health"` page panel, exports |
| `apps/node-agent/src/health.ts` (create) | The three adapters: spawn glycolens, lock, timeout, classify output, stream the report |
| `apps/node-agent/src/adapters.ts` (modify) | Add the adapters to `ADAPTERS` |
| `apps/core/migrations/0021_health.sql` (create) | `health_report` (latest report), `health_runs` (weekly occurrence → job) |
| `apps/core/src/health/store.ts` (create) | Parse, store and read the latest report; proposed ids |
| `apps/core/src/health/service.ts` (create) | Stream accept, push, status, commands (allow, disallow, refresh, run now, decide), weekly pass |
| `apps/core/src/nodes/registry.ts` (modify) | Validate health grant constraints |
| `apps/core/src/config/settings.ts`, `apps/core/src/server.ts`, `apps/core/src/api/http.ts` (modify) | Setting entry, wiring, routes |
| `packages/ui/src/primitives/rail-items.ts` (modify) | `"Health"` rail item |
| `apps/web/src/health/health-view.ts` (create) | Pure view model: report state, stale banner, TIR segments, median trace, sensor-low markers |
| `apps/web/src/health/useHealth.ts` (create) | Fetch `GET /glucose`, follow events, actions |
| `apps/web/src/health/HealthReportView.tsx` (create) | Pure presentational page (props only); Astra restyles it |
| `apps/web/src/pages/Health.tsx` (create) | Data page: hook + `HealthReportView` |
| `apps/web/src/pages/Nodes.tsx`, `apps/web/src/App.tsx` (modify) | Allow/Stop health; rail page, page panel, badge |
| `apps/web/src/health/visuals/*` (Astra, create) | Hero AGP, TIR ring, spaghetti charts, basal heat strip, change morphs |
| `apps/web/e2e/health.html`, `health.fixture.jsx`, `health.test.mjs` (Astra, create) | Fixture preview and visual gate |

Tasks 1–6 run on any PC (glycolens is faked in tests). Task 8's live steps need the home PC.

---

### Task 1: Health contract

**Files:**
- Create: `packages/contracts/src/health.ts`, `packages/contracts/src/health-fixture.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/settings.ts`, `packages/contracts/src/api.ts`, `packages/contracts/src/surface-payloads.ts`
- Test: `packages/contracts/src/health.test.ts`

**Interfaces:**
- Produces: `HealthReportSchema`, `HealthReport` (output type), `HealthTraceSchema`, `HealthFindingSchema`, `HealthSuggestionSchema`, `HealthChangeSchema`, `HealthStatsSchema`; `HealthReportPayloadSchema`, `HealthRunPayloadSchema`, `HealthDecidePayloadSchema`, `HealthReportEvidenceSchema`, `HealthRunEvidenceSchema`, `HealthDecideEvidenceSchema`, `HealthGrantConstraintsSchema`; `HealthStatusSchema`, `HealthStatus`; `AllowHealthCommandSchema`, `DisallowHealthCommandSchema`, `HealthCommandSchema`, `HealthDecideCommandSchema`; `MAX_HEALTH_REPORT_BYTES = 4 * 1024 * 1024`; `HEALTH_CAPABILITIES`; `healthReportFixture(): z.input<typeof HealthReportSchema>`; setting key `healthRunAt`; API segment `glucose`; page panel `"Health"`.

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/health.test.ts`:

```ts
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
    const report = { ...healthReportFixture(), new_section: [1], stats: { ...healthReportFixture().stats, iqr: 2 } };
    expect(HealthReportSchema.safeParse(report).success).toBe(true);
  });

  it("accepts the nulls glycolens writes when there is no data", () => {
    const report = healthReportFixture();
    report.agp[3] = { hour: 3, p5: null, p25: null, p50: null, p75: null, p95: null };
    report.stats = { coverage: 0, mean: null, tir: null, tbr: null, tbr_severe: null, tar: null, tar_severe: null, gmi: null, cv: null, min: null };
    report.changes[0]!.after = null;
    expect(HealthReportSchema.safeParse(report).success).toBe(true);
  });

  it("rejects a newer schema version and an unknown rule", () => {
    expect(HealthReportSchema.safeParse({ ...healthReportFixture(), schema_version: 2 }).success).toBe(false);
    const report = healthReportFixture();
    (report.findings[0] as { rule: string }).rule = "site_age";
    expect(HealthReportSchema.safeParse(report).success).toBe(false);
  });
});

describe("health payloads", () => {
  it("never lets a suggestion id become a CLI option", () => {
    expect(HealthDecidePayloadSchema.safeParse({ id: "2026-W41-breakfast-carb_ratio", action: "mark-applied" }).success).toBe(true);
    expect(HealthDecidePayloadSchema.safeParse({ id: "--help", action: "dismiss" }).success).toBe(false);
    expect(HealthDecidePayloadSchema.safeParse({ id: "a b", action: "dismiss" }).success).toBe(false);
    expect(HealthDecidePayloadSchema.safeParse({ id: "x", action: "login" }).success).toBe(false);
  });

  it("takes only absolute folders in a grant", () => {
    expect(HealthGrantConstraintsSchema.safeParse({ repo: "C:\\Users\\me\\Documents\\glycolens" }).success).toBe(true);
    expect(HealthGrantConstraintsSchema.safeParse({ repo: "glycolens" }).success).toBe(false);
  });

  it("describes the panel's status, the setting, the route and the page", () => {
    expect(
      HealthStatusSchema.safeParse({
        granted: false, nodeId: null, nodeOnline: false, busy: null, lastRun: null, weeklyAt: "",
        report: { state: "none" }, proposed: 0,
      }).success,
    ).toBe(true);
    expect(SETTING_VALUE_SCHEMAS.healthRunAt.safeParse("20:00").success).toBe(true);
    expect(CORE_PATH_PATTERN.test("/glucose")).toBe(true);
    expect(PagePanelPayloadSchema.safeParse({ page: "Health" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/health.test.ts`
Expected: FAIL, `healthReportFixture` / `HealthReportSchema` are not exported.

- [ ] **Step 3: Write the contract**

`packages/contracts/src/health.ts`:

```ts
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
  basal: z.array(z.tuple([z.number(), z.number().nullable()])).max(48).optional(),
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
  windows: z.array(HealthStatsSchema.extend({ name: z.string(), start: ClockTime, end: ClockTime })),
  agp: z
    .array(z.looseObject({ hour: z.int().min(0).max(23), p5: Value, p25: Value, p50: Value, p75: Value, p95: Value }))
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
      z.object({ state: z.literal("unreadable"), receivedAt: UtcTimestampSchema, reason: z.string() }),
      /** Re-validated with HealthReportSchema by the page, which never trusts a wire. */
      z.object({ state: z.literal("ok"), receivedAt: UtcTimestampSchema, report: z.unknown() }),
    ]),
    proposed: z.int().nonnegative(),
  })
  .strict();
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const AllowHealthCommandSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema, nodeId: UuidSchema, repo: AbsoluteFolder, home: AbsoluteFolder.optional() })
  .strict();
export const DisallowHealthCommandSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema, nodeId: UuidSchema })
  .strict();
/** `health.refresh` and `health.run_now`: nothing to say but which attempt this is. */
export const HealthCommandSchema = z.object({ idempotencyKey: IdempotencyKeySchema }).strict();
export const HealthDecideCommandSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema, id: HealthSuggestionIdSchema, action: HealthDecideActionSchema })
  .strict();
export type AllowHealthCommand = z.infer<typeof AllowHealthCommandSchema>;
export type DisallowHealthCommand = z.infer<typeof DisallowHealthCommandSchema>;
export type HealthCommand = z.infer<typeof HealthCommandSchema>;
export type HealthDecideCommand = z.infer<typeof HealthDecideCommandSchema>;
```

`packages/contracts/src/health-fixture.ts` (synthetic numbers, no real data):

```ts
import type { z } from "zod";

import type { HealthReportSchema } from "./health.js";

type Report = z.input<typeof HealthReportSchema>;

const r1 = (value: number): number => Math.round(value * 10) / 10;

/** A smooth synthetic curve: `minutes` long, rising by `rise` at its middle. */
function curve(start: number, rise: number, minutes: number): [number, number][] {
  return Array.from({ length: minutes / 5 + 1 }, (_, i) => [
    i * 5,
    r1(start + rise * Math.sin((Math.PI * i * 5) / minutes)),
  ]);
}

function stats(tir: number) {
  return {
    coverage: 0.96, mean: 8.4, tir, tbr: 3.1, tbr_severe: 0.6, tar: r1(100 - tir - 3.1),
    tar_severe: 4.2, gmi: 6.9, cv: 34.5, min: 2.6,
  };
}

/** A synthetic fortnight in the shape glycolens writes. For tests and the visual preview only. */
export function healthReportFixture(): Report {
  return {
    schema_version: 1,
    generated_at: "2026-10-11T20:03:12",
    period: { start: "2026-09-27T19:55:00", end: "2026-10-11T19:56:00", days: 14 },
    data_through: "2026-10-11T19:55:00",
    stale_since: null,
    summary: "Synthetic fortnight for tests.",
    summary_source: "template",
    stats: stats(71.4),
    windows: [
      { name: "overnight", start: "00:00", end: "06:00", ...stats(82) },
      { name: "breakfast", start: "06:00", end: "11:00", ...stats(58.2) },
      { name: "lunch", start: "11:00", end: "17:00", ...stats(70.1) },
      { name: "dinner", start: "17:00", end: "24:00", ...stats(68.9) },
    ],
    agp: Array.from({ length: 24 }, (_, hour) => {
      const median = 7 + 2 * Math.sin(((hour - 6) / 24) * 2 * Math.PI);
      return { hour, p5: r1(median - 3), p25: r1(median - 1.2), p50: r1(median), p75: r1(median + 1.5), p95: r1(median + 4) };
    }),
    findings: [
      {
        rule: "carb_ratio", window: "breakfast", direction: "stronger", events: 3, hits: 2, metric: 3.4,
        text: "Breakfast: 2 of 3 meals ended high (median +3.4 mmol/L at 4h).",
        evidence: ["Mon 05 Oct 07:40: +3.6 at 4h", "Wed 07 Oct 07:55: +3.2 at 4h"],
        traces: [
          { t0: "2026-10-05T07:40:00", hit: true, carbs: 45, points: curve(7.2, 5, 240) },
          { t0: "2026-10-07T07:55:00", hit: true, carbs: 50, points: curve(6.8, 5.5, 240) },
          { t0: "2026-10-09T08:10:00", hit: false, carbs: 40, points: curve(6.5, 2, 240) },
        ],
      },
      {
        rule: "isf", window: "overnight", direction: "weaker", events: 2, hits: 2, metric: 1.6,
        text: "Overnight: corrections dropped 1.6x what your correction factor predicts (2 of 2).",
        evidence: ["Tue 06 Oct 02:00: 1.5 U, dropped 4.8"],
        traces: [
          { t0: "2026-10-06T02:00:00", hit: true, units: 1.5, expected_drop: 3, points: curve(13.1, -4.8, 300) },
          { t0: "2026-10-08T01:30:00", hit: true, units: 1, expected_drop: 2, points: curve(12.4, -3.6, 300) },
        ],
      },
      {
        rule: "basal", window: "overnight", direction: "stronger", events: 2, hits: 1, metric: 1.32,
        text: "Overnight: on 1 of 2 fasting days Control-IQ ran basal at a median 132% of programmed.",
        evidence: ["Mon 05 Oct: 132% of programmed"],
        traces: [
          {
            t0: "2026-10-05T00:00:00", hit: true, ratio: 1.32,
            basal: [[0, 1.1], [60, 1.4], [120, null], [180, 1.5], [240, 1.3], [300, 1.2]],
            points: curve(8, 2, 360),
          },
          {
            t0: "2026-10-06T00:00:00", hit: false, ratio: 1.02,
            basal: [[0, 1], [60, 1], [120, 1.1], [180, 1], [240, 0.9], [300, 1.1]],
            points: curve(7.4, 0.6, 360),
          },
        ],
      },
    ],
    suggestions: [
      {
        id: "2026-W41-breakfast-carb_ratio", window: "breakfast", setting: "carb_ratio", direction: "stronger",
        current: 10, proposed: 9, step_pct: 10,
        text: "Breakfast: consider strengthening your carb ratio from 10 to 9 g/U (10%).",
        evidence: ["Mon 05 Oct 07:40: +3.6 at 4h"], status: "proposed",
      },
    ],
    watching: [{ window: "lunch", rule: "pre_bolus", reason: "2 of 5 meals so far; needs 3" }],
    changes: [
      {
        id: "2026-W38-overnight-basal", window: "overnight", setting: "basal", direction: "stronger",
        current: 0.8, proposed: 0.88, applied_at: "2026-09-21T21:00:00", outcome: "helped",
        outcome_final: false, before: stats(64), after: stats(71.4),
      },
    ],
    possible_sensor_lows: ["2026-10-05T03:10:00"],
  };
}
```

Then:
- `packages/contracts/src/index.ts`: add `export * from "./health.js";` and `export * from "./health-fixture.js";`.
- `packages/contracts/src/settings.ts`: add `healthRunAt: SettingTimeSchema,` to `SETTING_VALUE_SCHEMAS` after `promoterAt`.
- `packages/contracts/src/api.ts`: add `"glucose",` to `API_SEGMENTS` in alphabetical position (after `"files"`). Not `health`: `/health` is the core's liveness check.
- `packages/contracts/src/surface-payloads.ts`: add `"Health",` to `PAGE_PANEL_PAGES` after `"Notes"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/health.test.ts`
Expected: PASS (8 tests). Then `npx tsc -b packages/contracts` exits 0.

The settings key makes `apps/core/src/config/settings.ts`'s `REGISTRY: Record<SettingKey, Entry>` fail to typecheck. Fix it in this task: add after `promoterAt`:

```ts
  healthRunAt: {
    env: "NOCTIS_HEALTH_RUN_AT",
    fromEnv: (raw) => raw.trim(),
    fallback: "",
    kind: "time",
    label: "Weekly health run (Sundays)",
    help: "When glycolens refreshes your Health report each Sunday, catching up if the PC was off. Empty is off.",
  },
```

`"Health"` in `PAGE_PANEL_PAGES` makes `App.tsx`'s page switch non-exhaustive. Add a temporary arm, which Task 6 replaces: `case "Health": return null;`.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src apps/core/src/config/settings.ts apps/web/src/App.tsx
git commit -m "feat(contracts): glycolens report.json schema, health capabilities and status"
git push origin main
```

---

### Task 2: Node adapters for `health.report`, `health.run`, `health.decide`

**Files:**
- Create: `apps/node-agent/src/health.ts`
- Modify: `packages/contracts/src/node.ts`, `apps/node-agent/src/adapters.ts`
- Test: `apps/node-agent/src/health.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas, `AdapterContext` / `Adapter` / `StreamedFile` (`apps/node-agent/src/adapters.ts:47-86`), `AdapterRefused` (`./runtimes/Runtime.js`), `killProcessTree` (`./runtimes/kill-tree.js`), `childEnvironment` (`./runtimes/env.js`).
- Produces: `createHealthAdapters(options?: HealthOptions): Record<"health.report" | "health.run" | "health.decide", Adapter>`; `runOutcome(code: number | null, stderr: string): { outcome: "written" | "stale" | "no_data" | "no_login"; reason?: string }`. In contracts, `NODE_CAPABILITIES` gains the three names, with classes `read_inspect` / `local_reversible_edit` / `local_reversible_edit` and contracts in `CAPABILITY_CONTRACTS`.

- [ ] **Step 1: Write the failing test**

`apps/node-agent/src/health.test.ts`. A fake glycolens, a Node script, stands in for the venv's python:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import type { CapabilityGrant } from "@noctis/contracts";
import { HealthDecideEvidenceSchema, HealthRunEvidenceSchema } from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { AdapterContext } from "./adapters.js";
import { createHealthAdapters, runOutcome } from "./health.js";

/** glycolens's behaviour, by MODE: what each real exit looks like (pipeline.py, cli.py). */
const FAKE = `
import { appendFileSync, writeFileSync } from "node:fs";
const [cmd, id] = process.argv.slice(2);
const home = process.env.FAKE_HOME, mode = process.env.FAKE_MODE ?? "ok";
appendFileSync(home + "/log", cmd + ":start\\n");
const done = (code) => { appendFileSync(home + "/log", cmd + ":end\\n"); process.exit(code); };
if (cmd === "run") {
  if (mode === "hang") setInterval(() => {}, 1000);
  else setTimeout(() => {
    if (mode === "no_data") { process.stderr.write("glycolens: no data yet (nothing fetched)\\n"); done(1); }
    if (mode === "no_login") process.stderr.write("glycolens: fetch failed, using stored data: RuntimeError: no Tandem Source login saved: run \`glycolens login\` first\\n");
    if (mode === "stale") process.stderr.write("glycolens: fetch failed, using stored data: HTTPError: 503\\n");
    writeFileSync(home + "/report.json", JSON.stringify({ schema_version: 1, glucose: "Ä" }));
    done(0);
  }, Number(process.env.FAKE_DELAY ?? 0));
} else {
  if (id === "missing") { process.stdout.write("glycolens: no suggestion with id 'missing'\\n"); done(2); }
  process.stdout.write(mode === "already" ? "already applied\\n" : id + ": proposed → applied\\n");
  done(0);
}
`;

let scratch: string | undefined;
afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function setup(env: Record<string, string> = {}) {
  scratch = mkdtempSync(join(tmpdir(), "noctis-health-"));
  const script = join(scratch, "fake-glycolens.mjs");
  writeFileSync(script, FAKE);
  const grants: CapabilityGrant[] = (["health.report", "health.run", "health.decide"] as const).map((capability, i) => ({
    id: `0199a000-0000-7000-8000-00000000010${i}`,
    nodeId: "0199a000-0000-7000-8000-0000000000aa",
    capability,
    operationClass: capability === "health.report" ? "read_inspect" : "local_reversible_edit",
    constraintsVersion: 1,
    constraints: { repo: scratch!, home: scratch! },
    grantedAt: "2026-10-16T12:00:00.000Z",
  }));
  const sent: string[] = [];
  const context = (signal = new AbortController().signal): AdapterContext => ({
    grants, signal,
    progress: () => undefined, stream: () => undefined, delta: () => undefined,
    ask: () => Promise.reject(new Error("no ask")),
    env: { ...process.env, FAKE_HOME: scratch!, ...env },
    runtimes: {},
    fetchAttachment: () => Promise.reject(new Error("no attachment")),
    delegate: () => Promise.reject(new Error("no delegation")),
    uploadOutput: () => Promise.reject(new Error("no output")),
    async streamFile(file) { sent.push(await text(file.body)); },
    streamScreen: () => Promise.reject(new Error("no screen")),
  });
  const adapters = createHealthAdapters({
    command: () => ({ command: process.execPath, args: [script] }),
    runTimeoutMs: 1_000,
  });
  return { adapters, context, sent, home: scratch };
}

describe("health adapters", () => {
  it("runs glycolens, decodes UTF-8 and streams the report it wrote", async () => {
    const { adapters, context, sent } = setup();
    const evidence = HealthRunEvidenceSchema.parse(await adapters["health.run"]({}, context()));
    expect(evidence).toEqual({ outcome: "written", report: "sent" });
    expect(JSON.parse(sent[0]!)).toEqual({ schema_version: 1, glucose: "Ä" });
  });

  it("names a missing login and a stale fetch, and still sends the report", async () => {
    const login = setup({ FAKE_MODE: "no_login" });
    expect(HealthRunEvidenceSchema.parse(await login.adapters["health.run"]({}, login.context()))).toMatchObject({ outcome: "no_login", report: "sent" });
    const stale = setup({ FAKE_MODE: "stale" });
    expect(await stale.adapters["health.run"]({}, stale.context())).toMatchObject({ outcome: "stale", reason: expect.stringContaining("503") });
  });

  it("reports no data without a report", async () => {
    const { adapters, context } = setup({ FAKE_MODE: "no_data" });
    expect(await adapters["health.run"]({}, context())).toEqual({ outcome: "no_data", reason: "glycolens: no data yet (nothing fetched)", report: "missing" });
  });

  it("kills a run that outlives its timeout", async () => {
    const { adapters, context } = setup({ FAKE_MODE: "hang" });
    await expect(adapters["health.run"]({}, context())).rejects.toThrow(/timed out/);
  }, 15_000);

  it("maps decisions, including an unknown id on stdout with exit 2", async () => {
    const { adapters, context } = setup();
    expect(HealthDecideEvidenceSchema.parse(await adapters["health.decide"]({ id: "2026-W41-x", action: "mark-applied" }, context()))).toMatchObject({ result: "changed" });
    expect(await adapters["health.decide"]({ id: "missing", action: "dismiss" }, context())).toMatchObject({ result: "unknown_id" });
    const already = setup({ FAKE_MODE: "already" });
    expect(await already.adapters["health.decide"]({ id: "x", action: "mark-applied" }, already.context())).toMatchObject({ result: "already" });
  });

  it("never starts a decision while a run is going", async () => {
    const { adapters, context, home } = setup({ FAKE_DELAY: "300" });
    await Promise.all([
      adapters["health.run"]({}, context()),
      adapters["health.decide"]({ id: "x", action: "dismiss" }, context()),
    ]);
    expect(readFileSync(join(home!, "log"), "utf8").trim().split("\n")).toEqual(["run:start", "run:end", "dismiss:start", "dismiss:end"]);
  });

  it("refuses without a grant and refuses a payload naming an option", async () => {
    const { adapters, context } = setup();
    await expect(adapters["health.decide"]({ id: "--help", action: "dismiss" }, context())).rejects.toThrow();
    await expect(adapters["health.report"]({}, { ...context(), grants: [] })).rejects.toThrow(/no health.report grant/);
  });

  it("reads report.json whole for health.report", async () => {
    const { adapters, context, sent, home } = setup();
    expect(await adapters["health.report"]({}, context())).toEqual({ report: "missing" });
    writeFileSync(join(home!, "report.json"), "{}");
    expect(await adapters["health.report"]({}, context())).toEqual({ report: "sent" });
    expect(sent).toEqual(["{}"]);
  });
});

describe("runOutcome", () => {
  it("throws for an exit it does not recognise", () => {
    expect(() => runOutcome(1, "Traceback ...\nValueError: boom")).toThrow(/exited 1: ValueError: boom/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/node-agent/src/health.test.ts`
Expected: FAIL, `./health.js` does not exist.

- [ ] **Step 3: Register the capabilities in contracts**

In `packages/contracts/src/node.ts`:
- Import `HealthDecideEvidenceSchema, HealthDecidePayloadSchema, HealthReportEvidenceSchema, HealthReportPayloadSchema, HealthRunEvidenceSchema, HealthRunPayloadSchema` from `./health.js`.
- Append to `NODE_CAPABILITIES`:

```ts
  /** glycolens on the home PC: read report.json, run the weekly analysis, record a decision. */
  "health.report",
  "health.run",
  "health.decide",
```

- Append to `CAPABILITY_OPERATION_CLASS`:

```ts
  "health.report": "read_inspect",
  /** Writes glycolens's own store and report on the PC; reruns replace it. */
  "health.run": "local_reversible_edit",
  /** A suggestion's status; `reset` undoes it. */
  "health.decide": "local_reversible_edit",
```

- Append to `CAPABILITY_CONTRACTS`:

```ts
  "health.report": { payload: HealthReportPayloadSchema, evidence: HealthReportEvidenceSchema },
  "health.run": { payload: HealthRunPayloadSchema, evidence: HealthRunEvidenceSchema },
  "health.decide": { payload: HealthDecidePayloadSchema, evidence: HealthDecideEvidenceSchema },
```

- [ ] **Step 4: Write the adapters**

`apps/node-agent/src/health.ts`:

```ts
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { CapabilityGrant } from "@noctis/contracts";
import {
  HealthDecidePayloadSchema,
  HealthGrantConstraintsSchema,
  HealthReportPayloadSchema,
  HealthRunPayloadSchema,
  MAX_HEALTH_REPORT_BYTES,
} from "@noctis/contracts";

import type { Adapter, AdapterContext } from "./adapters.js";
import { AdapterRefused } from "./runtimes/Runtime.js";
import { childEnvironment } from "./runtimes/env.js";
import { killProcessTree } from "./runtimes/kill-tree.js";

/**
 * glycolens on this PC (Plan 2). Noctis never imports glycolens: it runs the
 * CLI with the venv's python (Smart App Control can block glycolens.exe) and
 * reads the report it writes. Every job sends report.json afterwards, because
 * that is the only way the core learns what a run or a decision changed.
 */

type HealthCapability = "health.report" | "health.run" | "health.decide";

export interface HealthOptions {
  /** How glycolens starts. Tests swap in a fake. */
  command?: (repo: string) => { command: string; args: string[] };
  runTimeoutMs?: number;
}

const HEARTBEAT_MS = 10_000;
const DECIDE_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 15 * 60_000;

const venvPython = (repo: string) => ({
  command: join(repo, ".venv", "Scripts", "python.exe"),
  args: ["-m", "glycolens.cli"],
});

function folders(grants: readonly CapabilityGrant[], capability: HealthCapability) {
  const grant = grants.find((g) => g.capability === capability && g.revokedAt === undefined);
  if (grant === undefined) throw new AdapterRefused(`no ${capability} grant`);
  const parsed = HealthGrantConstraintsSchema.safeParse(grant.constraints);
  if (!parsed.success) throw new AdapterRefused(`the ${capability} grant names no glycolens folder`);
  return parsed.data;
}

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
}

function exec(
  start: { command: string; args: string[] },
  cwd: string,
  context: AdapterContext,
  timeoutMs: number,
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(start.command, start.args, {
      cwd,
      env: childEnvironment(context.env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const stop = (): void => void killProcessTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    // The core renews the lease on every frame; a run takes minutes.
    const heartbeat = setInterval(() => context.progress(0, "glycolens running"), HEARTBEAT_MS);
    context.signal.addEventListener("abort", stop, { once: true });
    const done = (): void => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      context.signal.removeEventListener("abort", stop);
    };
    child.once("error", (error) => {
      done();
      reject(new AdapterRefused(`could not start glycolens: ${error.message}`));
    });
    child.once("close", (code) => {
      done();
      if (timedOut) reject(new AdapterRefused(`glycolens timed out after ${Math.round(timeoutMs / 1000)} s`));
      else if (context.signal.aborted) reject(new AdapterRefused("job was cancelled"));
      else resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

const lastLine = (text: string): string | undefined =>
  text.trim().split(/\r?\n/).at(-1)?.slice(0, 300) || undefined;

/** glycolens's exits (pipeline.run): 0 written, maybe from stored data; 1 no data at all. */
export function runOutcome(code: number | null, stderr: string): { outcome: "written" | "stale" | "no_data" | "no_login"; reason?: string } {
  const reason = lastLine(stderr);
  const login = stderr.includes("no Tandem Source login saved");
  if (code === 0) {
    if (login) return { outcome: "no_login", ...(reason === undefined ? {} : { reason }) };
    return reason === undefined ? { outcome: "written" } : { outcome: "stale", reason };
  }
  if (code === 1 && stderr.includes("glycolens: no data yet")) {
    return { outcome: login ? "no_login" : "no_data", ...(reason === undefined ? {} : { reason }) };
  }
  throw new AdapterRefused(`glycolens exited ${String(code)}: ${reason ?? "no output"}`);
}

/** report.json read whole and closed at once: os.replace on Windows fails while a reader holds it. */
async function sendReport(home: string | undefined, context: AdapterContext): Promise<"sent" | "missing" | "too_large"> {
  const path = join(home ?? join(homedir(), ".glycolens"), "report.json");
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (bytes.length > MAX_HEALTH_REPORT_BYTES) return "too_large";
  await context.streamFile({ sizeBytes: bytes.length, offset: 0, length: bytes.length, body: Readable.from([bytes]) });
  return "sent";
}

export function createHealthAdapters(options: HealthOptions = {}): Record<HealthCapability, Adapter> {
  const start = options.command ?? venvPython;
  // One glycolens at a time on this PC: a decision rewrites report.json, and so does a run.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
  const cli = (repo: string, args: string[]) => {
    const base = start(repo);
    return { command: base.command, args: [...base.args, ...args] };
  };

  return {
    "health.report": (payload, context) => {
      HealthReportPayloadSchema.parse(payload);
      const { home } = folders(context.grants, "health.report");
      return serial(async () => ({ report: await sendReport(home, context) }));
    },
    "health.run": (payload, context) => {
      HealthRunPayloadSchema.parse(payload);
      const { repo, home } = folders(context.grants, "health.run");
      return serial(async () => {
        const exit = await exec(cli(repo, ["run"]), repo, context, options.runTimeoutMs ?? RUN_TIMEOUT_MS);
        const outcome = runOutcome(exit.code, exit.stderr);
        return { ...outcome, report: await sendReport(home, context) };
      });
    },
    "health.decide": (payload, context) => {
      const request = HealthDecidePayloadSchema.parse(payload);
      const { repo, home } = folders(context.grants, "health.decide");
      return serial(async () => {
        const exit = await exec(cli(repo, [request.action, request.id]), repo, context, DECIDE_TIMEOUT_MS);
        const result =
          exit.code === 2 ? "unknown_id" : exit.code === 0 ? (exit.stdout.startsWith("already") ? "already" : "changed") : undefined;
        if (result === undefined) throw new AdapterRefused(`glycolens exited ${String(exit.code)}: ${lastLine(exit.stderr) ?? "no output"}`);
        return { result, report: await sendReport(home, context) };
      });
    },
  };
}
```

In `apps/node-agent/src/adapters.ts`, import `createHealthAdapters` from `./health.js` and spread it into `ADAPTERS`:

```ts
  "screen.view": createScreenView(),
  ...createHealthAdapters(),
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/node-agent/src/health.test.ts packages/contracts`
Expected: PASS. The fake writes `log` lines in order, which proves the lock.

Run: `npm run typecheck`
Expected: exit 0. If a core `switch` over `NodeCapability` is now non-exhaustive, the error names the file. Add the three names there with the same handling as other non-turn capabilities.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/node.ts apps/node-agent/src/health.ts apps/node-agent/src/health.test.ts apps/node-agent/src/adapters.ts
git commit -m "feat(node): health.report, health.run and health.decide run glycolens on the home PC"
git push origin main
```

---

### Task 3: Core stores the streamed report

**Files:**
- Create: `apps/core/migrations/0021_health.sql`, `apps/core/src/health/store.ts`
- Modify: `apps/core/src/nodes/registry.ts:830-845` (grant constraints)
- Test: `apps/core/src/health/store.test.ts`

**Interfaces:**
- Consumes: `HealthReportSchema`, `HealthGrantConstraintsSchema`, `HEALTH_CAPABILITIES`, `MAX_HEALTH_REPORT_BYTES`.
- Produces:
  - `parseHealthReport(text: string): { state: "ok"; report: HealthReport } | { state: "unreadable"; reason: string }`
  - `storeHealthReport(db, row: StoredHealthReport): void`
  - `readHealthReport(db): StoredHealthReport | undefined`
  - `proposedIds(report: HealthReport): string[]`
  - `suggestionIds(report: HealthReport): Set<string>`
  - `type StoredHealthReport = { state: "ok" | "unreadable" | "missing"; body?: string; reason?: string; jobId: string; receivedAt: string }`

- [ ] **Step 1: Write the failing test**

`apps/core/src/health/store.test.ts`:

```ts
import { healthReportFixture } from "@noctis/contracts";
import { expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { parseHealthReport, proposedIds, readHealthReport, storeHealthReport } from "./store.js";

function db() {
  const database = openDatabase(":memory:");
  migrate(database, { directory: "apps/core/migrations", clock: { now: () => 0 } });
  return database;
}

it("parses a good report and names why a bad one is unreadable, without its values", () => {
  const good = parseHealthReport(JSON.stringify(healthReportFixture()));
  expect(good.state).toBe("ok");
  if (good.state === "ok") expect(proposedIds(good.report)).toEqual(["2026-W41-breakfast-carb_ratio"]);
  expect(parseHealthReport("{nope")).toEqual({ state: "unreadable", reason: "report.json is not JSON" });
  const bad = parseHealthReport(JSON.stringify({ ...healthReportFixture(), stats: { coverage: "12.3 mmol" } }));
  expect(bad.state).toBe("unreadable");
  if (bad.state === "unreadable") expect(bad.reason).not.toContain("12.3");
});

it("keeps one latest report, of any size", () => {
  const database = db();
  const big = JSON.stringify({ ...healthReportFixture(), padding: "x".repeat(1_000_000) });
  storeHealthReport(database, { state: "ok", body: "{}", jobId: "a", receivedAt: "2026-10-16T10:00:00.000Z" });
  storeHealthReport(database, { state: "ok", body: big, jobId: "b", receivedAt: "2026-10-16T11:00:00.000Z" });
  expect(readHealthReport(database)).toMatchObject({ state: "ok", jobId: "b" });
  expect(readHealthReport(database)?.body?.length).toBe(big.length);
});
```

Check the `migrate` options against `apps/core/src/nodes/owner-presence.test.ts:26` and copy its exact call.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/core/src/health/store.test.ts`
Expected: FAIL, `./store.js` not found.

- [ ] **Step 3: Write the migration and store**

`apps/core/migrations/0021_health.sql`:

```sql
-- apps/core/migrations/0021_health.sql
-- The latest glycolens report.json the home PC sent (one row), and which job
-- served each weekly Sunday occurrence, so a missed week runs exactly once.
CREATE TABLE health_report (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  state       TEXT NOT NULL CHECK (state IN ('ok', 'unreadable', 'missing')),
  body        TEXT,
  reason      TEXT,
  job_id      TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE health_runs (
  occurrence TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

`apps/core/src/health/store.ts`:

```ts
import type { HealthReport } from "@noctis/contracts";
import { HealthReportSchema } from "@noctis/contracts";

import type { NoctisDatabase } from "../db/connection.js";

/**
 * The latest glycolens report, as the home PC last sent it. The owner chose
 * to keep it on the core; it still never goes into a log line or an event.
 */
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
  // Where and what kind, never the value: a value here is a reading.
  const issue = parsed.error.issues[0];
  return { state: "unreadable", reason: `${issue?.path.join(".") || "report"}: ${issue?.code ?? "invalid"}` };
}

export function storeHealthReport(db: NoctisDatabase, row: StoredHealthReport): void {
  db.prepare(
    `INSERT INTO health_report (id, state, body, reason, job_id, received_at) VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET state = excluded.state, body = excluded.body, reason = excluded.reason,
       job_id = excluded.job_id, received_at = excluded.received_at`,
  ).run(row.state, row.body ?? null, row.reason ?? null, row.jobId, row.receivedAt);
}

export function readHealthReport(db: NoctisDatabase): StoredHealthReport | undefined {
  const row = db.prepare("SELECT state, body, reason, job_id, received_at FROM health_report WHERE id = 1").get() as
    | { state: StoredHealthReport["state"]; body: string | null; reason: string | null; job_id: string; received_at: string }
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

export const suggestionIds = (report: HealthReport): Set<string> => new Set(report.suggestions.map((s) => s.id));
```

In `apps/core/src/nodes/registry.ts` `grantCapability`, extend the constraints ternary:

```ts
  const constraints =
    command.capability === "file.search"
      ? FileSearchConstraintsSchema.parse(command.constraints)
      : command.capability === "runtime.turn"
        ? RuntimeGrantConstraintsSchema.parse(command.constraints)
        : (HEALTH_CAPABILITIES as readonly string[]).includes(command.capability)
          ? HealthGrantConstraintsSchema.parse(command.constraints)
          : (command.constraints ?? {});
```

Add to `registry.test` or the existing grant test file (`apps/core/src/nodes/nodes.integration.test.ts` has grant tests; add next to them) one assertion: a `health.run` grant with `constraints: { repo: "relative" }` is refused, and one with `{ repo: "C:\\glycolens" }` is stored with operation class `local_reversible_edit`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/core/src/health/store.test.ts apps/core/src/db apps/core/src/nodes/nodes.integration.test.ts`
Expected: PASS, including the migration tests.

- [ ] **Step 5: Commit**

```bash
git add apps/core/migrations/0021_health.sql apps/core/src/health apps/core/src/nodes
git commit -m "feat(core): store the latest glycolens report the home PC sends"
git push origin main
```

---

### Task 4: Core health service: stream, status, commands, weekly run, push

**Files:**
- Create: `apps/core/src/health/service.ts`
- Modify: `apps/core/src/productivity/triggers.ts` (export the Sunday helper), `apps/core/src/server.ts`, `apps/core/src/api/http.ts`
- Test: `apps/core/src/health/service.test.ts`

**Interfaces:**
- Consumes: Task 3 store functions; `enqueueJobInTransaction`, `getJob` (`apps/core/src/nodes/jobs.ts`); `runCommand` (`apps/core/src/kernel.ts`); `grantCapability` (`apps/core/src/nodes/registry.ts:830`); `grantStandingPermission`, `revokeStandingPermission` (`apps/core/src/authority/service.ts:703,795`); `Notifier.send` (`apps/core/src/notify/push.ts:122`); `readSetting` (`apps/core/src/config/settings.ts:147`).
- Produces:
  - `lastWeeklyAt(rule: { daysOfWeek: number[]; timeOfDay: string; timeZone: string }, now: number): number | undefined` in `triggers.ts`
  - `createHealthService(deps: HealthServiceDeps): HealthService`, where:

```ts
export interface HealthServiceDeps {
  kernel: Kernel;
  dispatcher: Pick<Dispatcher, "isConnected" | "pass" | "sendGrants">;
  notifier: Pick<Notifier, "send">;
  /** The "Weekly health run (Sundays)" setting: "HH:MM" or "" for off. */
  weeklyAt: () => string;
  timeZone: string;
}
export interface HealthService {
  accept(nodeId: string, jobId: string, body: AsyncIterable<Buffer>): Promise<boolean>;
  status(): HealthStatus;
  allow(context: CommandContext, command: AllowHealthCommand): Result<{ id: string }>;
  disallow(context: CommandContext, command: DisallowHealthCommand): Result<{ id: string }>;
  refresh(context: CommandContext, command: HealthCommand): Result<NodeJobRecord>;
  runNow(context: CommandContext, command: HealthCommand): Result<NodeJobRecord>;
  decide(context: CommandContext, command: HealthDecideCommand): Result<NodeJobRecord>;
  pass(): void;
  close(): void;
}
```

  - HTTP: `GET /glucose` returns `HealthStatus`. Commands are `POST /commands/health.allow`, `health.disallow`, `health.refresh`, `health.run_now` and `health.decide`; each is followed post-commit by `dispatcher.pass()`, and allow/disallow also by `sendGrants(nodeId)`.
  - `RunningCore.health: HealthService`.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/health/service.test.ts`. Build a minimal kernel the way `apps/core/src/nodes/owner-presence.test.ts:9-30` does, but with a mutable clock. Seed one `online` node row. Use a fake dispatcher `{ isConnected: () => online, pass: () => undefined, sendGrants: () => undefined }` and a fake notifier collecting `send` calls.

```ts
import { healthReportFixture, HealthStatusSchema } from "@noctis/contracts";
import { createIdFactory } from "@noctis/domain";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import { createLogger } from "../logging.js";
import { completeJob, getJob, startJob } from "../nodes/jobs.js";
import { createHealthService } from "./service.js";

const NODE = "0199a000-0000-7000-8000-0000000000e1";
const owner = { correlationId: "c", actorType: "user" as const, actorId: "local" };

function harness(start = "2026-10-18T19:00:00.000Z") {
  let now = Date.parse(start);
  const clock = { now: () => now };
  const db = openDatabase(":memory:");
  migrate(db, { directory: "apps/core/migrations", clock });
  const kernel = { db, clock, ids: createIdFactory(clock), broker: createEventBroker(), logger: createLogger({ sink: () => undefined }) };
  const at = new Date(now).toISOString();
  db.prepare("INSERT INTO nodes (id,host_id,status,fingerprint,agent_version,created_at,updated_at) VALUES (?,?,'online','fp','test',?,?)").run(NODE, "home", at, at);
  const sent: { title: string; body: string }[] = [];
  let online = true;
  let weeklyAt = "20:00";
  const health = createHealthService({
    kernel,
    dispatcher: { isConnected: () => online, pass: () => undefined, sendGrants: () => undefined },
    notifier: { send: async (message) => { sent.push(message); } },
    weeklyAt: () => weeklyAt,
    timeZone: "Europe/London",
  });
  const allowed = health.allow(owner, { idempotencyKey: "allow", nodeId: NODE, repo: "C:\\glycolens" });
  expect(allowed.ok).toBe(true);
  return {
    health, db, kernel, sent,
    advance: (ms: number) => { now += ms; },
    setOnline: (value: boolean) => { online = value; },
    setWeekly: (value: string) => { weeklyAt = value; },
    jobs: (capability: string) => db.prepare("SELECT id, status FROM node_jobs WHERE capability = ? ORDER BY created_at").all(capability) as { id: string; status: string }[],
    finish: (jobId: string, outcome: "succeeded" | "failed", evidence?: unknown) => {
      startJob(kernel, { correlationId: "n", actorType: "node", actorId: NODE }, { jobId, nodeId: NODE, attempts: 1 });
      completeJob(kernel, { correlationId: "n", actorType: "node", actorId: NODE }, { jobId, nodeId: NODE, outcome, ...(evidence === undefined ? {} : { evidence }), ...(outcome === "failed" ? { failureReason: "boom" } : {}) });
    },
  };
}
```

Before relying on `startJob` / `completeJob`, read their exact input shapes in `apps/core/src/nodes/jobs.ts` (`startJob` near line 267, `completeJob` near 340) and adjust the two calls. The node must have leased the job first; follow `apps/core/src/nodes/nodes.integration.test.ts` for the lease call it uses.

Tests in the same file:

```ts
describe("weekly run", () => {
  it("queues nothing before Sunday 20:00 and one job after it", () => {
    const h = harness("2026-10-18T18:59:00.000Z"); // 19:59 BST
    h.health.pass();
    expect(h.jobs("health.run")).toEqual([]);
    h.advance(120_000);
    h.health.pass();
    h.health.pass();
    expect(h.jobs("health.run")).toHaveLength(1);
  });

  it("catches up once after three missed Sundays, and not again once it finished", () => {
    const h = harness("2026-11-04T09:00:00.000Z"); // Wednesday, three Sundays later
    h.health.pass();
    const [job] = h.jobs("health.run");
    expect(job).toBeDefined();
    h.finish(job!.id, "succeeded", { outcome: "no_login", report: "missing" });
    h.advance(60_000);
    h.health.pass();
    expect(h.jobs("health.run")).toHaveLength(1);
  });

  it("waits while the PC is off and retries a job that expired", () => {
    const h = harness();
    h.setOnline(false);
    h.advance(3_600_000);
    h.health.pass();
    expect(h.jobs("health.run")).toEqual([]);
    h.setOnline(true);
    h.health.pass();
    const [job] = h.jobs("health.run");
    h.db.prepare("UPDATE node_jobs SET status = 'expired' WHERE id = ?").run(job!.id);
    h.health.pass();
    expect(h.jobs("health.run")).toHaveLength(2);
  });

  it("does nothing when the setting is empty", () => {
    const h = harness();
    h.setWeekly("");
    h.advance(3_600_000);
    h.health.pass();
    expect(h.jobs("health.run")).toEqual([]);
  });
});

describe("owner commands", () => {
  it("refuses a decision while a run is queued, and lets one through after", () => {
    const h = harness("2026-10-16T12:00:00.000Z");
    const run = h.health.runNow(owner, { idempotencyKey: "r" });
    expect(run.ok).toBe(true);
    const early = h.health.decide(owner, { idempotencyKey: "d1", id: "2026-W41-breakfast-carb_ratio", action: "mark-applied" });
    expect(early.ok ? "ok" : early.conflict).toMatchObject({ kind: "unavailable", reason: "run_in_progress" });
    if (run.ok) h.finish(run.value.job.id, "succeeded", { outcome: "written", report: "sent" });
    expect(h.health.decide(owner, { idempotencyKey: "d2", id: "2026-W41-breakfast-carb_ratio", action: "mark-applied" }).ok).toBe(true);
  });

  it("refuses everything once disallowed", () => {
    const h = harness("2026-10-16T12:00:00.000Z");
    expect(h.health.disallow(owner, { idempotencyKey: "x", nodeId: NODE }).ok).toBe(true);
    expect(h.health.runNow(owner, { idempotencyKey: "r" }).ok).toBe(false);
    expect(h.health.status().granted).toBe(false);
  });
});

describe("stream and status", () => {
  it("stores a streamed report, counts proposals and pushes only new ones after a run", async () => {
    const h = harness("2026-10-16T12:00:00.000Z");
    const run = h.health.runNow(owner, { idempotencyKey: "r" });
    if (!run.ok) throw new Error("run refused");
    startJobFor(h, run.value.job.id);
    const body = Buffer.from(JSON.stringify(healthReportFixture()));
    expect(await h.health.accept(NODE, run.value.job.id, [body])).toBe(true);
    expect(h.sent).toEqual([{ title: "Health", body: "1 new health suggestion", url: "/", tag: "health" }]);
    const status = HealthStatusSchema.parse(h.health.status());
    expect(status).toMatchObject({ granted: true, nodeOnline: true, proposed: 1, report: { state: "ok" } });

    const again = h.health.runNow(owner, { idempotencyKey: "r2" });
    if (!again.ok) throw new Error("second run refused");
    h.finish(run.value.job.id, "succeeded", { outcome: "written", report: "sent" });
    startJobFor(h, again.value.job.id);
    await h.health.accept(NODE, again.value.job.id, [body]);
    expect(h.sent).toHaveLength(1);
  });

  it("refuses a stream from another node or for a non-health job, and over 4 MB", async () => {
    const h = harness("2026-10-16T12:00:00.000Z");
    const run = h.health.runNow(owner, { idempotencyKey: "r" });
    if (!run.ok) throw new Error("run refused");
    startJobFor(h, run.value.job.id);
    expect(await h.health.accept("0199a000-0000-7000-8000-0000000000ff", run.value.job.id, [Buffer.from("{}")])).toBe(false);
    expect(await h.health.accept(NODE, run.value.job.id, [Buffer.alloc(4 * 1024 * 1024 + 1)])).toBe(false);
  });

  it("marks a report unreadable or missing, never throwing", async () => {
    const h = harness("2026-10-16T12:00:00.000Z");
    const run = h.health.refresh(owner, { idempotencyKey: "f" });
    if (!run.ok) throw new Error("refresh refused");
    startJobFor(h, run.value.job.id);
    await h.health.accept(NODE, run.value.job.id, [Buffer.from("{nope")]);
    expect(h.health.status().report).toMatchObject({ state: "unreadable", reason: "report.json is not JSON" });
    h.finish(run.value.job.id, "succeeded", { report: "sent" });
    const second = h.health.refresh(owner, { idempotencyKey: "f2" });
    if (second.ok) h.finish(second.value.job.id, "succeeded", { report: "missing" });
    expect(h.health.status().report).toMatchObject({ state: "missing" });
  });
});
```

`startJobFor(h, jobId)` is a local helper that leases and starts the job without completing it, the first half of `finish`. Write it next to `harness` and use it inside `finish`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/core/src/health/service.test.ts`
Expected: FAIL, `./service.js` not found.

- [ ] **Step 3: Export the Sunday helper**

In `apps/core/src/productivity/triggers.ts`, below `weeklyAt`:

```ts
/** The latest occurrence of a weekly rule at or before `now`, as epoch ms. */
export function lastWeeklyAt(
  rule: { daysOfWeek: number[]; timeOfDay: string; timeZone: string },
  now: number,
): number | undefined {
  return weeklyAt({ kind: "weekly", ...rule }, now, false);
}
```

Add a test to `apps/core/src/productivity/triggers.test.ts`. `lastWeeklyAt({ daysOfWeek: [0], timeOfDay: "20:00", timeZone: "Europe/London" }, Date.parse("2026-11-04T09:00:00Z"))` equals `Date.parse("2026-11-01T20:00:00Z")` (GMT after the clocks change).

- [ ] **Step 4: Write the service**

`apps/core/src/health/service.ts`:

```ts
import type {
  AllowHealthCommand,
  DisallowHealthCommand,
  HealthCommand,
  HealthDecideCommand,
  HealthStatus,
  NodeCapability,
} from "@noctis/contracts";
import { HEALTH_CAPABILITIES, HealthRunEvidenceSchema, MAX_HEALTH_REPORT_BYTES } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";

import { grantStandingPermission, revokeStandingPermission } from "../authority/service.js";
import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";
import type { Dispatcher } from "../nodes/dispatch.js";
import type { NodeJobRecord } from "../nodes/jobs.js";
import { enqueueJobInTransaction, getJob } from "../nodes/jobs.js";
import { grantCapability } from "../nodes/registry.js";
import type { Notifier } from "../notify/push.js";
import { lastWeeklyAt } from "../productivity/triggers.js";
import { parseHealthReport, proposedIds, readHealthReport, storeHealthReport, suggestionIds } from "./store.js";

/**
 * glycolens through the home PC (Plan 2). The core decides when a run is due
 * and keeps the latest report; the node runs the CLI. Nothing here logs a
 * report's contents.
 */

const SYSTEM: CommandContext = { correlationId: "health-weekly", actorType: "system", actorId: "health" };
/** Who may run what without a second confirmation once the owner allows health. */
const PERMISSIONS = [
  { actorId: "local", capability: "health.run" },
  { actorId: "local", capability: "health.decide" },
  { actorId: "health", capability: "health.run" },
] as const;
const IN_FLIGHT = "('queued', 'leased', 'running')";

const healthNode = (db: NoctisDatabase, now: number): string | undefined =>
  (
    db
      .prepare(
        `SELECT node_id FROM node_capabilities WHERE capability = 'health.run' AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?) ORDER BY granted_at DESC LIMIT 1`,
      )
      .get(new Date(now).toISOString()) as { node_id: string } | undefined
  )?.node_id;

function inFlight(db: NoctisDatabase): "run" | "decide" | "report" | null {
  const row = db
    .prepare(`SELECT capability FROM node_jobs WHERE capability LIKE 'health.%' AND status IN ${IN_FLIGHT} ORDER BY capability = 'health.run' DESC LIMIT 1`)
    .get() as { capability: string } | undefined;
  return row === undefined ? null : (row.capability.slice("health.".length) as "run" | "decide" | "report");
}

export interface HealthServiceDeps {
  kernel: Kernel;
  dispatcher: Pick<Dispatcher, "isConnected" | "pass" | "sendGrants">;
  notifier: Pick<Notifier, "send">;
  /** The "Weekly health run (Sundays)" setting: "HH:MM" or "" for off. */
  weeklyAt: () => string;
  timeZone: string;
}

export interface HealthService {
  accept(nodeId: string, jobId: string, body: AsyncIterable<Buffer>): Promise<boolean>;
  status(): HealthStatus;
  allow(context: CommandContext, command: AllowHealthCommand): Result<{ id: string }>;
  disallow(context: CommandContext, command: DisallowHealthCommand): Result<{ id: string }>;
  refresh(context: CommandContext, command: HealthCommand): Result<NodeJobRecord>;
  runNow(context: CommandContext, command: HealthCommand): Result<NodeJobRecord>;
  decide(context: CommandContext, command: HealthDecideCommand): Result<NodeJobRecord>;
  pass(): void;
  close(): void;
}

export function createHealthService(deps: HealthServiceDeps): HealthService {
  const { kernel } = deps;
  const iso = (): string => new Date(kernel.clock.now()).toISOString();
  let refusedFor: string | undefined;

  function enqueue(
    context: CommandContext,
    key: string,
    capability: NodeCapability,
    payload: Record<string, unknown>,
    after?: (tx: NoctisDatabase, jobId: string) => void,
  ): Result<NodeJobRecord> {
    const nodeId = healthNode(kernel.db, kernel.clock.now());
    if (nodeId === undefined) return conflict({ kind: "unavailable", entity: "health", reason: "not_allowed" });
    if (!deps.dispatcher.isConnected(nodeId)) return conflict({ kind: "unavailable", entity: "health", reason: "pc_offline" });
    const id = kernel.ids.nextId();
    return runCommand<NodeJobRecord>(kernel, { scope: capability, key, resultId: id }, (tx) => {
      const busy = inFlight(tx);
      if (busy === "run") return conflict({ kind: "unavailable", entity: "health", reason: "run_in_progress" });
      if (capability === "health.run" && busy !== null) return conflict({ kind: "unavailable", entity: "health", reason: "busy" });
      const queued = enqueueJobInTransaction(tx, kernel, context, {
        id, capability, payload, idempotencyKey: `health:${id}`, pinnedNodeId: nodeId,
      });
      if (queued.ok) after?.(tx, id);
      return queued;
    });
  }

  function store(jobId: string, row: { state: "ok" | "unreadable" | "missing"; body?: string; reason?: string }): void {
    storeHealthReport(kernel.db, { ...row, jobId, receivedAt: iso() });
  }

  // A report that never streamed: the node said why in its evidence.
  const unsubscribe = kernel.broker.subscribe((events) => {
    for (const event of events) {
      if (event.type !== "node.job_result.v1") continue;
      const payload = event.payload as { outcome?: string; capability?: string; evidence?: { report?: string } };
      if (payload.outcome !== "succeeded" || !payload.capability?.startsWith("health.")) continue;
      if (payload.evidence?.report === "missing") store(event.streamId, { state: "missing" });
      if (payload.evidence?.report === "too_large") store(event.streamId, { state: "unreadable", reason: "report.json is larger than 4 MB" });
    }
  });

  return {
    async accept(nodeId, jobId, body) {
      const record = getJob(kernel.db, jobId);
      if (
        record?.job.nodeId !== nodeId ||
        !(HEALTH_CAPABILITIES as readonly string[]).includes(record.job.capability) ||
        !["leased", "running"].includes(record.job.status)
      ) return false;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > MAX_HEALTH_REPORT_BYTES) return false;
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const parsed = parseHealthReport(text);
      const before = readHealthReport(kernel.db);
      store(jobId, parsed.state === "ok" ? { state: "ok", body: text } : parsed);
      if (record.job.capability === "health.run" && parsed.state === "ok") {
        const previous = before?.state === "ok" && before.body !== undefined ? parseHealthReport(before.body) : undefined;
        const known = previous?.state === "ok" ? suggestionIds(previous.report) : new Set<string>();
        const fresh = proposedIds(parsed.report).filter((id) => !known.has(id)).length;
        if (fresh > 0) {
          void deps.notifier
            .send({ title: "Health", body: `${fresh} new health suggestion${fresh === 1 ? "" : "s"}`, url: "/", tag: "health" })
            .catch(() => undefined);
        }
      }
      return true;
    },

    status() {
      const now = kernel.clock.now();
      const nodeId = healthNode(kernel.db, now) ?? null;
      const stored = readHealthReport(kernel.db);
      const parsed = stored?.state === "ok" && stored.body !== undefined ? parseHealthReport(stored.body) : undefined;
      const run = kernel.db
        .prepare(`SELECT status, result_json, failure_reason, updated_at FROM node_jobs
                   WHERE capability = 'health.run' AND status IN ('succeeded', 'failed') ORDER BY updated_at DESC LIMIT 1`)
        .get() as { status: string; result_json: string | null; failure_reason: string | null; updated_at: string } | undefined;
      const evidence = run?.result_json ? HealthRunEvidenceSchema.safeParse(JSON.parse(run.result_json)).data : undefined;
      return {
        granted: nodeId !== null,
        nodeId,
        nodeOnline: nodeId !== null && deps.dispatcher.isConnected(nodeId),
        busy: inFlight(kernel.db),
        lastRun:
          run === undefined
            ? null
            : run.status === "failed" || evidence === undefined
              ? { at: run.updated_at, outcome: "failed", ...(run.failure_reason ? { reason: run.failure_reason.slice(0, 300) } : {}) }
              : { at: run.updated_at, outcome: evidence.outcome, ...(evidence.reason ? { reason: evidence.reason } : {}) },
        weeklyAt: deps.weeklyAt(),
        report:
          stored === undefined
            ? { state: "none" }
            : stored.state === "missing"
              ? { state: "missing", receivedAt: stored.receivedAt }
              : parsed?.state === "ok"
                ? { state: "ok", receivedAt: stored.receivedAt, report: parsed.report }
                : { state: "unreadable", receivedAt: stored.receivedAt, reason: stored.reason ?? (parsed?.state === "unreadable" ? parsed.reason : "unreadable") },
        proposed: parsed?.state === "ok" ? proposedIds(parsed.report).length : 0,
      };
    },

    allow(context, command) {
      // Each step replays under its own derived key, so a retry after a partial failure finishes the set.
      for (const capability of HEALTH_CAPABILITIES) {
        const granted = grantCapability(kernel, context, {
          idempotencyKey: `${command.idempotencyKey}:${capability}`,
          nodeId: command.nodeId,
          capability,
          constraints: { repo: command.repo, ...(command.home === undefined ? {} : { home: command.home }) },
        });
        if (!granted.ok) return granted;
      }
      for (const permission of PERMISSIONS) {
        const active = kernel.db
          .prepare("SELECT id FROM standing_permissions WHERE actor_id = ? AND capability = ? AND revoked_at IS NULL")
          .get(permission.actorId, permission.capability);
        if (active !== undefined) continue;
        const granted = grantStandingPermission(kernel, context, {
          idempotencyKey: `${command.idempotencyKey}:${permission.actorId}:${permission.capability}`,
          ...permission,
          operationClass: "local_reversible_edit",
          constraints: { targetType: "capability", targetIds: [permission.capability] },
        });
        if (!granted.ok) return granted;
      }
      return ok({ id: command.nodeId });
    },

    disallow(context, command) {
      const permissions = kernel.db
        .prepare("SELECT id FROM standing_permissions WHERE capability LIKE 'health.%' AND revoked_at IS NULL")
        .all() as { id: string }[];
      for (const { id } of permissions) {
        const revoked = revokeStandingPermission(kernel, context, {
          idempotencyKey: `${command.idempotencyKey}:${id}`, permissionId: id, reason: "health disallowed",
        });
        if (!revoked.ok) return revoked;
      }
      return runCommand(kernel, { scope: "health.disallow", key: command.idempotencyKey, resultId: command.nodeId }, (tx) => {
        tx.prepare("UPDATE node_capabilities SET revoked_at = ? WHERE node_id = ? AND capability LIKE 'health.%' AND revoked_at IS NULL")
          .run(iso(), command.nodeId);
        return ok({ value: { id: command.nodeId }, events: [] });
      });
    },

    refresh: (context, command) => enqueue(context, command.idempotencyKey, "health.report", {}),
    runNow: (context, command) => enqueue(context, command.idempotencyKey, "health.run", {}),
    decide: (context, command) =>
      enqueue(context, command.idempotencyKey, "health.decide", { id: command.id, action: command.action }),

    pass() {
      const at = deps.weeklyAt();
      if (at === "") return;
      const due = lastWeeklyAt({ daysOfWeek: [0], timeOfDay: at, timeZone: deps.timeZone }, kernel.clock.now());
      if (due === undefined) return;
      const occurrence = new Date(due).toISOString();
      const served = kernel.db.prepare("SELECT job_id FROM health_runs WHERE occurrence = ?").get(occurrence) as { job_id: string } | undefined;
      const status = served === undefined ? undefined : getJob(kernel.db, served.job_id)?.job.status;
      if (status !== undefined && status !== "expired" && status !== "cancelled") return;
      const nodeId = healthNode(kernel.db, kernel.clock.now());
      if (nodeId === undefined || !deps.dispatcher.isConnected(nodeId) || inFlight(kernel.db) !== null) return;
      const queued = enqueue(SYSTEM, `weekly:${occurrence}:${kernel.ids.nextId()}`, "health.run", {}, (tx, jobId) => {
        tx.prepare(
          `INSERT INTO health_runs (occurrence, job_id, created_at) VALUES (?, ?, ?)
           ON CONFLICT (occurrence) DO UPDATE SET job_id = excluded.job_id`,
        ).run(occurrence, jobId, iso());
      });
      if (queued.ok) {
        deps.dispatcher.pass();
      } else if (refusedFor !== occurrence) {
        refusedFor = occurrence;
        kernel.logger.log("warn", "weekly health run refused", { conflict: queued.conflict.kind });
      }
    },

    close: unsubscribe,
  };
}
```

Checks before committing:
- Check `revokeStandingPermission`'s command fields against `RevokeStandingPermissionCommandSchema` (`permissionId`, `reason`).
- Check that `kernel.logger.log` exists on `Kernel`; if not, take a `logger` in deps as `server.ts` does for the promoter.
- If `runCommand`'s replay of `health.disallow` needs a stored result type, follow the pattern in `apps/core/src/nodes/registry.ts:913` (`unshareFolder`).

- [ ] **Step 5: Wire it**

`apps/core/src/server.ts`, next to the promoter timer:

```ts
  const health = createHealthService({
    kernel,
    dispatcher,
    notifier,
    weeklyAt: () => readSetting(db, env, "healthRunAt"),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
```

- Call `health.pass()` inside `sweepProductivity`'s `try`, after `productivity.pass()`.
- Add `health` to `deps` (`ApiDeps`) and to the returned `RunningCore`.
- Call `health.close()` in `close()`.

`apps/core/src/api/http.ts`:
1. `ApiDeps` gains `health: HealthService`.
2. In `handleNodeFile`, before the `sizeBytes` parsing, after the screen branch:

```ts
  // A glycolens report: buffered, checked and kept by the health service.
  const capability = UuidSchema.safeParse(jobId).success ? getJob(deps.kernel.db, jobId)?.job.capability : undefined;
  if (capability !== undefined && capability.startsWith("health.")) {
    finishNodeStream(res, await deps.health.accept(nodeId, jobId, req), req, correlationId);
    return;
  }
```

3. In the command table:

```ts
  "health.allow": defineDepsCommand(AllowHealthCommandSchema, (deps, context, command) => deps.health.allow(context, command), (_db, id) => ({ id })),
  "health.disallow": defineDepsCommand(DisallowHealthCommandSchema, (deps, context, command) => deps.health.disallow(context, command), (_db, id) => ({ id })),
  "health.refresh": defineDepsCommand(HealthCommandSchema, (deps, context, command) => deps.health.refresh(context, command), (db, id) => getJob(db, id)),
  "health.run_now": defineDepsCommand(HealthCommandSchema, (deps, context, command) => deps.health.runNow(context, command), (db, id) => getJob(db, id)),
  "health.decide": defineDepsCommand(HealthDecideCommandSchema, (deps, context, command) => deps.health.decide(context, command), (db, id) => getJob(db, id)),
```

4. In the post-commit block:

```ts
      } else if (name.startsWith("health.")) {
        if (name === "health.allow" || name === "health.disallow") {
          const changed = z.object({ nodeId: z.string() }).safeParse(body);
          if (changed.success) deps.dispatcher.sendGrants(changed.data.nodeId);
        }
        deps.dispatcher.pass();
      }
```

5. In `handleRead`, next to the `approvals` collection (around line 1152): `if (segments.length === 1 && segments[0] === "glucose") { send(res, 200, deps.health.status(), correlationId); return; }`. Match the surrounding branches' exact `send` / return style. Add `res.setHeader("cache-control", "no-store")` before sending.

Add one HTTP test to `apps/core/src/api/headless.integration.test.ts`, following its `startCore` + `fetch` pattern. `GET /glucose` with the bearer token answers 200 with `{ granted: false, report: { state: "none" } }`, and without a token answers 401.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/core/src/health apps/core/src/productivity/triggers.test.ts apps/core/src/api/headless.integration.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/core/src
git commit -m "feat(core): weekly glycolens run, health commands and GET /glucose"
git push origin main
```

---

### Task 5: Web view model and data hook

**Files:**
- Create: `apps/web/src/health/health-view.ts`, `apps/web/src/health/useHealth.ts`
- Test: `apps/web/src/health/health-view.test.ts`

**Interfaces:**
- Consumes: `HealthStatusSchema`, `HealthReportSchema`, `HealthReport`, `HealthTrace`, `CoreTransport` (`apps/web/src/transport/CoreTransport.js`).
- Produces:
  - `type HealthViewState = { kind: "not_allowed" } | { kind: "none" } | { kind: "missing" } | { kind: "unreadable"; reason: string } | { kind: "ok"; report: HealthReport; staleSince: string | null }`
  - `viewState(status: HealthStatus, now: Date): HealthViewState`
  - `tirSegments(stats): Array<{ key: "very_low" | "low" | "in_range" | "high" | "very_high"; label: string; pct: number }> | null`
  - `medianTrace(traces: HealthTrace[]): [number, number][]`
  - `sensorLowsIn(report, t0: string, minutes: number): number[]` (minutes after t0)
  - `findingWindows(report): Set<string>`
  - `runMessage(lastRun): string | null`
  - `formatLocal(iso: string): string`
  - `useHealth(transport): { status: HealthStatus | undefined; error: string | undefined; refresh(): Promise<void>; runNow(): Promise<void>; decide(id, action): Promise<void> }`

- [ ] **Step 1: Write the failing test**

`apps/web/src/health/health-view.test.ts`:

```ts
import { HealthReportSchema, healthReportFixture } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { medianTrace, runMessage, sensorLowsIn, tirSegments, viewState } from "./health-view.js";

const base = { granted: true, nodeId: null, nodeOnline: true, busy: null, lastRun: null, weeklyAt: "20:00", proposed: 1 };
const ok = (report: unknown) => ({ ...base, report: { state: "ok" as const, receivedAt: "2026-10-11T19:04:00.000Z", report } });

describe("viewState", () => {
  it("shows the report fresh within 8 days", () => {
    expect(viewState(ok(healthReportFixture()), new Date("2026-10-18T12:00:00"))).toMatchObject({ kind: "ok", staleSince: null });
  });

  it("shows the stale banner past 8 days even when stale_since is null", () => {
    expect(viewState(ok(healthReportFixture()), new Date("2026-10-20T20:04:00"))).toMatchObject({ staleSince: "2026-10-11T20:03:12" });
  });

  it("prefers glycolens's own stale_since", () => {
    const report = { ...healthReportFixture(), stale_since: "2026-10-09T08:00:00" };
    expect(viewState(ok(report), new Date("2026-10-12T00:00:00"))).toMatchObject({ staleSince: "2026-10-09T08:00:00" });
  });

  it("turns a report the page cannot read into unreadable, not a crash", () => {
    expect(viewState(ok({ schema_version: 1 }), new Date())).toMatchObject({ kind: "unreadable" });
    expect(viewState({ ...base, granted: false, report: { state: "none" } }, new Date())).toEqual({ kind: "not_allowed" });
  });
});

describe("geometry", () => {
  const report = HealthReportSchema.parse(healthReportFixture());

  it("splits time in range into five labelled bands that sum to 100", () => {
    const bands = tirSegments(report.stats)!;
    expect(bands.map((b) => b.key)).toEqual(["very_low", "low", "in_range", "high", "very_high"]);
    expect(bands[0]).toMatchObject({ label: "Below 3.0", pct: 0.6 });
    expect(bands[1]).toMatchObject({ label: "3.0–3.9", pct: 2.5 });
    expect(Math.round(bands.reduce((sum, b) => sum + b.pct, 0))).toBe(100);
    expect(tirSegments({ ...report.stats, tir: null })).toBeNull();
  });

  it("draws the median of aligned traces only where two or more overlap", () => {
    const median = medianTrace([
      { t0: "2026-10-05T07:40:00", hit: true, points: [[0, 6], [5, 8]] },
      { t0: "2026-10-06T07:40:00", hit: false, points: [[0, 8], [5, 10], [10, 12]] },
    ]);
    expect(median).toEqual([[0, 7], [5, 9]]);
  });

  it("finds possible sensor lows inside a chart's time span", () => {
    expect(sensorLowsIn(report, "2026-10-05T00:00:00", 360)).toEqual([190]);
    expect(sensorLowsIn(report, "2026-10-06T00:00:00", 360)).toEqual([]);
  });

  it("says what to do after a run that could not log in", () => {
    expect(runMessage({ at: "2026-10-18T19:05:00.000Z", outcome: "no_login" })).toBe("Tandem Source login missing: run glycolens login on the home PC.");
    expect(runMessage(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/src/health/health-view.test.ts`
Expected: FAIL, `./health-view.js` not found.

- [ ] **Step 3: Write the view model**

`apps/web/src/health/health-view.ts`:

```ts
import type { HealthReport, HealthStats, HealthStatus, HealthTrace } from "@noctis/contracts";
import { HealthReportSchema } from "@noctis/contracts";

/**
 * Everything the Health page shows, worked out from report.json alone. Display
 * geometry only (band sizes, a median line, where a marker sits): no medical
 * inference, and every number a label shows is one glycolens wrote.
 */

const STALE_AFTER_MS = 8 * 24 * 3_600_000;
const MINUTE = 60_000;

/** report.json times are naive local; the browser reads them in its own zone, the home PC's. */
const local = (iso: string): number => new Date(iso).getTime();

export type HealthViewState =
  | { kind: "not_allowed" }
  | { kind: "none" }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string }
  | { kind: "ok"; report: HealthReport; staleSince: string | null };

export function viewState(status: HealthStatus, now: Date): HealthViewState {
  if (!status.granted) return { kind: "not_allowed" };
  if (status.report.state === "none") return { kind: "none" };
  if (status.report.state === "missing") return { kind: "missing" };
  if (status.report.state === "unreadable") return { kind: "unreadable", reason: status.report.reason };
  const parsed = HealthReportSchema.safeParse(status.report.report);
  if (!parsed.success) return { kind: "unreadable", reason: "this report has a shape Noctis does not know" };
  const report = parsed.data;
  const old = now.getTime() - local(report.generated_at) > STALE_AFTER_MS;
  return { kind: "ok", report, staleSince: report.stale_since ?? (old ? report.generated_at : null) };
}

const r1 = (value: number): number => Math.round(value * 10) / 10;

export function tirSegments(stats: HealthStats) {
  const { tbr, tbr_severe, tir, tar, tar_severe } = stats;
  if (tbr === null || tbr_severe === null || tir === null || tar === null || tar_severe === null) return null;
  return [
    { key: "very_low", label: "Below 3.0", pct: tbr_severe },
    { key: "low", label: "3.0–3.9", pct: r1(tbr - tbr_severe) },
    { key: "in_range", label: "3.9–10.0", pct: tir },
    { key: "high", label: "10.0–13.9", pct: r1(tar - tar_severe) },
    { key: "very_high", label: "Above 13.9", pct: tar_severe },
  ] as const;
}

/** The median curve of traces aligned at t0, in 5-minute steps, where two or more traces have a reading. */
export function medianTrace(traces: readonly HealthTrace[]): [number, number][] {
  const buckets = new Map<number, number[]>();
  for (const trace of traces)
    for (const [minute, value] of trace.points) {
      const step = Math.round(minute / 5) * 5;
      buckets.set(step, [...(buckets.get(step) ?? []), value]);
    }
  return [...buckets.entries()]
    .filter(([, values]) => values.length >= 2)
    .sort(([a], [b]) => a - b)
    .map(([step, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length / 2;
      return [step, r1(sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2)];
    });
}

/** Minutes after `t0` of each possible sensor low inside [t0, t0 + minutes]. */
export function sensorLowsIn(report: HealthReport, t0: string, minutes: number): number[] {
  const start = local(t0);
  return report.possible_sensor_lows
    .map((low) => Math.round((local(low) - start) / MINUTE))
    .filter((offset) => offset >= 0 && offset <= minutes);
}

export const findingWindows = (report: HealthReport): Set<string> => new Set(report.findings.map((f) => f.window));

export function runMessage(lastRun: HealthStatus["lastRun"]): string | null {
  if (lastRun === null) return null;
  switch (lastRun.outcome) {
    case "no_login":
      return "Tandem Source login missing: run glycolens login on the home PC.";
    case "no_data":
      return "glycolens has no data yet.";
    case "stale":
      return `The last fetch failed; the report uses stored data. ${lastRun.reason ?? ""}`.trim();
    case "failed":
      return `The last run failed: ${lastRun.reason ?? "no reason given"}`;
    default:
      return null;
  }
}

export const formatLocal = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
```

In the fixture, the sensor low at 03:10 sits 190 min after the 00:00 basal t0, which is what the test expects.

`apps/web/src/health/useHealth.ts`: follow `apps/web/src/notify/useWaitingCount.ts` exactly for the subscribe / latest-answer-wins pattern:

```ts
import type { HealthStatus } from "@noctis/contracts";
import { HealthStatusSchema } from "@noctis/contracts";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import type { CoreTransport } from "../transport/CoreTransport.js";

const HeadSchema = z.object({ latestSequence: z.number() }).loose();

/** The Health page's data: `GET /glucose`, re-read whenever a health job moves. */
export function useHealth(transport: CoreTransport | undefined) {
  const [status, setStatus] = useState<HealthStatus>();
  const [error, setError] = useState<string>();

  const read = useCallback(async () => {
    if (transport === undefined) return;
    const parsed = HealthStatusSchema.safeParse((await transport.request("GET", "/glucose").catch(() => undefined))?.body);
    if (parsed.success) setStatus(parsed.data);
  }, [transport]);

  useEffect(() => {
    if (transport === undefined) return;
    let live = true;
    let close: (() => void) | undefined;
    void (async () => {
      const head = HeadSchema.safeParse((await transport.request("GET", "/events?after=0&limit=1").catch(() => undefined))?.body);
      const opened = await transport
        .subscribe({
          afterSequence: head.success ? head.data.latestSequence : 0,
          onEvent: (event) => {
            const capability = (event.payload as { capability?: string } | undefined)?.capability;
            if (event.type.startsWith("node.job") && capability?.startsWith("health.")) void read();
          },
        })
        .catch(() => undefined);
      if (!live) return opened?.close();
      close = () => opened?.close();
      await read();
    })();
    return () => {
      live = false;
      close?.();
    };
  }, [transport, read]);

  const command = useCallback(
    async (name: string, body: Record<string, unknown> = {}) => {
      if (transport === undefined) return;
      setError(undefined);
      const response = await transport.request("POST", `/commands/${name}`, { idempotencyKey: crypto.randomUUID(), ...body }).catch(() => undefined);
      if (response?.status !== 200) setError(response === undefined ? "Noctis could not reach the core." : refusal(response.body));
      await read();
    },
    [transport, read],
  );

  return {
    status,
    error,
    refresh: () => command("health.refresh"),
    runNow: () => command("health.run_now"),
    decide: (id: string, action: "mark-applied" | "dismiss" | "reset") => command("health.decide", { id, action }),
  };
}

function refusal(body: unknown): string {
  const reason = (body as { error?: { details?: { reason?: string } } })?.error?.details?.reason;
  if (reason === "run_in_progress") return "glycolens is running; try again when it finishes.";
  if (reason === "pc_offline") return "The home PC is offline.";
  if (reason === "busy") return "glycolens is busy.";
  return "The core refused.";
}
```

Check how the core's error body carries a conflict's `reason` (look at how `apps/web/src/pages/Productivity.tsx` reads a refused command), and adjust `refusal` to that path. Check that `job_queued` / `job_result` events carry `capability` in their payload (they do: `apps/core/src/nodes/jobs.ts` sets it on both).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/web/src/health`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/health
git commit -m "feat(web): Health view model and data hook"
git push origin main
```

---

### Task 6: Plain Health page, rail tab, badge, panel and Nodes allow

**Files:**
- Create: `apps/web/src/health/HealthReportView.tsx`, `apps/web/src/pages/Health.tsx`
- Modify: `packages/ui/src/primitives/rail-items.ts`, `apps/web/src/App.tsx`, `apps/web/src/pages/Nodes.tsx`
- Test: `apps/web/src/health/HealthReportView.test.ts`

**Interfaces:**
- Consumes: Task 5's `viewState`, `tirSegments`, `findingWindows`, `runMessage`, `formatLocal`, `useHealth`.
- Produces: `HealthReportView(props: HealthReportViewProps)`. Astra restyles it and keeps the props:

```ts
export interface HealthReportViewProps {
  status: HealthStatus | undefined;
  now: Date;
  error?: string | undefined;
  onRunNow(): void;
  onDecide(id: string, action: "mark-applied" | "dismiss" | "reset"): void;
}
```

- [ ] **Step 1: Write the failing test**

`apps/web/src/health/HealthReportView.test.ts` renders with `react-dom/server`'s `renderToStaticMarkup`. Check the existing web tests for a render helper first, for example `apps/web/src/pages/Login.test.ts`, and use theirs if one exists.

```ts
import { healthReportFixture } from "@noctis/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HealthReportView } from "./HealthReportView.js";

const status = (report: unknown, extra = {}) => ({
  granted: true, nodeId: null, nodeOnline: true, busy: null, lastRun: null, weeklyAt: "20:00", proposed: 1,
  report: { state: "ok" as const, receivedAt: "2026-10-11T19:04:00.000Z", report }, ...extra,
});
const render = (props: Partial<Parameters<typeof HealthReportView>[0]>) =>
  renderToStaticMarkup(createElement(HealthReportView, { status: undefined, now: new Date("2026-10-12T09:00:00"), onRunNow: () => undefined, onDecide: () => undefined, ...props }));

describe("HealthReportView", () => {
  it("shows every section of a report and the not-medical-advice line", () => {
    const html = render({ status: status(healthReportFixture()) });
    for (const text of ["71.4", "Breakfast: 2 of 3 meals ended high", "from 10 to 9 g/U", "Applied", "Dismiss", "provisional", "2 of 5 meals so far", "possible sensor low", "Not medical advice"])
      expect(html).toContain(text);
  });

  it("shows the stale banner, the unreadable state and the allow hint", () => {
    expect(render({ status: status(healthReportFixture()), now: new Date("2026-10-25T09:00:00") })).toContain("Data stale since");
    expect(render({ status: status({ nope: true }) })).toContain("Report unreadable");
    expect(render({ status: { ...status(null), granted: false, report: { state: "none" } } })).toContain("Allow health on the Nodes page");
  });

  it("disables decisions and Run now while glycolens is running", () => {
    const html = render({ status: status(healthReportFixture(), { busy: "run" }) });
    expect(html).toContain("glycolens is running");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Applied/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/src/health/HealthReportView.test.ts`
Expected: FAIL, `./HealthReportView.js` not found.

- [ ] **Step 3: Write the plain page**

`HealthReportView.tsx` uses the existing `@noctis/ui` tokens the other pages use (`semantic`, `typography`; copy the imports from `apps/web/src/pages/Approvals.tsx`). Plain layout, in this order:
1. Header "Health", "Run now" button (disabled when `busy !== null` or `!nodeOnline`), a `runMessage(lastRun)` line, a "glycolens is running…" line when `busy === "run"`, and `error`.
2. State switch on `viewState(status, now)`:
   - `not_allowed`: "Allow health on the Nodes page to see your report."
   - `none`: "No report yet. Run now to make one."
   - `missing`: "glycolens has not written a report yet."
   - `unreadable`: "Report unreadable" plus the reason.
3. For `ok`:
   - **Stale banner** "Data stale since {formatLocal(staleSince)}" when set. Wrap the rest in `<div data-stale={staleSince !== null}>` (Astra dims it).
   - **Headline:** TIR %, then GMI, CV, mean, each with its unit. `tirSegments` as a labelled list with percentages.
   - **AGP:** a 24-row table (hour, p5, p25, p50, p75, p95). Astra replaces it.
   - **Windows:** name, start–end, TIR. Mark windows in `findingWindows`.
   - **Findings:** text, an `evidence` list, and "{traces.length} events" (Astra charts them).
   - **Suggestions:** text, `current → proposed (step_pct%)`, status. For `proposed`, "Applied" is a two-step button: the first click reveals "I already changed the pump: mark applied". The second click calls `onDecide(id, "mark-applied")`. Next to it, "Dismiss". For `applied` / `dismissed`, offer "Undo" (`reset`). All are disabled while `busy === "run"`.
   - **Past changes:** window, setting, `current → proposed`, `applied_at`, outcome, plus "provisional" when `!outcome_final`, and before/after TIR.
   - **Watching:** window, rule, reason.
   - **Possible sensor lows:** formatted times with "possible sensor low (counted as real)".
4. Always: "Not medical advice. glycolens finds patterns; you and your diabetes team decide."

`apps/web/src/pages/Health.tsx`:

```tsx
import { useEffect, useRef } from "react";

import { HealthReportView } from "../health/HealthReportView.js";
import { useHealth } from "../health/useHealth.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

/** The Health page: the latest glycolens report from the home PC. */
export function Health({ transport }: { transport: CoreTransport | undefined }): JSX.Element {
  const health = useHealth(transport);
  const asked = useRef(false);
  // Once per visit: ask the PC for its report.json in case glycolens ran outside Noctis.
  useEffect(() => {
    if (asked.current || health.status === undefined) return;
    if (health.status.granted && health.status.nodeOnline && health.status.busy === null) {
      asked.current = true;
      void health.refresh();
    }
  }, [health.status]);
  return (
    <HealthReportView
      status={health.status}
      now={new Date()}
      error={health.error}
      onRunNow={() => void health.runNow()}
      onDecide={(id, action) => void health.decide(id, action)}
    />
  );
}
```

Rail, badge and panel:
- `packages/ui/src/primitives/rail-items.ts`: add `"Health"` to `NAV_ITEMS` after `"Approvals"`. Check `TabBar` keeps its overflow under `More` on a phone (`packages/ui/src/primitives/TabBar.tsx`). Its tests assert the item list, so update them.
- `apps/web/src/App.tsx`: replace Task 1's `case "Health": return null;` with `return <Health transport={transport} />;`, and add `{active === "Health" && <Health transport={transport} />}` beside the Approvals line (~509). Change `counts` to `{ Approvals: useWaitingCount(transport), Health: useHealth(transport).status?.proposed ?? 0 }`. That second `useHealth` never calls `refresh`, so only the page asks the PC.
- `PAGE_PANEL_PAGES` already has `"Health"` (Task 1), so Add panel lists it.

Nodes allow, in `apps/web/src/pages/Nodes.tsx`, beside the screen-view `allow` control (~line 730):
- A "Health (glycolens)" row per online node.
- A text input "glycolens folder", with placeholder `C:\Users\you\Documents\glycolens`.
- "Allow health on this PC", which posts `/commands/health.allow` `{ idempotencyKey, nodeId, repo }`. "Stop", which posts `/commands/health.disallow` `{ idempotencyKey, nodeId }`.
- Show "Allowed" when `GET /glucose` says `granted && nodeId === node.id`.
- Use the same `nextKey`, `setProblem` and refusal text as the screen-view control.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/web/src/health packages/ui`
Expected: PASS.

Run: `npm run typecheck`, then `npm run build:web`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src packages/ui/src
git commit -m "feat(web): Health page, rail badge, page panel and Allow health on Nodes"
git push origin main
```

---

### Task 7: Astra (Codex) builds the visuals

Claude drives this task, delegating to Codex through the `codex` skill. Codex's sandbox cannot install packages or run the repo's browser tests reliably. So the task splits into: Astra proposes the stack, Claude installs it, Astra implements, Claude verifies.

**Files:**
- Create (Astra): `apps/web/src/health/visuals/*.tsx`, plus the `.ts` helpers they need with `*.test.ts` beside them
- Create (Astra): `apps/web/e2e/health.html`, `apps/web/e2e/health.fixture.jsx`, `apps/web/e2e/health.test.mjs`, following `apps/web/e2e/productivity.html`, `productivity.fixture.jsx` and `productivity.test.mjs`
- Modify (Astra): `apps/web/src/health/HealthReportView.tsx` (keep `HealthReportViewProps` unchanged)
- Modify (Claude): `apps/web/package.json`, `package-lock.json`

**Interfaces:**
- Consumes: `HealthReportViewProps`; everything in `health-view.ts`; `healthReportFixture()`.
- Produces: the same `HealthReportView` export, restyled. Task 6's `HealthReportView.test.ts` must still pass; change only a text assertion whose copy Astra improved, and keep its meaning.

- [ ] **Step 1: Ask Astra for the stack (read-only)**

Run Codex with `--sandbox read-only`. The prompt must contain:
- the owner's add-on brief (pieces 1–8, constraints)
- this plan's Global Constraints
- the paths of `health-view.ts`, `HealthReportView.tsx` and `health-fixture.ts`
- the existing tokens in `packages/ui/src`

It asks: "Which libraries (exact versions published at least two weeks ago) give the most premium result for these charts and motion in React 18? Answer with the list and one line on what each does." Expect something like `motion` (React animation), `d3-scale` / `d3-shape` / `d3-array` (geometry) or `@visx/*`. Any library is allowed. Review the answer: reject anything that phones home (analytics, CDN fonts at runtime, remote tiles) or needs a server.

- [ ] **Step 2: Install them**

Run: `npm install --workspace @noctis/web --save-exact <packages@versions>`
Then: `npm run build:web`
Expected: exit 0, lockfile updated.

- [ ] **Step 3: Astra implements**

Run Codex with `--sandbox workspace-write` and the same context, plus:
- **Hero:** "your glucose day" from `agp[]`, as a 24 h radial clock or a wide ribbon. p5–p95 as a haze, p25–p75 as a solid band, the median as a glowing line. The 3.9–10 target corridor, with a low zone glowing red beneath it. `windows[]` as arcs or bands; the windows in `findingWindows(report)` are marked and clickable, scrolling to their findings.
- **Headline:** a segmented TIR ring from `tirSegments`, each segment labelled and patterned (not colour alone), with GMI, CV and the mean beside it. An animated fill on load.
- **Per finding**, a spaghetti chart of `traces` aligned at t0. Non-hits are faint; hits glow in the finding's accent; `medianTrace` is bold.
  - Thresholds: for meals, start +2.0 at 4 h and the 3.9 line; for corrections, a dashed expected curve from the start down by `expected_drop` at 5 h.
  - Curves draw in on reveal. Hover shows that trace's time, carbs or units, and values.
- **Basal:** a night-by-hour heat strip from `trace.basal` (null cells hatched), coloured from cut back to boosted with a legend, and each night's `points` as a sparkline beside it.
- **Suggestions:** a "current → proposed" chip with the step %, plus Applied (two-step) / Dismiss / Undo. Never auto-apply.
- **Past changes:** a before → after TIR ring morph, an outcome badge with an icon, and "provisional" until `outcome_final`.
- **`possible_sensor_lows`:** hollow or dashed markers on every chart whose span covers them (`sensorLowsIn`), with the tooltip "possible sensor low (counted as real)".
- **Stale:** the banner, and charts dimmed via `data-stale`.
- **Rules:** honour `prefers-reduced-motion` (no draw-in or morph; final state at once). Never rely on red/green alone. It must be readable at 390 px wide and on the desktop panel. Dark first, using the existing tokens. Show no number that is not in the report, and keep "Not medical advice".
- **Preview:** `apps/web/e2e/health.html` + `health.fixture.jsx` render `HealthReportView` with `healthReportFixture()` and no core. `health.test.mjs` opens it at 1280 and 390 px wide, and with reduced motion. It asserts no horizontal scroll at 390 px, that the ring and at least three charts are visible, and that the stale variant shows the banner.

- [ ] **Step 4: Claude reviews and verifies**

1. Read the whole diff. Reject:
   - network calls
   - numbers computed into labels
   - colour-only meaning
   - changed `HealthReportViewProps`
   - `useEffect` loops that write shared state during render (see the adaptive-panels traps in `docs/acceptance/IMPLEMENTATION-STATUS.md`)
2. Run: `npx vitest run apps/web/src/health`. Expected: PASS.
3. Run: `npm run typecheck && npm run build:web`. Expected: exit 0.
4. Run, with `TEMP` / `TMP` set to `.noctis/tmp`: `node --test apps/web/e2e/health.test.mjs`. Expected: PASS.
5. Take Playwright screenshots of `health.html` at 1280 and 390 px and look at them. If it doesn't look premium, send Astra one round of concrete notes.

- [ ] **Step 5: Commit**

```bash
git add apps/web package-lock.json
git commit -m "feat(web): Health panel visuals: glucose day, TIR ring, event traces, basal strip"
git push origin main
```

---

### Task 8: Verification record and owner hand-off

**Files:**
- Modify: `docs/acceptance/IMPLEMENTATION-STATUS.md`

- [ ] **Step 1: Run the affected suites once**

Run: `npx vitest run packages/contracts apps/core/src/health apps/core/src/productivity apps/core/src/api apps/node-agent/src/health.test.ts apps/web/src/health packages/ui`
Expected: exit 0. Record the file and test counts.

Run: `npm run typecheck && npm run lint && npm run build:web`
Expected: exit 0.

- [ ] **Step 2: Privacy check**

Run: `git log -p --since=2026-10-16 | grep -nE "mmol|report\.json" | head`. Confirm that only the synthetic fixture and code appear.

Search for any `logger.log` in `apps/core/src/health` and `apps/node-agent/src/health.ts` that passes a report, stderr or a reading. Expected: none.

- [ ] **Step 3: Status entry**

Append a "2026-10-?? glycolens Plan 2" entry to `docs/acceptance/IMPLEMENTATION-STATUS.md` with:
- the commands and results from Step 1
- what is not verified: the live run on the home PC, the boot-copy Credential Manager question, and the phone view of the live panel

- [ ] **Step 4: Hand the owner one paste-ready block per PC**

In the final message (not only in the doc):
1. **Work PC:** run `scripts/deploy/work-pc.ps1`, then restart its node. The core must be deployed before the home node.
2. **Home PC:** restart the node with `.noctis/home-node.ps1` from the desktop, not the boot task.
3. **In Noctis:**
   - Nodes → home PC → glycolens folder `C:\Users\mmush\Documents\glycolens` → Allow health on this PC.
   - Settings → "Weekly health run (Sundays)" `20:00`.
   - Health → Run now, and expect a report within a few minutes.
   - Try Applied on a suggestion, then Undo.
4. **Boot-copy check:** reboot the home PC without running `home-node.ps1`, then press Run now.
   - If it says "Tandem Source login missing" although `glycolens login` was done, the S4U boot copy cannot read Credential Manager. Runs then need the desktop copy.
   - Fixing that is a separate decision: for example, glycolens keeping its secret DPAPI-encrypted in a file, or the boot task becoming an interactive logon task.

- [ ] **Step 5: Commit**

```bash
git add docs/acceptance/IMPLEMENTATION-STATUS.md
git commit -m "docs: glycolens Plan 2 verification and owner steps"
git push origin main
```
