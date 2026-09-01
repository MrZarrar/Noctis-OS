import type { ObjectiveStatus } from "@noctis/contracts";

import { defineTransition } from "./transition.js";

export const transitionObjectiveStatus = defineTransition<ObjectiveStatus>("objective", {
  suggested: ["draft", "abandoned"],
  draft: ["active", "abandoned"],
  active: ["paused", "completed", "abandoned"],
  paused: ["active", "completed", "abandoned"],
  completed: [],
  abandoned: [],
});
