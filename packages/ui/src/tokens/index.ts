export { depth } from "./depth.js";
export { material } from "./material.js";
export { identityAccent } from "./identity.js";
export { semantic } from "./semantic.js";
export { typography } from "./type.js";
export { spacing, corner, elevation, occlusion } from "./spacing.js";
export { motion } from "./motion.js";

import { corner, elevation, occlusion, spacing } from "./spacing.js";
import { depth } from "./depth.js";
import { identityAccent } from "./identity.js";
import { material } from "./material.js";
import { motion } from "./motion.js";
import { semantic } from "./semantic.js";
import { typography } from "./type.js";

/** The complete Section 5.2 token set, for anything that wants all of it at once. */
export const TOKENS = {
  depth,
  material,
  identityAccent,
  semantic,
  typography,
  spacing,
  corner,
  elevation,
  occlusion,
  motion,
} as const;
