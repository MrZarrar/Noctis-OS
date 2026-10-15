# glycolens — weekly diabetes pattern finder (design)

Status: design approved in conversation 2026-10-15. Build starts after the current Noctis work is
complete. This spec moves into the `glycolens` repo when that repo is created.

## Purpose

Personal, non-commercial tool for one user (type 1, t:slim X2 with Control-IQ, Dexcom G7 paired to
the pump). Every week it pulls pump and CGM data automatically, finds patterns, and proposes small,
evidence-backed setting and behaviour changes (e.g. "breakfast highs on 5 of 6 days, strengthen the
06:00–10:00 carb ratio by ~10%"). It tracks whether applied changes helped. It is a standalone repo so
it stands as its own CV project; Noctis is one consumer of its output.

Non-goals: real-time alerts, dosing in the moment, any commercial or multi-user use, ML for its own
sake (statistics first; ML only if a rule genuinely needs it).

## Facts the design rests on

- UK t:slim X2 + Tandem t:slim mobile app (paired) uploads pump data to **Tandem Source**
  automatically, but not in real time. With the G7 paired to the pump, Tandem Source also holds CGM.
- Glooko holds G7 CGM data via the Dexcom connection and offers a web-only CSV export (zip).
- There is no official individual API for Tandem Source or Glooko. `tconnectsync` (Python) is the
  only existing Tandem Source client and is unofficial; UK/EU account support is unverified.

## Architecture

```
Tandem Source ─┐                ┌─ rules: carb ratio / ISF / basal / behaviour
Glooko CSV ────┼─► adapters ─► SQLite store ─► analyse ─► findings + suggestions
drop folder ───┘  (normalise)   (dedupe)                         │
                                      Qwen summary (checked) ─► report.json + weekly.md
                                                                 │
                                         Noctis home node ◄──────┘ (reads only)
```

Language: Python (reuses `tconnectsync`; pandas for windowed statistics). Runs on the home PC only.

### Adapters

One adapter per source, each producing the normalised model:

- `glucose(ts, mmol)` — display in mmol/L.
- `bolus(ts, units, carbs_g, kind)` with `kind ∈ {meal, correction, auto}`; `auto` = Control-IQ
  auto-correction and is never treated as the user's correction.
- `basal(ts, programmed_rate, delivered_rate)`.
- `event(ts, kind)` with `kind ∈ {site_change, exercise_mode, sleep_mode}`.
- `settings_snapshot(taken_at, segments[])` — per-segment carb ratio, ISF, basal, target — when the
  source exposes it.

Adapters: Tandem Source (primary, via `tconnectsync`), Glooko CSV (secondary, CGM), drop folder
(manual export fallback). Every run fetches the last **14 days**; overlap is harmless.

### Store

One SQLite file on the home PC. Idempotent upserts keyed on source + timestamp + kind, so reruns and
overlapping fetches converge to the same state. A `suggestion` table holds
`id, created_week, window, setting, direction, step_pct, evidence_json, status`
with `status ∈ {proposed, applied, dismissed}`, `applied_at`, and `outcome ∈ {helped, no_change,
worse, pending}`.

### CLI

- `glycolens run` — fetch, analyse, write `report.json` (+ `weekly.md` when `--vault`).
- `glycolens mark-applied <id>` / `glycolens dismiss <id>` — reversible (re-running the other
  command or `glycolens reset <id>` returns it to `proposed`).

## Analysis

Windows are the pump's own settings segments (so a suggestion maps to an editable segment); fall back
to fixed blocks (00–06, 06–10, 10–14, 14–18, 18–22, 22–24) when no settings snapshot exists.

Weekly baseline: TIR 3.9–10, TBR (<3.9, <3.0), TAR (>10, >13.9), GMI, CV, hourly AGP percentiles
(5/25/50/75/95).

### Rules

| Rule | Qualifying events | Pattern |
|---|---|---|
| Carb ratio | Meal bolus with carbs, no other carbs/bolus in following 4 h | ≥ 70% of qualifying meals in the window end > 2.0 mmol/L above start at 4 h (too weak), or go < 3.9 within 4 h (too strong) |
| ISF | `correction` boluses: no carbs ±2 h, not `auto`, no exercise mode | Median actual drop ÷ expected (units × ISF) over 3 h is > 1.3 (too strong) or < 0.7 (too weak) |
| Basal | Fasting windows (no carbs/bolus in prior 4 h), mostly overnight | Control-IQ delivered basal consistently ≥ 25% above or below programmed in the window, or glucose drift > 1.5 mmol/L over the window |
| Behaviour | All | Spike ≥ 4 mmol/L by 1 h but back within 2 mmol/L of start at 4 h → pre-bolus timing (not ratio); rise ≥ 3 mmol/L in 1 h with no carbs logged → possible missed bolus; < 3.9 within 6 h after exercise mode; mean glucose on site day 3+ ≥ 1.5 mmol/L above days 1–2 |

A meal that matches the pre-bolus-timing pattern is excluded from the carb ratio rule.

### Guardrails (deterministic, not overridable by any model)

1. **Lows win:** a window with TBR < 3.9 above 4% or any reading < 3.0 can only receive
   weaker-dosing suggestions.
2. **Small steps:** maximum 10% change per suggestion; one setting per window per week.
3. **Evidence threshold:** fewer than 4 qualifying events, or below the consistency threshold →
   "watching" note, not a suggestion.
4. **One change at a time:** no new suggestion for a window whose applied change has fewer than 7
   days of after-data.
5. **Coverage:** a window with < 70% CGM coverage is "insufficient data" and gets no suggestion.
6. Every suggestion carries its evidence (dates, meals, values).

### Outcome tracking

For each applied suggestion, compare the rule's metric for that window over the 7–14 days before vs
after `applied_at` → `helped / no_change / worse`. Measured weekly until 14 days of after-data exist.

### Text

Findings and suggestions get deterministic template text. A weekly summary paragraph is written by
the local Qwen model through LM Studio's OpenAI-compatible endpoint on the home PC. Qwen receives only
the findings JSON. A deterministic check rejects the summary if it contains any number not present in
the findings; on rejection, or when LM Studio is unavailable, the report uses the template summary and
the run still succeeds.

## Outputs

- `report.json` — versioned schema (`schema_version`), with baseline stats, AGP, findings,
  suggestions, past-change outcomes, `data_through` and a `stale_since` field.
- `weekly.md` — summary only (stats, findings, suggestions, outcomes; never raw readings), written to
  `MindVault/inbox/` with frontmatter `title, tags: [], created, source: noctis-health`. Behind
  `--vault`, **off by default**; enabling it is a deploy-time owner decision.

## Noctis integration (Noctis repo)

- Contracts: `HealthReportSchema` (Zod) in `packages/contracts`, mirroring `report.json`.
- Home node capabilities, default-off until granted:
  - `health.report` — `read_inspect` — returns the latest `report.json`, validated.
  - `health.decide` — `local_reversible_edit` — runs `glycolens mark-applied|dismiss|reset <id>`.
- Web: a Health panel in the adaptive panel system — headline stats, AGP chart, findings,
  suggestions with Applied / Dismiss, past changes with outcomes; "data stale since" banner; "report
  unreadable" state on schema failure.
- Dependency is one-way: glycolens never imports or needs Noctis.

## Scheduling

Windows Task Scheduler on the home PC runs `glycolens run` weekly (Sunday evening) with "run as soon
as possible after a missed start". Registering the task is an owner-run deploy step, per Noctis's
rule against registering services without approval.

## Error handling

- Fetch failure (login, API change): analyse what is already stored; report sets `stale_since`;
  never emits a "no findings" report built on no new data.
- Tandem credentials live in Windows Credential Manager via `keyring`; never in config or the repo.
- Malformed `report.json` is rejected by Noctis's schema check; the panel shows "report unreadable".

## Testing

- Synthetic fixture weeks with injected, known faults (weak breakfast ratio, late pre-bolus only,
  Control-IQ +40% basal at 03:00, over-strong ISF, missed boluses, site-day-3 highs). Each rule test
  proves the rule fires on its fault **and stays quiet on every other fixture**.
- Guardrail tests: lows-win, 10% cap, one-change-at-a-time, coverage gate.
- Adapter tests against a recorded, anonymised Tandem Source response; no live login in tests.
- Qwen check test: a summary with an invented number is rejected.
- Acceptance: owner runs it once on the real last 4 weeks and judges whether findings ring true.

## First step: spike (before any build)

1. Confirm `tconnectsync` logs in to the owner's UK Tandem Source account and returns CGM, boluses
   (with kind), programmed vs delivered basal, events, and whether a settings snapshot is available.
2. If it does not, fall back to the drop-folder adapter with whatever export Tandem Source or Glooko
   provides, and re-plan the automatic fetch.
3. Confirm a Python environment installs and runs on the home PC under Smart App Control (the existing
   MCP servers there use a no-venv Python 3.14 for that reason).
