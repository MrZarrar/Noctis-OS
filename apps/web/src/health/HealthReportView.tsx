import type {
  HealthChange,
  HealthFinding,
  HealthReport,
  HealthStatus,
  HealthSuggestion,
} from "@noctis/contracts";
import { corner, glass, material, semantic, spacing, typography } from "@noctis/ui";
import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CircleDashed,
  Clock,
  Eye,
  Minus,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import type { MotionStyle } from "motion/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { useId, useState } from "react";

import { Page, SectionHeading, buttonStyle } from "../layout/Page.js";
import type { HealthViewState } from "./health-view.js";
import { findingWindows, formatLocal, runMessage, tirSegments, viewState } from "./health-view.js";
import { BasalStrip } from "./visuals/BasalStrip.js";
import { GlucoseDay } from "./visuals/GlucoseDay.js";
import { GlucoseRibbon } from "./visuals/GlucoseRibbon.js";
import { EASE } from "./visuals/motion.js";
import { band, glucose, ruleAccent } from "./visuals/palette.js";
import { RangeRing, RingLegend } from "./visuals/RangeRing.js";
import { TraceChart } from "./visuals/TraceChart.js";

/**
 * The Health page, from props alone: the latest glycolens report as an
 * instrument. Every number on it is one glycolens wrote; the page draws, it
 * never works anything out about the owner's diabetes.
 */

export type HealthDecision = "mark-applied" | "dismiss" | "reset";

export interface HealthReportViewProps {
  status: HealthStatus | undefined;
  now: Date;
  error?: string | undefined;
  onRunNow: () => void;
  onDecide: (id: string, action: HealthDecision) => void;
}

const SETTING: Record<HealthSuggestion["setting"], { name: string; unit: string }> = {
  carb_ratio: { name: "Carb ratio", unit: "g/U" },
  isf: { name: "Correction factor", unit: "mmol/L per U" },
  basal: { name: "Basal rate", unit: "U/h" },
};

const RULE: Record<HealthFinding["rule"], string> = {
  carb_ratio: "Carb ratio",
  pre_bolus: "Pre-bolus timing",
  isf: "Correction factor",
  basal: "Basal",
  exercise_low: "Lows after exercise",
};

const OUTCOME: Record<
  HealthChange["outcome"],
  { label: string; colour: string; Icon: typeof CircleCheck }
> = {
  helped: { label: "Helped", colour: semantic.success, Icon: CircleCheck },
  no_change: { label: "No change", colour: typography.color.muted, Icon: Minus },
  worse: { label: "Worse", colour: semantic.error, Icon: TriangleAlert },
  pending: { label: "Measuring", colour: semantic.approval, Icon: Clock },
};

const VIEW_KEY = "noctis.health.dayView";

function rememberedView(): "ribbon" | "clock" {
  try {
    return localStorage.getItem(VIEW_KEY) === "clock" ? "clock" : "ribbon";
  } catch {
    return "ribbon";
  }
}

const title = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const card: CSSProperties = {
  ...glass,
  padding: spacing.lg,
  display: "grid",
  gap: spacing.md,
  minWidth: 0,
  position: "relative",
  overflow: "hidden",
};

/** `fill` keeps a lone card at one column's width instead of the whole row. */
const grid = (min: number, fill = false): CSSProperties => ({
  display: "grid",
  gap: spacing.lg,
  gridTemplateColumns: `repeat(${fill ? "auto-fill" : "auto-fit"}, minmax(min(100%, ${String(min)}px), 1fr))`,
  alignItems: "start",
});

export function HealthReportView({
  status,
  now,
  error,
  onRunNow,
  onDecide,
}: HealthReportViewProps): JSX.Element {
  const state: HealthViewState | undefined =
    status === undefined ? undefined : viewState(status, now);
  const running = status?.busy === "run";
  const offline = status !== undefined && status.granted && !status.nodeOnline;
  const canAct =
    status !== undefined && status.granted && status.nodeOnline && status.busy === null;
  const message = runMessage(status?.lastRun ?? null);

  return (
    <Page
      title="Health"
      subtitle={subtitle(state, status)}
      actions={
        <button
          type="button"
          style={{
            ...buttonStyle,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            opacity: canAct ? 1 : 0.55,
          }}
          disabled={!canAct}
          onClick={onRunNow}
        >
          <Spin active={running}>
            <RefreshCw size={16} aria-hidden />
          </Spin>
          Run now
        </button>
      }
    >
      {(running || offline || message !== null || error !== undefined) && (
        <div style={{ display: "grid", gap: 6 }}>
          {running && (
            <Line icon={<Pulse />} tone="accent">
              glycolens is running on the home PC. Decisions wait until it finishes.
            </Line>
          )}
          {offline && <Line icon={<CircleDashed size={16} />}>The home PC is offline.</Line>}
          {message !== null && (
            <Line icon={<TriangleAlert size={16} />} tone="warning">
              {message}
            </Line>
          )}
          {error !== undefined && (
            <Line icon={<TriangleAlert size={16} />} tone="error">
              {error}
            </Line>
          )}
        </div>
      )}

      {state === undefined ? (
        <Empty>Reading the latest report…</Empty>
      ) : state.kind === "not_allowed" ? (
        <Empty icon={<ShieldCheck size={28} />}>
          Allow health on the Nodes page to see your report. Noctis runs glycolens on the home PC
          and keeps the report on your own machines.
        </Empty>
      ) : state.kind === "none" ? (
        <Empty>No report yet. Run now to make one.</Empty>
      ) : state.kind === "missing" ? (
        <Empty>glycolens has not written a report yet.</Empty>
      ) : state.kind === "unreadable" ? (
        <Empty icon={<TriangleAlert size={28} color={semantic.warning} />}>
          <strong style={{ display: "block", color: typography.color.primary, marginBottom: 4 }}>
            Report unreadable
          </strong>
          {state.reason}
        </Empty>
      ) : (
        <Report
          report={state.report}
          staleSince={state.staleSince}
          locked={running || !(status?.nodeOnline ?? false)}
          onDecide={onDecide}
        />
      )}

      <p
        style={{
          margin: `${String(spacing.lg)}px 0 0`,
          color: typography.color.muted,
          fontSize: typography.scale.xs,
          textAlign: "center",
        }}
      >
        Not medical advice. glycolens finds patterns; you and your diabetes team decide.
      </p>
    </Page>
  );
}

function subtitle(state: HealthViewState | undefined, status: HealthStatus | undefined): string {
  const weekly = status?.weeklyAt ? `Runs Sundays at ${status.weeklyAt}` : "Weekly run off";
  if (state?.kind === "ok") {
    return `${String(state.report.period.days)} days to ${formatLocal(state.report.data_through)} · ${weekly}`;
  }
  return `glycolens on the home PC · ${weekly}`;
}

function Report({
  report,
  staleSince,
  locked,
  onDecide,
}: {
  report: HealthReport;
  staleSince: string | null;
  locked: boolean;
  onDecide: (id: string, action: HealthDecision) => void;
}): JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const [dayView, setDayView] = useState<"ribbon" | "clock">(rememberedView);
  const chooseView = (view: "ribbon" | "clock"): void => {
    setDayView(view);
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // A private window keeps the choice for this visit only.
    }
  };
  const marked = findingWindows(report);
  const segments = tirSegments(report.stats);
  const jump = (window: string): void => {
    const index = report.findings.findIndex((finding) => finding.window === window);
    document.getElementById(`health-finding-${String(index)}`)?.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "start",
    });
  };

  return (
    <>
      {staleSince !== null && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: `${String(spacing.sm)}px ${String(spacing.md)}px`,
            borderRadius: corner.md,
            border: `1px solid ${semantic.stale}66`,
            background: `linear-gradient(90deg, ${semantic.stale}22, ${semantic.stale}08)`,
            color: semantic.stale,
            fontSize: typography.scale.sm,
            fontWeight: 600,
          }}
        >
          <TriangleAlert size={18} aria-hidden />
          {`Data stale since ${formatLocal(staleSince)}`}
        </div>
      )}

      <div
        data-stale={staleSince !== null}
        style={{
          display: "grid",
          gap: spacing.xl,
          transition: "opacity 300ms, filter 300ms",
          ...(staleSince !== null ? { opacity: 0.55, filter: "saturate(0.35)" } : {}),
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.lg, alignItems: "stretch" }}>
          <Reveal
            style={{
              ...card,
              flex: "1.7 1 440px",
              padding: "clamp(16px, 2.5vw, 28px)",
              background: `radial-gradient(120% 90% at 20% 0%, rgba(91,79,224,0.18), transparent 60%), ${glass.background}`,
            }}
          >
            <CardTitle
              action={
                <ViewSwitch
                  value={dayView}
                  onChange={chooseView}
                  options={[
                    ["ribbon", "Ribbon"],
                    ["clock", "Clock"],
                  ]}
                  label="Glucose day view"
                />
              }
            >
              Your glucose day
            </CardTitle>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={dayView}
                initial={reduced ? false : { opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.25, ease: EASE }}
              >
                {dayView === "clock" ? (
                  <GlucoseDay report={report} marked={marked} onWindow={jump} />
                ) : (
                  <GlucoseRibbon report={report} marked={marked} onWindow={jump} />
                )}
              </motion.div>
            </AnimatePresence>
            {dayView === "ribbon" && <DayKey />}
          </Reveal>
          <Reveal
            style={{
              ...card,
              flex: "1 1 300px",
              padding: "clamp(16px, 2.5vw, 28px)",
              alignContent: "start",
            }}
          >
            <CardTitle>Time in range</CardTitle>
            {segments === null ? (
              <p style={{ margin: 0, color: typography.color.muted }}>
                Not enough CGM data for time in range.
              </p>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: spacing.lg,
                }}
              >
                <RangeRing
                  segments={segments}
                  centre={`${String(report.stats.tir)}%`}
                  caption="in range"
                  size={176}
                />
                <div style={{ flex: "1 1 160px" }}>
                  <RingLegend segments={segments} />
                </div>
              </div>
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: spacing.sm,
              }}
            >
              <Stat label="GMI" value={report.stats.gmi} unit="%" />
              <Stat label="CV" value={report.stats.cv} unit="%" />
              <Stat label="Mean" value={report.stats.mean} unit="mmol/L" />
            </div>
            <p
              style={{
                margin: 0,
                lineHeight: 1.55,
                color: typography.color.primary,
                fontSize: typography.scale.sm,
              }}
            >
              {report.summary}
              {report.summary_source === "qwen" && (
                <span
                  style={{
                    display: "block",
                    marginTop: 6,
                    color: typography.color.muted,
                    fontSize: typography.scale.xs,
                  }}
                >
                  Summary written by the local model; its numbers were checked against the report.
                </span>
              )}
            </p>
          </Reveal>
        </div>

        <section aria-label="Windows" style={{ display: "grid", gap: spacing.sm }}>
          <SectionHeading>Windows</SectionHeading>
          <div style={grid(170)}>
            {report.windows.map((window) => (
              <WindowChip
                key={window.name}
                window={window}
                marked={marked.has(window.name)}
                onJump={() => jump(window.name)}
              />
            ))}
          </div>
        </section>

        {report.suggestions.length > 0 && (
          <section aria-label="Suggestions" style={{ display: "grid", gap: spacing.sm }}>
            <SectionHeading>Suggestions</SectionHeading>
            <div style={grid(420, true)}>
              {report.suggestions.map((suggestion) => (
                <SuggestionCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  locked={locked}
                  onDecide={onDecide}
                />
              ))}
            </div>
          </section>
        )}

        {report.findings.length > 0 && (
          <section aria-label="Findings" style={{ display: "grid", gap: spacing.sm }}>
            <SectionHeading>Findings</SectionHeading>
            <div style={grid(500)}>
              {report.findings.map((finding, index) => (
                <FindingCard
                  key={`${finding.rule}-${finding.window}`}
                  index={index}
                  finding={finding}
                  report={report}
                />
              ))}
            </div>
          </section>
        )}

        {report.changes.length > 0 && (
          <section aria-label="Past changes" style={{ display: "grid", gap: spacing.sm }}>
            <SectionHeading>Past changes</SectionHeading>
            <div style={grid(420, true)}>
              {report.changes.map((change) => (
                <ChangeCard key={change.id} change={change} />
              ))}
            </div>
          </section>
        )}

        {(report.watching.length > 0 || report.possible_sensor_lows.length > 0) && (
          <div style={grid(300)}>
            {report.watching.length > 0 && (
              <section aria-label="Watching" style={{ display: "grid", gap: spacing.sm }}>
                <SectionHeading>Watching</SectionHeading>
                <Reveal style={{ ...card, gap: spacing.sm }}>
                  {report.watching.map((watch) => (
                    <div
                      key={`${watch.window}-${watch.rule}`}
                      style={{ display: "flex", gap: 10, alignItems: "flex-start" }}
                    >
                      <Eye
                        size={16}
                        color={glucose.accent}
                        aria-hidden
                        style={{ marginTop: 2, flex: "none" }}
                      />
                      <span style={{ fontSize: typography.scale.sm }}>
                        <strong
                          style={{ fontWeight: 600 }}
                        >{`${title(watch.window)} ${RULE[watch.rule as HealthFinding["rule"]] ?? watch.rule}`}</strong>
                        <span style={{ color: typography.color.muted }}>{`: ${watch.reason}`}</span>
                      </span>
                    </div>
                  ))}
                </Reveal>
              </section>
            )}
            {report.possible_sensor_lows.length > 0 && (
              <section
                aria-label="Possible sensor lows"
                style={{ display: "grid", gap: spacing.sm }}
              >
                <SectionHeading>Possible sensor lows</SectionHeading>
                <Reveal style={{ ...card, gap: spacing.sm }}>
                  {report.possible_sensor_lows.map((low) => (
                    <div
                      key={low}
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "center",
                        fontSize: typography.scale.sm,
                      }}
                    >
                      <CircleDashed size={16} aria-hidden style={{ flex: "none" }} />
                      <span>
                        {formatLocal(low)}
                        <span style={{ color: typography.color.muted }}>
                          {" "}
                          · possible sensor low (counted as real)
                        </span>
                      </span>
                    </div>
                  ))}
                </Reveal>
              </section>
            )}
          </div>
        )}

        <details style={{ ...card, padding: `${String(spacing.sm)}px ${String(spacing.lg)}px` }}>
          <summary
            style={{
              cursor: "pointer",
              minHeight: 36,
              display: "flex",
              alignItems: "center",
              color: typography.color.muted,
              fontSize: typography.scale.sm,
            }}
          >
            Hourly values
          </summary>
          <HourlyTable report={report} />
        </details>
      </div>
    </>
  );
}

function CardTitle({ children, action }: { children: string; action?: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: spacing.sm,
      }}
    >
      <h2
        style={{
          margin: 0,
          font: `600 ${String(typography.scale.md)}px ${typography.family}`,
          letterSpacing: typography.tracking.tight,
        }}
      >
        {children}
      </h2>
      {action}
    </div>
  );
}

function ViewSwitch<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly (readonly [T, string])[];
  label: string;
}): JSX.Element {
  const id = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{
        display: "inline-flex",
        padding: 3,
        gap: 2,
        borderRadius: 999,
        background: "rgba(5,4,9,0.5)",
        border: `1px solid ${material.border}`,
      }}
    >
      {options.map(([key, name]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          onClick={() => onChange(key)}
          style={{
            position: "relative",
            minHeight: 32,
            padding: "0 14px",
            border: "none",
            borderRadius: 999,
            background: "transparent",
            color: value === key ? typography.color.primary : typography.color.muted,
            font: `600 12px ${typography.family}`,
            cursor: "pointer",
          }}
        >
          {value === key && (
            <motion.span
              layoutId={`${id}-pill`}
              transition={{ type: "spring", stiffness: 500, damping: 38 }}
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 999,
                background: `${glucose.accent}40`,
                border: `1px solid ${glucose.accent}88`,
              }}
            />
          )}
          <span style={{ position: "relative" }}>{name}</span>
        </button>
      ))}
    </div>
  );
}

function DayKey(): JSX.Element {
  const item = (swatch: CSSProperties, text: string): JSX.Element => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span aria-hidden style={swatch} />
      {text}
    </span>
  );
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 14,
        justifyContent: "center",
        color: typography.color.muted,
        fontSize: 12,
      }}
    >
      {item(
        {
          width: 18,
          height: 3,
          borderRadius: 2,
          background: "#D9D3FF",
          boxShadow: `0 0 8px ${glucose.accent}`,
        },
        "median",
      )}
      {item(
        { width: 14, height: 10, borderRadius: 3, background: glucose.accent, opacity: 0.6 },
        "middle half",
      )}
      {item(
        { width: 14, height: 10, borderRadius: 3, background: glucose.accent, opacity: 0.22 },
        "5–95%",
      )}
      {item({ width: 14, height: 0, borderTop: `2px dashed ${glucose.target}` }, "target 3.9–10.0")}
      {item(
        {
          width: 10,
          height: 10,
          borderRadius: 999,
          background: glucose.accent,
          boxShadow: `0 0 8px ${glucose.accent}`,
        },
        "has findings",
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
}: {
  label: string;
  value: number | null;
  unit: string;
}): JSX.Element {
  return (
    <div
      style={{
        padding: spacing.sm,
        borderRadius: corner.md,
        background: material.fill,
        border: `1px solid ${material.border}`,
        display: "grid",
        gap: 2,
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontSize: 11,
          letterSpacing: "0.12em",
          color: typography.color.muted,
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: typography.scale.lg,
          fontWeight: 650,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.01em",
        }}
      >
        {value === null ? "–" : String(value)}
        <span
          style={{ fontSize: 11, fontWeight: 500, color: typography.color.muted, marginLeft: 3 }}
        >
          {unit}
        </span>
      </span>
    </div>
  );
}

function WindowChip({
  window,
  marked,
  onJump,
}: {
  window: HealthReport["windows"][number];
  marked: boolean;
  onJump: () => void;
}): JSX.Element {
  const segments = tirSegments(window);
  const body = (
    <>
      <span
        style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}
      >
        <span style={{ fontWeight: 600, fontSize: typography.scale.sm }}>{title(window.name)}</span>
        <span
          style={{ fontFamily: typography.monoFamily, fontSize: 11, color: typography.color.muted }}
        >{`${window.start}–${window.end}`}</span>
      </span>
      {segments !== null && (
        <span
          aria-hidden
          style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", gap: 1 }}
        >
          {segments.map((segment) =>
            segment.pct > 0 ? (
              <span
                key={segment.key}
                style={{
                  flex: segment.pct,
                  background: band[segment.key].colour,
                  opacity: segment.key === "in_range" ? 1 : 0.75,
                }}
              />
            ) : null,
          )}
        </span>
      )}
      <span
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
          color: typography.color.muted,
        }}
      >
        <span>{window.tir === null ? "no data" : `${String(window.tir)}% in range`}</span>
        {marked && <span style={{ color: glucose.accent, fontWeight: 600 }}>findings ↓</span>}
      </span>
    </>
  );
  const style: CSSProperties = {
    ...glass,
    borderRadius: corner.md,
    padding: spacing.md,
    display: "grid",
    gap: 8,
    textAlign: "left",
    color: typography.color.primary,
    font: `inherit`,
    ...(marked
      ? { border: `1px solid ${glucose.accent}66`, boxShadow: `0 0 24px -12px ${glucose.accent}` }
      : {}),
  };
  return marked ? (
    <button
      type="button"
      onClick={onJump}
      aria-label={`${window.name}: see findings`}
      style={{ ...style, cursor: "pointer" }}
    >
      {body}
    </button>
  ) : (
    <div style={style}>{body}</div>
  );
}

function FindingCard({
  finding,
  report,
  index,
}: {
  finding: HealthFinding;
  report: HealthReport;
  index: number;
}): JSX.Element {
  const accent = ruleAccent[finding.rule] ?? glucose.accent;
  return (
    <Reveal
      id={`health-finding-${String(index)}`}
      style={{ ...card, scrollMarginTop: 96, borderLeft: `3px solid ${accent}` }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Tag colour={accent}>{RULE[finding.rule]}</Tag>
        <Tag>{title(finding.window)}</Tag>
        {finding.direction !== "" && <Direction direction={finding.direction} />}
        <span style={{ marginLeft: "auto", fontSize: 12, color: typography.color.muted }}>
          {`${String(finding.hits)} of ${String(finding.events)} events`}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: typography.scale.md, lineHeight: 1.45, fontWeight: 500 }}>
        {finding.text}
      </p>
      {finding.traces.length > 0 &&
        (finding.rule === "basal" ? (
          <BasalStrip finding={finding} report={report} />
        ) : (
          <TraceChart finding={finding} report={report} />
        ))}
      {finding.evidence.length > 0 && <Evidence items={finding.evidence} />}
    </Reveal>
  );
}

function SuggestionCard({
  suggestion,
  locked,
  onDecide,
}: {
  suggestion: HealthSuggestion;
  locked: boolean;
  onDecide: (id: string, action: HealthDecision) => void;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const reduced = useReducedMotion() ?? false;
  const setting = SETTING[suggestion.setting];
  const settled = suggestion.status !== "proposed";

  return (
    <Reveal
      style={{
        ...card,
        background: settled
          ? glass.background
          : `linear-gradient(160deg, rgba(139,124,246,0.16), transparent 55%), ${glass.background}`,
        border: settled ? glass.border : `1px solid ${glucose.accent}55`,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600 }}>{`${title(suggestion.window)} · ${setting.name}`}</span>
        <Direction direction={suggestion.direction} />
        <span style={{ marginLeft: "auto" }}>
          <Tag
            colour={
              suggestion.status === "applied"
                ? semantic.success
                : suggestion.status === "dismissed"
                  ? typography.color.muted
                  : glucose.accent
            }
          >
            {suggestion.status}
          </Tag>
        </span>
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          gap: 10,
          padding: `${String(spacing.sm)}px ${String(spacing.md)}px`,
          borderRadius: corner.md,
          background: "rgba(5,4,9,0.45)",
          border: `1px solid ${material.border}`,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span
          style={{
            fontSize: typography.scale.lg,
            color: typography.color.muted,
            textDecoration: settled ? "none" : "line-through",
            textDecorationColor: "rgba(255,255,255,0.3)",
          }}
        >
          {String(suggestion.current)}
        </span>
        <span aria-hidden style={{ color: glucose.accent }}>
          →
        </span>
        <span style={{ fontSize: typography.scale.xl, fontWeight: 650 }}>
          {String(suggestion.proposed)}
        </span>
        <span style={{ color: typography.color.muted, fontSize: typography.scale.sm }}>
          {setting.unit}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: typography.scale.sm,
            color: glucose.accent,
            fontWeight: 600,
          }}
        >{`${String(suggestion.step_pct)}%`}</span>
      </div>
      <p style={{ margin: 0, lineHeight: 1.5 }}>{suggestion.text}</p>
      {suggestion.evidence.length > 0 && <Evidence items={suggestion.evidence} />}

      {settled ? (
        <div style={{ display: "flex", gap: spacing.sm }}>
          <button
            type="button"
            disabled={locked}
            onClick={() => onDecide(suggestion.id, "reset")}
            style={{
              ...buttonStyle,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              opacity: locked ? 0.5 : 1,
            }}
          >
            Undo
            <Undo2 size={15} aria-hidden />
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: spacing.sm }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.sm }}>
            <button
              type="button"
              disabled={locked}
              aria-expanded={confirming}
              onClick={() => setConfirming((open) => !open)}
              style={{
                ...buttonStyle,
                background: confirming ? material.fillElevated : `${glucose.accent}33`,
                borderColor: `${glucose.accent}88`,
                opacity: locked ? 0.5 : 1,
              }}
            >
              Applied
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => onDecide(suggestion.id, "dismiss")}
              style={{ ...buttonStyle, opacity: locked ? 0.5 : 1 }}
            >
              Dismiss
            </button>
          </div>
          <AnimatePresence initial={false}>
            {confirming && (
              <motion.div
                initial={reduced ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: EASE }}
                style={{ overflow: "hidden" }}
              >
                <div
                  style={{
                    display: "grid",
                    gap: spacing.sm,
                    padding: spacing.md,
                    borderRadius: corner.md,
                    background: material.fill,
                    border: `1px dashed ${glucose.accent}88`,
                  }}
                >
                  <span style={{ fontSize: typography.scale.sm, color: typography.color.muted }}>
                    Only once you have changed the pump yourself. Noctis never changes pump
                    settings.
                  </span>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      setConfirming(false);
                      onDecide(suggestion.id, "mark-applied");
                    }}
                    style={{
                      ...buttonStyle,
                      background: glucose.accent,
                      borderColor: glucose.accent,
                      color: "#0b0a12",
                      fontWeight: 650,
                    }}
                  >
                    I already changed the pump: mark applied
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </Reveal>
  );
}

function ChangeCard({ change }: { change: HealthChange }): JSX.Element {
  const outcome = OUTCOME[change.outcome];
  const before = change.before === null ? null : tirSegments(change.before);
  const after = change.after === null ? null : tirSegments(change.after);
  const setting = SETTING[change.setting];
  return (
    <Reveal style={card}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600 }}>{`${title(change.window)} · ${setting.name}`}</span>
        <span
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 10px",
            borderRadius: 999,
            border: `1px solid ${outcome.colour}88`,
            background: `${outcome.colour}1f`,
            color: outcome.colour,
            fontSize: 12,
            fontWeight: 650,
          }}
        >
          <outcome.Icon size={14} aria-hidden />
          {outcome.label}
        </span>
        {!change.outcome_final && <Tag>provisional</Tag>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.lg }}>
        {after !== null && change.after !== null ? (
          <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
            {before !== null && change.before !== null && (
              <>
                <span style={{ opacity: 0.7 }}>
                  <RangeRing
                    segments={before}
                    centre={`${String(change.before.tir)}%`}
                    caption="before"
                    size={96}
                  />
                </span>
                <span aria-hidden style={{ color: glucose.accent, fontSize: 18 }}>
                  →
                </span>
              </>
            )}
            <RangeRing
              segments={after}
              from={before ?? undefined}
              centre={`${String(change.after.tir)}%`}
              caption="after"
              size={120}
            />
          </div>
        ) : (
          <div
            style={{
              width: 120,
              height: 120,
              display: "grid",
              placeItems: "center",
              color: typography.color.muted,
              fontSize: 12,
              textAlign: "center",
            }}
          >
            After data still coming in
          </div>
        )}
        <div style={{ display: "grid", gap: 6, flex: "1 1 160px", fontSize: typography.scale.sm }}>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            <span style={{ color: typography.color.muted }}>Setting </span>
            {`${String(change.current)} → ${String(change.proposed)} ${setting.unit}`}
          </span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            <span style={{ color: typography.color.muted }}>In range </span>
            {`${change.before?.tir == null ? "–" : String(change.before.tir)}% → ${change.after?.tir == null ? "–" : String(change.after.tir)}%`}
          </span>
          <span
            style={{ color: typography.color.muted }}
          >{`Applied ${formatLocal(change.applied_at)}`}</span>
        </div>
      </div>
    </Reveal>
  );
}

function HourlyTable({ report }: { report: HealthReport }): JSX.Element {
  const cell: CSSProperties = {
    padding: "4px 8px",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  };
  return (
    <div style={{ overflowX: "auto", paddingBottom: spacing.sm }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead style={{ color: typography.color.muted }}>
          <tr>
            {["Hour", "5%", "25%", "Median", "75%", "95%"].map((heading) => (
              <th key={heading} style={{ ...cell, fontWeight: 600 }}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.agp.map((row) => (
            <tr key={row.hour} style={{ borderTop: `1px solid ${material.border}` }}>
              <td
                style={{ ...cell, fontFamily: typography.monoFamily }}
              >{`${String(row.hour).padStart(2, "0")}:00`}</td>
              {[row.p5, row.p25, row.p50, row.p75, row.p95].map((value, i) => (
                <td key={i} style={{ ...cell, ...(i === 2 ? { fontWeight: 650 } : {}) }}>
                  {value === null ? "–" : String(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Evidence({ items }: { items: readonly string[] }): JSX.Element {
  return (
    <details>
      <summary
        style={{
          cursor: "pointer",
          color: typography.color.muted,
          fontSize: typography.scale.sm,
          minHeight: 32,
          display: "flex",
          alignItems: "center",
        }}
      >
        {`Evidence (${String(items.length)})`}
      </summary>
      <ul
        style={{
          margin: `${String(spacing.xs)}px 0 0`,
          paddingLeft: spacing.lg,
          display: "grid",
          gap: 4,
          fontSize: typography.scale.sm,
          fontFamily: typography.monoFamily,
          color: typography.color.muted,
        }}
      >
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </details>
  );
}

function Direction({ direction }: { direction: "stronger" | "weaker" }): JSX.Element {
  const stronger = direction === "stronger";
  const Icon = stronger ? ArrowUp : ArrowDown;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 12,
        color: typography.color.muted,
      }}
    >
      <Icon size={14} aria-hidden />
      {stronger ? "more insulin" : "less insulin"}
    </span>
  );
}

function Tag({ children, colour }: { children: ReactNode; colour?: string }): JSX.Element {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 9px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 650,
        letterSpacing: "0.04em",
        color: colour ?? typography.color.muted,
        border: `1px solid ${colour === undefined ? material.border : `${colour}77`}`,
        background: colour === undefined ? material.fill : `${colour}1a`,
      }}
    >
      {children}
    </span>
  );
}

function Line({
  icon,
  tone,
  children,
}: {
  icon: ReactNode;
  tone?: "accent" | "warning" | "error";
  children: ReactNode;
}): JSX.Element {
  const colour =
    tone === "accent"
      ? glucose.accent
      : tone === "warning"
        ? semantic.warning
        : tone === "error"
          ? semantic.error
          : typography.color.muted;
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      style={{
        margin: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        color: colour,
        fontSize: typography.scale.sm,
      }}
    >
      <span aria-hidden style={{ display: "inline-flex", flex: "none" }}>
        {icon}
      </span>
      <span>{children}</span>
    </p>
  );
}

function Empty({ icon, children }: { icon?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        ...card,
        placeItems: "center",
        textAlign: "center",
        padding: spacing.xxxl,
        color: typography.color.muted,
        lineHeight: 1.55,
      }}
    >
      {icon !== undefined && <span style={{ color: glucose.accent }}>{icon}</span>}
      <div style={{ maxWidth: 440 }}>{children}</div>
    </div>
  );
}

/** A card that rises into place the first time it scrolls into view. */
function Reveal({
  children,
  style,
  id,
}: {
  children: ReactNode;
  style: CSSProperties;
  id?: string;
}): JSX.Element {
  const reduced = useReducedMotion() ?? false;
  return (
    <motion.div
      id={id}
      style={style as MotionStyle}
      initial={reduced ? false : { opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.55, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

function Pulse(): JSX.Element {
  const reduced = useReducedMotion() ?? false;
  return (
    <motion.span
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        background: glucose.accent,
        boxShadow: `0 0 10px ${glucose.accent}`,
      }}
      animate={reduced ? {} : { opacity: [1, 0.35, 1], scale: [1, 0.8, 1] }}
      transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}

function Spin({ active, children }: { active: boolean; children: ReactNode }): JSX.Element {
  const reduced = useReducedMotion() ?? false;
  return (
    <motion.span
      style={{ display: "inline-flex" }}
      animate={active && !reduced ? { rotate: 360 } : { rotate: 0 }}
      transition={active ? { duration: 1.2, repeat: Infinity, ease: "linear" } : { duration: 0.2 }}
    >
      {children}
    </motion.span>
  );
}
