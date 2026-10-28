import type { SurfaceLifecycle } from "@noctis/contracts";

import { defineTransition } from "./transition.js";

export const transitionSurfaceLifecycle = defineTransition<SurfaceLifecycle>("surface", {
  proposed: ["entering", "dismissed"],
  entering: ["active", "dismissed"],
  active: ["background", "exiting"],
  background: ["active", "exiting"],
  exiting: ["dismissed"],
  dismissed: ["proposed"],
});
