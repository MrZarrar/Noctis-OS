import type { NoirCaseStatus } from "@noctis/contracts";

import { defineTransition } from "./transition.js";

export const transitionNoirCaseStatus = defineTransition<NoirCaseStatus>("noir_case", {
  forming: ["investigating", "abandoned"],
  investigating: ["synthesising", "blocked", "abandoned"],
  synthesising: ["resolved", "blocked", "abandoned"],
  blocked: ["investigating", "abandoned"],
  resolved: [],
  abandoned: [],
});
