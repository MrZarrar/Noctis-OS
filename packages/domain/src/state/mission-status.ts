import type { MissionStatus } from "@noctis/contracts";

import { defineTransition } from "./transition.js";

export const transitionMissionStatus = defineTransition<MissionStatus>("mission", {
  draft: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "blocked", "cancelled"],
  blocked: ["running", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
});
