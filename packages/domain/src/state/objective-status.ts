import type { ObjectiveStatus } from "@noctis/contracts";

const allowedTransitions: Readonly<Record<ObjectiveStatus, readonly ObjectiveStatus[]>> = {
  suggested: ["draft", "abandoned"],
  draft: ["active", "abandoned"],
  active: ["paused", "completed", "abandoned"],
  paused: ["active", "completed", "abandoned"],
  completed: [],
  abandoned: [],
};

export function transitionObjectiveStatus(
  current: ObjectiveStatus,
  next: ObjectiveStatus,
): ObjectiveStatus {
  if (!allowedTransitions[current].includes(next)) {
    throw new Error(`Invalid Objective transition: ${current} -> ${next}`);
  }

  return next;
}
