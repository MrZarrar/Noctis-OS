import type { RuntimeItem } from "@noctis/contracts";

import type { Turn } from "../conversation/useConversation.js";

export function messageTime(
  createdAt: string,
  now: number,
  timeZone?: string,
): { label: string; title: string } {
  const date = new Date(createdAt);
  const calendar = (value: Date): number => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(value);
    const part = (type: string): number =>
      Number(parts.find((entry) => entry.type === type)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day"));
  };
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const daysAgo = (calendar(new Date(now)) - calendar(date)) / 86_400_000;
  const prefix =
    daysAgo === 0
      ? ""
      : daysAgo === 1
        ? "Yesterday "
        : `${new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(date)} `;
  return {
    label: `${prefix}${clock}`,
    title: new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(date),
  };
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours > 0 ? `${String(hours)}h ` : ""}${minutes > 0 || hours > 0 ? `${String(minutes)}m ` : ""}${String(seconds % 60)}s`;
}

export function isTurnRunning(turn: Turn): boolean {
  return turn.status === "running" || turn.status === "queued";
}

export function turnDuration(turn: Turn, now: number): string | undefined {
  const end =
    turn.completedAt === undefined
      ? isTurnRunning(turn)
        ? now
        : undefined
      : Date.parse(turn.completedAt);
  return end === undefined ? undefined : formatDuration(end - Date.parse(turn.startedAt));
}

export function turnTiming(turn: Turn, now: number): string {
  const duration = turnDuration(turn, now);
  const status =
    turn.status === "running"
      ? "Working"
      : turn.status === "queued"
        ? "Waiting to start"
        : turn.status === "completed"
          ? "Finished"
          : turn.status === "failed"
            ? "Failed"
            : "Cancelled";
  if (duration === undefined) return status;
  if (isTurnRunning(turn)) return `${status} · ${duration}`;
  return `${turn.status === "completed" ? "" : `${status} · `}Worked ${duration}`;
}

function latestItems(items: readonly RuntimeItem[], providerId?: string): RuntimeItem[] {
  const latest = new Map<string, RuntimeItem>();
  for (const raw of items) {
    let item = raw;
    if (raw.kind === "sub_agent") {
      if (
        providerId === "codex" &&
        /^(spawnAgent|sendInput|resumeAgent|wait|closeAgent|sendMessage|followupTask|interruptAgent|listAgents|collab)$/.test(
          raw.label,
        )
      )
        continue;
      const legacy = /^(started|completed|interrupted|interacted) (\/root(?:\/\S+)?)$/.exec(
        raw.label,
      );
      if (legacy?.[1] === "interacted") continue;
      if (legacy !== null) {
        item = {
          ...raw,
          itemId: `legacy-agent:${legacy[2]}`,
          label: legacy[2]!,
          status:
            raw.status === "failed" || raw.status === "declined"
              ? raw.status
              : legacy[1] === "completed"
                ? "completed"
                : legacy[1] === "interrupted"
                  ? "failed"
                  : "in_progress",
        };
      }
    }
    latest.delete(item.itemId);
    latest.set(item.itemId, item);
  }
  return [...latest.values()];
}

export function itemActivity(item: RuntimeItem): string | undefined {
  const active = item.status === "in_progress";
  if (!active && item.status !== "completed") return undefined;
  switch (item.kind) {
    case "command": {
      const line = item.command.split(/\r?\n/, 1)[0]?.trim() ?? "";
      return `${active ? "running" : "ran"} ${line.length > 80 ? `${line.slice(0, 79)}…` : line}`;
    }
    case "file_change":
      return `${active ? "editing" : "edited"} ${item.paths[0]?.split(/[\\/]/).at(-1) ?? "files"}`;
    case "tool_call":
      return `${active ? "using" : "used"} ${item.tool}`;
    case "sub_agent":
      return `${item.label}: ${active ? (item.activity ?? "working") : "completed"}`;
    default:
      return undefined;
  }
}

export function turnActivity(
  items: readonly RuntimeItem[],
  providerId?: string,
): string | undefined {
  const newest = latestItems(items, providerId).reverse();
  const own = newest.filter((item) => item.parentItemId === undefined && item.kind !== "sub_agent");
  const active = own.find(
    (item) => item.status === "in_progress" && itemActivity(item) !== undefined,
  );
  if (active !== undefined) return itemActivity(active);
  const busy = new Set(
    newest.flatMap((item) =>
      item.status !== "in_progress" || item.kind === "agent_message"
        ? []
        : item.parentItemId !== undefined
          ? [item.parentItemId]
          : item.kind === "sub_agent"
            ? [item.itemId]
            : [],
    ),
  );
  if (busy.size > 0)
    return `${String(busy.size)} ${busy.size === 1 ? "sub-agent" : "sub-agents"} working`;
  const completed = own.find(
    (item) => item.status === "completed" && itemActivity(item) !== undefined,
  );
  return completed === undefined ? undefined : itemActivity(completed);
}

function orderedTurns(turns: readonly Turn[]): Turn[] {
  return [...turns].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

export function newestTurn(turns: readonly Turn[]): Turn | undefined {
  return orderedTurns(turns).at(-1);
}

export function agentsOf(
  turns: readonly Turn[],
): Array<Extract<RuntimeItem, { kind: "sub_agent" }>> {
  return latestItems(
    orderedTurns(turns).flatMap((turn) => latestItems(turn.items, turn.model.providerId)),
  )
    .filter(
      (item): item is Extract<RuntimeItem, { kind: "sub_agent" }> => item.kind === "sub_agent",
    )
    .reverse()
    .sort((a, b) => Number(b.status === "in_progress") - Number(a.status === "in_progress"));
}

export function agentStepsOf(turns: readonly Turn[], agentId: string): RuntimeItem[] {
  return latestItems(
    orderedTurns(turns)
      .flatMap((turn) => turn.items)
      .filter((item) => item.parentItemId === agentId),
  );
}
