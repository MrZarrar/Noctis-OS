import type { NodeJobStatus } from "@noctis/contracts";

import { defineTransition } from "./transition.js";

/**
 * Defined by Phase 1; expired returns a job to queued so a lost lease is retryable.
 *
 * `leased -> succeeded` and `leased -> failed` were added in Phase 3 (ADR-0011).
 * `running` is a state only the node can observe, and a single round-trip adapter
 * reports no start, so requiring `running` first would make the core write a
 * transition it never witnessed. `running` remains for jobs that do stream a start.
 */
export const transitionNodeJobStatus = defineTransition<NodeJobStatus>("node_job", {
  queued: ["leased", "cancelled"],
  leased: ["running", "succeeded", "failed", "expired", "cancelled"],
  running: ["succeeded", "failed", "expired", "cancelled"],
  expired: ["queued", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
});
