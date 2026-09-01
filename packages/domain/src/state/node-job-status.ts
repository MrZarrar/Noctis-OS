import type { NodeJobStatus } from "@noctis/contracts";

import { defineTransition } from "./transition.js";

/** Defined by Phase 1; expired returns a job to queued so a lost lease is retryable. */
export const transitionNodeJobStatus = defineTransition<NodeJobStatus>("node_job", {
  queued: ["leased", "cancelled"],
  leased: ["running", "expired", "cancelled"],
  running: ["succeeded", "failed", "expired", "cancelled"],
  expired: ["queued", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
});
