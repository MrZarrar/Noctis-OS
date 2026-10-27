import type { Logger } from "../logging.js";
import { msUntilNext } from "./digest.js";

/**
 * Something that runs once a day at a time the owner sets on the Settings page.
 * `at` is read each time the timer schedules, so a changed setting takes effect
 * on `restart()`, which clears the pending run first: two schedules would send
 * the same digest twice.
 */
export interface DailyTimer {
  start(): void;
  restart(): void;
  stop(): void;
}

export function createDailyTimer(options: {
  clock: { now(): number };
  /** `HH:MM`, or empty for off. */
  at: () => string;
  run: () => void;
  logger?: Logger;
}): DailyTimer {
  let pending: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    if (pending !== undefined) {
      clearTimeout(pending);
      pending = undefined;
    }
  };

  const schedule = (): void => {
    stop();
    const wait = msUntilNext(new Date(options.clock.now()), options.at());

    if (wait === undefined) {
      return;
    }

    pending = setTimeout(() => {
      pending = undefined;
      try {
        options.run();
      } catch (error) {
        options.logger?.log("warn", "daily job failed", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      } finally {
        schedule();
      }
    }, wait);
    pending.unref?.();
  };

  return { start: schedule, restart: schedule, stop };
}
