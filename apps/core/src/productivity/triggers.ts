import type { Trigger } from "@noctis/contracts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function localParts(at: number, timeZone: string): Record<string, number> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function localAsUtc(at: number, timeZone: string): number {
  const p = localParts(at, timeZone);
  return Date.UTC(p.year!, p.month! - 1, p.day, p.hour, p.minute, p.second);
}

function occurrence(date: Date, timeOfDay: string, timeZone: string): number | undefined {
  const [hour, minute] = timeOfDay.split(":").map(Number);
  const wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
  const offsets = new Set(
    [-36 * HOUR, 0, 36 * HOUR].map((delta) => localAsUtc(wall + delta, timeZone) - (wall + delta)),
  );
  const candidates = [...offsets]
    .map((offset) => wall - offset)
    .filter((at) => localAsUtc(at, timeZone) === wall);
  // One occurrence per local day: choose the first repeated time; a nonexistent time is skipped.
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

function weeklyAt(
  rule: Extract<Extract<Trigger, { kind: "repeat" }>["rule"], { kind: "weekly" }>,
  at: number,
  forward: boolean,
): number | undefined {
  const p = localParts(at, rule.timeZone);
  const start = Date.UTC(p.year!, p.month! - 1, p.day);
  for (let day = 0; day <= 14; day++) {
    const date = new Date(start + (forward ? day : -day) * DAY);
    if (!rule.daysOfWeek.includes(date.getUTCDay())) continue;
    const candidate = occurrence(date, rule.timeOfDay, rule.timeZone);
    if (candidate !== undefined && (forward ? candidate > at : candidate <= at)) return candidate;
  }
  return undefined;
}

export function nextTriggerAt(trigger: Trigger, after: number): string | undefined {
  if (trigger === null || trigger.kind === "at_pc") return undefined;
  if (trigger.kind === "at") return new Date(trigger.at).toISOString();
  const next =
    trigger.rule.kind === "interval"
      ? after + trigger.rule.hours * HOUR
      : weeklyAt(trigger.rule, after, true);
  return next === undefined ? undefined : new Date(next).toISOString();
}

export function latestTriggerAt(trigger: Trigger, dueAt: string, now: number): string {
  if (trigger?.kind !== "repeat") return dueAt;
  const due = Date.parse(dueAt);
  const latest =
    trigger.rule.kind === "interval"
      ? due +
        Math.max(0, Math.floor((now - due) / (trigger.rule.hours * HOUR))) *
          trigger.rule.hours *
          HOUR
      : weeklyAt(trigger.rule, now, false);
  return new Date(Math.max(due, latest ?? due)).toISOString();
}

export function lastWeeklyAt(
  rule: { daysOfWeek: number[]; timeOfDay: string; timeZone: string },
  now: number,
): number | undefined {
  return weeklyAt({ kind: "weekly", ...rule }, now, false);
}
