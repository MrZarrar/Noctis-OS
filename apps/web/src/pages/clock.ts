const TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });

export function clockText(date: Date): { time: string; day: string } {
  return { time: TIME.format(date), day: DAY.format(date).replace(",", "") };
}

export function greetingFor(date: Date): string {
  const hour = date.getHours();
  return hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening.";
}

export function msToNextMinute(date: Date): number {
  return 60_000 - (date.getTime() % 60_000);
}
