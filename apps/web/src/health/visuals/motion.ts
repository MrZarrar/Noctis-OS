import { animate, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

export const EASE = [0.2, 0, 0, 1] as const;

/**
 * 0 to 1 once `run` turns true, for geometry that cannot be tweened as a CSS
 * property (an arc's end angle). With reduced motion it is 1 from the start.
 */
export function useProgress(run: boolean, duration = 1, delay = 0): number {
  const reduced = useReducedMotion() ?? false;
  const [progress, setProgress] = useState(reduced ? 1 : 0);

  useEffect(() => {
    if (!run) return;
    if (reduced) {
      setProgress(1);
      return;
    }
    const controls = animate(0, 1, { duration, delay, ease: EASE, onUpdate: setProgress });
    return () => controls.stop();
  }, [run, reduced, duration, delay]);

  return progress;
}

/** Props for a path that draws itself in, or simply appears under reduced motion. */
export function drawIn(reduced: boolean, run: boolean, duration = 1.4, delay = 0) {
  return reduced
    ? { initial: false as const }
    : {
        initial: { pathLength: 0, opacity: 0 },
        animate: run ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 },
        transition: {
          pathLength: { duration, delay, ease: EASE },
          opacity: { duration: 0.2, delay },
        },
      };
}
