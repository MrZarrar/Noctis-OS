import type { IntelligenceState } from "@noctis/ui";
import type { Turn } from "./useConversation.js";

export function intelligenceState(
  activity: {
    turns: readonly Pick<Turn, "status" | "items">[];
    streaming: ReadonlyMap<string, string>;
    pendingApprovals: readonly unknown[];
  },
  listening: boolean,
  /** The agent loads a model before it can answer, and nobody has woken it. */
  asleep = false,
): IntelligenceState {
  if (activity.pendingApprovals.length > 0) return "waiting_for_approval";
  const active = activity.turns.filter(
    (turn) => turn.status === "queued" || turn.status === "running",
  );
  if (active.length > 0) {
    const text =
      [...activity.streaming.values()].some((value) => value.trim() !== "") ||
      active.some((turn) =>
        turn.items.some(
          (item) =>
            item.kind === "agent_message" &&
            item.status === "in_progress" &&
            item.text.trim() !== "",
        ),
      );
    return text ? "speaking" : "thinking";
  }
  return listening ? "listening" : asleep ? "asleep" : "idle";
}
