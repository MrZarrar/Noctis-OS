import type { Trigger, Reminder } from "@noctis/contracts";
export const OWNER_ZONE = "Europe/London";
export function reminderDueAt(reminder: Reminder): string | undefined {
  return reminder.nextDueAt ?? (reminder.trigger?.kind === "at" ? reminder.trigger.at : undefined);
}
export function compareReminders(a: Reminder, b: Reminder): number {
  const group = Number(a.status === "done") - Number(b.status === "done");
  if (group) return group;
  const aDue = reminderDueAt(a),
    bDue = reminderDueAt(b);
  if (!aDue) return bDue ? 1 : 0;
  if (!bDue) return -1;
  return Date.parse(aDue) - Date.parse(bDue);
}
export function reminderDueLabel(reminder: Reminder, now = Date.now()): string {
  if (reminder.status === "done" || reminder.status === "snoozed") return reminder.status;
  const due = reminderDueAt(reminder);
  if (due) {
    const remaining = Date.parse(due) - now;
    if (remaining < 0) return "Overdue";
    if (reminder.status === "due" || remaining === 0) return "Due now";
    if (remaining <= 3600000) return "Due soon";
    return "Upcoming";
  }
  if (reminder.status === "due") return "Due now";
  if (reminder.trigger?.kind === "at_pc") return "At your PC";
  return reminder.trigger ? "Scheduled" : "To do";
}
export function localToInstant(value: string): string {
  const naive = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(naive)) throw new Error("Choose a valid date and time.");
  const parts = (instant: number) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: OWNER_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(new Date(instant))
      .replace(" ", "T");
  for (const offset of [0, 3600000]) {
    const candidate = naive - offset;
    if (parts(candidate) === value) return new Date(candidate).toISOString();
  }
  throw new Error("That time does not exist when the clocks change. Choose another time.");
}
export function ownerDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: OWNER_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
export function triggerLabel(trigger: Trigger): string {
  if (trigger === null) return "No date";
  if (trigger.kind === "at") return ownerDate(trigger.at);
  if (trigger.kind === "at_pc")
    return `${trigger.repeat ? "Every time" : "Next time"} your session is unlocked on ${trigger.nodeId}`;
  if (trigger.rule.kind === "interval") return `Every ${trigger.rule.hours} hours`;
  return `${trigger.rule.daysOfWeek.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ")} at ${trigger.rule.timeOfDay} (${trigger.rule.timeZone})`;
}
export function searchNotes<T extends { title: string; body: string }>(
  notes: readonly T[],
  query: string,
): T[] {
  const q = query.toLocaleLowerCase().trim();
  return notes.filter((n) => `${n.title}\n${n.body}`.toLocaleLowerCase().includes(q));
}
export function snoozeUntil(choice: "hour" | "evening" | "tomorrow", now = new Date()): string {
  if (choice === "hour") return new Date(now.getTime() + 3600000).toISOString();
  const date = new Intl.DateTimeFormat("sv-SE", {
    timeZone: OWNER_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const evening = localToInstant(`${date}T18:00`);
  if (choice === "evening" && Date.parse(evening) > now.getTime()) return evening;
  const tomorrow = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return localToInstant(`${tomorrow}T${choice === "evening" ? "18" : "09"}:00`);
}
